/** Read-only handoff to the existing guarded GoFlow client. Never launches inference. */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { handoffMetadata } from './handoff-metadata.mjs';

const NODE_EXE = process.execPath;
const CLIENT_FILE = path.join(os.homedir(), '.codex', 'goflow', 'scripts', 'client.mjs');
const ALLOWED_TOOLS = new Set(['goflow_status', 'goflow_usage', 'goflow_route']);
const MAX_OUTPUT_BYTES = 1_048_576;
const TIMEOUT_MS = 30_000;
const MODES = new Set(['auto', 'go', 'gpt', 'off']);
const CATEGORIES = new Set(['ok', 'authorization', 'quota', 'service', 'network', 'schema']);
const WINDOWS = ['rolling', 'weekly', 'monthly'];
const SECRET_MARKER = /(?:\b(?:sk-[A-Za-z0-9_-]+|(?:ghp|gho|github_pat)_[A-Za-z0-9_]+)|\bBearer\b|\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\b|-----BEGIN\s+(?:(?:RSA|EC|OPENSSH)\s+)?PRIVATE KEY-----)/i;
const NEXT_ACTION = 'GPT should use existing GoFlow tools only for authorized bounded code tasks';
const FLOW_HINT = Object.freeze(['goflow_status', 'goflow_usage', 'goflow_route',
  'goflow_submit', 'goflow_task', 'GPT review', 'goflow_accept; use goflow_resume for the same queued task ID']);
const SAFE_REASONS = new Set([
  '需求明确、风险低的普通编码任务默认委派OpenCode Go',
  '高风险任务保留给当前GPT主智能体，强制Go不能绕过风险门',
  '复杂算法或架构任务保留给当前GPT主智能体',
  '自动委派已关闭', '强制GPT模式'
]);
const ERROR_CATEGORIES = Object.freeze({
  INVALID_PROJECT: 'invalid_project', INVALID_SUMMARY: 'invalid_summary', INVALID_ROUTE: 'invalid_route',
  CLIENT_MISSING: 'client_missing', CLIENT_DISABLED: 'client_disabled', APPROVAL_REQUIRED: 'approval_required',
  CLIENT_TIMEOUT: 'client_timeout', OUTPUT_LIMIT: 'output_limit', INVALID_RESPONSE: 'invalid_response',
  CLIENT_ERROR: 'client_error'
});

class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = code => { throw new BridgeError(code); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalizedPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;

async function verifyProject(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\x00-\x1f]/.test(directory)) refuse('INVALID_PROJECT');
  const resolved = path.resolve(directory);
  try {
    const parsed = path.parse(resolved);
    let cursor = parsed.root;
    for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('INVALID_PROJECT');
    }
    const real = await fs.realpath(resolved);
    if (normalizedPath(real) !== normalizedPath(resolved) || !(await fs.stat(real)).isDirectory()) refuse('INVALID_PROJECT');
    return real;
  } catch { refuse('INVALID_PROJECT'); }
}

function restrictedEnvironment() {
  const env = {};
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME',
    'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'CODEX_HOME']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  env.PATH = path.dirname(NODE_EXE);
  return env;
}

async function runClient(command, args, options) {
  try {
    for (const filename of [NODE_EXE, CLIENT_FILE]) {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) refuse('CLIENT_MISSING');
    }
  } catch { refuse('CLIENT_MISSING'); }
  return new Promise(resolve => {
    let child, timer, bytes = 0, finished = false;
    const stdout = [], stderr = [];
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), ...result });
    };
    const terminate = result => {
      child?.kill();
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      finish(result);
    };
    try {
      child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true,
        detached: false, env: restrictedEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { finish({ code: null, startFailed: true }); return; }
    timer = setTimeout(() => terminate({ code: null, timedOut: true }), options.timeoutMs);
    const collect = target => chunk => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > options.maxOutputBytes) { terminate({ code: null, outputLimit: true }); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', () => finish({ code: null, startFailed: true }));
    child.on('close', code => finish({ code }));
    child.stdin.on('error', () => terminate({ code: null, startFailed: true }));
    child.stdin.end(options.input);
  });
}

function clientFailure(stderr) {
  // Only recognize documented code prefixes; no raw diagnostics are returned.
  const codes = String(stderr ?? '').split(/\r?\n/).map(line => line.match(/^([A-Z_]+):/)?.[1]);
  if (codes.some(code => ['SERVICE_DISABLED', 'PLUGIN_DISABLED', 'TOOL_DISABLED'].includes(code))) return 'CLIENT_DISABLED';
  if (codes.includes('APPROVAL_REQUIRED')) return 'APPROVAL_REQUIRED';
  if (codes.some(code => ['SERVICE_MISSING', 'INSTALLATION_MISSING'].includes(code))) return 'CLIENT_MISSING';
  if (codes.includes('TIMEOUT')) return 'CLIENT_TIMEOUT';
  return 'CLIENT_ERROR';
}

function decode(result) {
  if (!isObject(result)) refuse('INVALID_RESPONSE');
  if (result.timedOut) refuse('CLIENT_TIMEOUT');
  if (result.outputLimit) refuse('OUTPUT_LIMIT');
  if (result.startFailed) refuse('CLIENT_MISSING');
  if (typeof result.stdout !== 'string' || (result.stderr !== undefined && typeof result.stderr !== 'string')) refuse('INVALID_RESPONSE');
  if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr ?? '') > MAX_OUTPUT_BYTES) refuse('OUTPUT_LIMIT');
  if (result.code !== 0) refuse(clientFailure(result.stderr));
  let envelope, value;
  try {
    envelope = JSON.parse(result.stdout);
    if (!isObject(envelope) || envelope.isError || !Array.isArray(envelope.content) || envelope.content.length !== 1
      || envelope.content[0]?.type !== 'text' || typeof envelope.content[0].text !== 'string') refuse('INVALID_RESPONSE');
    value = JSON.parse(envelope.content[0].text);
  } catch { refuse('INVALID_RESPONSE'); }
  if (!isObject(value)) refuse('INVALID_RESPONSE');
  return value;
}

function safeLabel(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)
    && !SECRET_MARKER.test(value) ? value : null;
}

function safeUsage(input) {
  if (!isObject(input)) return { fresh: false, category: 'schema', windows: [] };
  const category = CATEGORIES.has(input.category) ? input.category : 'schema';
  const quota = isObject(input.quota) ? input.quota : {};
  const fetched = typeof input.fetchedAt === 'string' ? Date.parse(input.fetchedAt) : NaN;
  const age = Date.now() - fetched;
  const rawWindows = Array.isArray(quota.windows) ? quota.windows : [];
  const windows = WINDOWS.map(id => {
    const matches = rawWindows.filter(window => isObject(window) && window.id === id);
    const window = matches.length === 1 ? matches[0] : null;
    if (!window || typeof window.percent !== 'number' || !Number.isFinite(window.percent)
      || window.percent < 0 || window.percent > 100 || !['ok', 'rate-limited'].includes(window.status)
      || typeof window.resetAt !== 'string' || !Number.isFinite(Date.parse(window.resetAt))
      || Date.parse(window.resetAt) <= Date.now()) return null;
    return { id, percent: window.percent, status: window.status, resetAt: new Date(window.resetAt).toISOString() };
  });
  const fresh = input.fresh === true && input.stale !== true && category === 'ok'
    && quota.reliable === true && quota.available === true && age >= 0 && age < 60_000
    && rawWindows.length === WINDOWS.length && windows.every(Boolean);
  return { fresh, category, windows: fresh ? windows : [] };
}

function statusView(raw) {
  if (raw.channel !== 'opencode-go' || !MODES.has(raw.mode) || typeof raw.inferenceAllowed !== 'boolean') refuse('INVALID_RESPONSE');
  if (!Array.isArray(raw.providerAllowlist) || raw.providerAllowlist.length !== 1 || raw.providerAllowlist[0] !== 'opencode-go') refuse('INVALID_RESPONSE');
  return { version: safeLabel(raw.version), runtimeRevision: safeLabel(raw.runtimeRevision), mode: raw.mode,
    inferenceAllowed: raw.inferenceAllowed,
    executionBackend: handoffMetadata(raw.executionBackend).executionBackend,
    billingReady: raw.billingGuard?.useBalanceDisabledConfirmed === true
      && raw.billingGuard?.activeGoSubscriptionConfirmed === true };
}

function blockingCategory(status, usage, rawQuota) {
  if (status.mode === 'off' || status.mode === 'gpt') return 'mode_disabled';
  if (!status.billingReady || rawQuota?.quota?.useBalance === true) return 'billing_blocked';
  if (usage.category !== 'ok') return usage.category === 'schema' ? 'quota_unknown' : usage.category;
  if (!usage.fresh) return 'quota_unknown';
  if (usage.windows.some(window => window.percent >= 100 || window.status === 'rate-limited')) return 'quota_100';
  if (usage.windows.some(window => window.percent >= 95)) return 'quota_95';
  return status.inferenceAllowed ? null : 'eligibility_unknown';
}

function failure(error) {
  const code = error instanceof BridgeError && Object.hasOwn(ERROR_CATEGORIES, error.code) ? error.code : 'CLIENT_ERROR';
  return { ok: false, cloudInference: false, cachedEligibilityIsGrant: false,
    blockingCategory: ERROR_CATEGORIES[code], error: { code } };
}

export function createGoflowBridge({ runner = runClient } = {}) {
  if (typeof runner !== 'function') throw new TypeError('runner must be a function');
  const call = async (directory, tool, args) => {
    if (!ALLOWED_TOOLS.has(tool)) refuse('CLIENT_ERROR');
    return decode(await runner(NODE_EXE, [CLIENT_FILE, tool], { cwd: directory, shell: false,
      windowsHide: true, timeoutMs: TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES,
      input: JSON.stringify(args) + '\n' }));
  };
  const inspectVerified = async (directory, refreshUsage) => {
    const rawStatus = await call(directory, 'goflow_status', {});
    const status = statusView(rawStatus);
    const quota = refreshUsage ? await call(directory, 'goflow_usage', { force: true }) : rawStatus.quota;
    if (refreshUsage && quota.channel !== 'opencode-go') refuse('INVALID_RESPONSE');
    const usage = safeUsage(quota);
    return { ok: true, cloudInference: false, cachedEligibilityIsGrant: false,
      status, usage, blockingCategory: blockingCategory(status, usage, quota) };
  };
  return Object.freeze({
    async inspectGoflow(projectDirectory, options = {}) {
      try {
        if (!isObject(options)) refuse('INVALID_ROUTE');
        const { refreshUsage = false } = options;
        if (typeof refreshUsage !== 'boolean') refuse('INVALID_ROUTE');
        return await inspectVerified(await verifyProject(projectDirectory), refreshUsage);
      } catch (error) { return failure(error); }
    },
    async planGoflow(request = {}) {
      try {
        if (!isObject(request)) refuse('INVALID_ROUTE');
        const { projectDirectory, summary, risk, complexity } = request;
        if (typeof summary !== 'string' || !summary.trim() || summary.length > 200
          || /[\x00-\x1f\x7f]/.test(summary) || SECRET_MARKER.test(summary)) refuse('INVALID_SUMMARY');
        if (!['low', 'high'].includes(risk) || !['simple', 'moderate', 'high'].includes(complexity)) refuse('INVALID_ROUTE');
        const directory = await verifyProject(projectDirectory);
        const inspection = await inspectVerified(directory, false);
        const raw = await call(directory, 'goflow_route', { task: summary.trim(), risk, complexity });
        if (!['go', 'gpt'].includes(raw.executor) || raw.risk !== risk || raw.complexity !== complexity) refuse('INVALID_RESPONSE');
        const reason = SAFE_REASONS.has(raw.reason) ? raw.reason
          : raw.executor === 'gpt' ? 'Existing GoFlow route selected the current GPT session'
            : 'Existing GoFlow route selected OpenCode Go for GPT consideration';
        const metadata = handoffMetadata(inspection.status.executionBackend, raw);
        return { ...inspection, route: { executor: raw.executor, reason, risk, complexity,
          splitRequired: metadata.splitRequired },
          blockingCategory: raw.billingBlocked === true ? 'billing_blocked' : inspection.blockingCategory,
          nextAction: metadata.nextAction, flowHint: [...FLOW_HINT] };
      } catch (error) { return { ...failure(error), nextAction: NEXT_ACTION, flowHint: [...FLOW_HINT] }; }
    }
  });
}

const bridge = createGoflowBridge();
export const inspectGoflow = bridge.inspectGoflow;
export const planGoflow = bridge.planGoflow;
