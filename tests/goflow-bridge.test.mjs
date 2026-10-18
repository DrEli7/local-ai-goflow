import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGoflowBridge } from '../src/goflow-bridge.mjs';

const envelope = value => ({ code: 0, stdout: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(value) }] }), stderr: '' });
const quota = ({ fresh = true, percent = 10 } = {}) => ({
  channel: 'opencode-go', fresh, stale: !fresh, category: 'ok', fetchedAt: new Date().toISOString(),
  auth: { bindingId: 'private-binding', credentialHash: 'private-hash' },
  quota: { reliable: true, available: true, useBalance: null, dollars: 60,
    windows: ['rolling', 'weekly', 'monthly'].map(id => ({ id, percent, status: 'ok',
      resetAt: new Date(Date.now() + 3600_000).toISOString(), rawPrivate: 'private-window' })) }
});
const status = (overrides = {}) => ({
  channel: 'opencode-go', version: '1.2.0', runtimeRevision: 'widget-evidence-r1', mode: 'auto',
  providerAllowlist: ['opencode-go'], inferenceAllowed: true,
  billingGuard: { useBalanceDisabledConfirmed: true, activeGoSubscriptionConfirmed: true, confirmationSource: 'private-person' },
  quota: quota(), runtimeConfigPath: 'C:/private/config.json', stateDir: 'C:/private/state',
  metrics: { cost: 987, tokens: 54321 }, env: { API_KEY: 'private-env' }, ...overrides
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-goflow-bridge-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return await fs.realpath(directory);
}

test('inspection fixes executable, client, cwd, stdin, limits and shell policy', async t => {
  const directory = await fixture(t), calls = [];
  const bridge = createGoflowBridge({ runner: async (...args) => { calls.push(args); return envelope(status()); } });
  const result = await bridge.inspectGoflow(directory);
  assert.equal(result.ok, true);
  assert.equal(result.cloudInference, false);
  assert.equal(result.cachedEligibilityIsGrant, false);
  assert.equal(result.blockingCategory, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], [path.join(os.homedir(), '.codex', 'goflow', 'scripts', 'client.mjs'), 'goflow_status']);
  assert.deepEqual(calls[0][2], { cwd: directory, shell: false, windowsHide: true,
    timeoutMs: 30_000, maxOutputBytes: 1_048_576, input: '{}\n' });
});

test('refresh requests only guarded read-only usage and strips private fields', async t => {
  const directory = await fixture(t), calls = [];
  const bridge = createGoflowBridge({ runner: async (command, args, options) => {
    calls.push({ tool: args[1], args: JSON.parse(options.input) });
    return envelope(args[1] === 'goflow_status' ? status() : quota());
  } });
  const result = await bridge.inspectGoflow(directory, { refreshUsage: true });
  assert.deepEqual(calls, [{ tool: 'goflow_status', args: {} }, { tool: 'goflow_usage', args: { force: true } }]);
  assert.equal(result.usage.fresh, true);
  assert.equal(result.usage.windows.length, 3);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['private-', 'cost', 'tokens', 'stateDir', 'runtimeConfigPath', 'auth', 'env', 'dollars']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('stale cached percentages are withheld and never become an execution grant', async t => {
  const directory = await fixture(t);
  const bridge = createGoflowBridge({ runner: async () => envelope(status({ quota: quota({ fresh: false, percent: 90 }) })) });
  const result = await bridge.inspectGoflow(directory);
  assert.equal(result.usage.fresh, false);
  assert.deepEqual(result.usage.windows, []);
  assert.equal(result.blockingCategory, 'quota_unknown');
  assert.equal(result.cachedEligibilityIsGrant, false);
});

test('expired timestamps or malformed windows cannot expose cached percentages', async t => {
  const directory = await fixture(t);
  for (const mutate of [
    value => { value.fetchedAt = new Date(Date.now() - 61_000).toISOString(); },
    value => { value.quota.windows[0].resetAt = new Date(Date.now() - 1000).toISOString(); },
    value => { value.quota.windows[0].percent = '90'; },
    value => { value.quota.windows.push(value.quota.windows[0]); }
  ]) {
    const value = quota(); mutate(value);
    const result = await createGoflowBridge({ runner: async () => envelope(status({ quota: value })) }).inspectGoflow(directory);
    assert.deepEqual(result.usage.windows, []);
    assert.equal(result.blockingCategory, 'quota_unknown');
  }
});

test('existing GoFlow 95 and 100 percent holds remain visible', async t => {
  const directory = await fixture(t);
  for (const [percent, expected] of [[95, 'quota_95'], [100, 'quota_100']]) {
    const bridge = createGoflowBridge({ runner: async () => envelope(status({ quota: quota({ percent }), inferenceAllowed: false })) });
    const result = await bridge.inspectGoflow(directory);
    assert.equal(result.blockingCategory, expected);
    assert.equal(result.cloudInference, false);
  }
});

test('plan invokes status and original route only and returns no full summary', async t => {
  const directory = await fixture(t), tools = [];
  const summary = 'Normalize whitespace in a string utility';
  const bridge = createGoflowBridge({ runner: async (command, args, options) => {
    tools.push(args[1]);
    if (args[1] === 'goflow_status') return envelope(status());
    assert.deepEqual(JSON.parse(options.input), { task: summary, risk: 'low', complexity: 'simple' });
    return envelope({ executor: 'go', risk: 'low', complexity: 'simple',
      reason: '需求明确、风险低的普通编码任务默认委派OpenCode Go' });
  } });
  const result = await bridge.planGoflow({ projectDirectory: directory, summary, risk: 'low', complexity: 'simple' });
  assert.deepEqual(tools, ['goflow_status', 'goflow_route']);
  assert.equal(result.route.executor, 'go');
  assert.equal(result.cloudInference, false);
  assert.equal(result.nextAction, 'GPT should use existing GoFlow tools only for authorized bounded code tasks');
  assert.equal(JSON.stringify(result).includes(summary), false);
  assert.ok(result.flowHint.includes('goflow_submit'));
});

test('high-risk route and disabled global mode stay with the existing GPT route', async t => {
  const directory = await fixture(t);
  const bridge = createGoflowBridge({ runner: async (command, args) => envelope(args[1] === 'goflow_status'
    ? status({ mode: 'off', inferenceAllowed: false })
    : { executor: 'gpt', risk: 'high', complexity: 'high', reason: '高风险任务保留给当前GPT主智能体，强制Go不能绕过风险门' }) });
  const result = await bridge.planGoflow({ projectDirectory: directory, summary: 'Review architecture', risk: 'high', complexity: 'high' });
  assert.equal(result.route.executor, 'gpt');
  assert.equal(result.blockingCategory, 'mode_disabled');
  assert.equal(result.cloudInference, false);
});

test('credential markers, long summary and invalid classification make zero subprocess calls', async t => {
  const directory = await fixture(t);
  let calls = 0;
  const bridge = createGoflowBridge({ runner: async () => { calls++; return envelope(status()); } });
  for (const summary of ['Bearer abcdef', 'api_key = hidden', 'sk-exampleValue', 'x'.repeat(201), 'line\nbreak']) {
    const result = await bridge.planGoflow({ projectDirectory: directory, summary, risk: 'low', complexity: 'simple' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'INVALID_SUMMARY');
    assert.equal(JSON.stringify(result).includes(summary), false);
  }
  const invalid = await bridge.planGoflow({ projectDirectory: directory, summary: 'ordinary task', risk: 'medium', complexity: 'simple' });
  assert.equal(invalid.error.code, 'INVALID_ROUTE');
  assert.equal(calls, 0);
});

test('non-object public arguments and invalid refresh fail closed before dispatch', async t => {
  const directory = await fixture(t);
  let calls = 0;
  const bridge = createGoflowBridge({ runner: async () => { calls++; return envelope(status()); } });
  for (const value of [null, 'text', [], 42]) {
    assert.equal((await bridge.inspectGoflow(directory, value)).error.code, 'INVALID_ROUTE');
    assert.equal((await bridge.planGoflow(value)).error.code, 'INVALID_ROUTE');
  }
  assert.equal((await bridge.inspectGoflow(directory, { refreshUsage: 'yes' })).error.code, 'INVALID_ROUTE');
  assert.equal(calls, 0);
});

test('invalid, missing, file and redirected project directories fail before the client', async t => {
  const directory = await fixture(t), file = path.join(directory, 'ordinary.txt');
  await fs.writeFile(file, 'data');
  let calls = 0;
  const bridge = createGoflowBridge({ runner: async () => { calls++; return envelope(status()); } });
  for (const target of ['relative/project', path.join(directory, 'missing'), file]) {
    assert.equal((await bridge.inspectGoflow(target)).error.code, 'INVALID_PROJECT');
  }
  const link = path.join(directory, 'redirect');
  await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await bridge.inspectGoflow(link)).error.code, 'INVALID_PROJECT');
  assert.equal(calls, 0);
});

test('disabled and approval errors fail closed without exposing raw logs or dispatching route', async t => {
  const directory = await fixture(t);
  for (const [prefix, expected] of [['PLUGIN_DISABLED', 'CLIENT_DISABLED'], ['TOOL_DISABLED', 'CLIENT_DISABLED'],
    ['SERVICE_DISABLED', 'CLIENT_DISABLED'], ['APPROVAL_REQUIRED', 'APPROVAL_REQUIRED'], ['SERVICE_MISSING', 'CLIENT_MISSING']]) {
    let calls = 0;
    const bridge = createGoflowBridge({ runner: async () => { calls++; return {
      code: 4, stdout: '', stderr: `${prefix}: private-value Bearer hidden\n` }; } });
    const result = await bridge.planGoflow({ projectDirectory: directory, summary: 'ordinary task', risk: 'low', complexity: 'simple' });
    assert.equal(result.error.code, expected);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes('private-value'), false);
    assert.equal(JSON.stringify(result).includes('hidden'), false);
  }
});

test('malformed responses, timeout and bounded-output violations expose safe codes only', async t => {
  const directory = await fixture(t);
  for (const [response, expected] of [
    [{ code: 0, stdout: 'not json private-log' }, 'INVALID_RESPONSE'],
    [envelope([]), 'INVALID_RESPONSE'],
    [envelope(status({ providerAllowlist: ['other-provider'] })), 'INVALID_RESPONSE'],
    [{ code: 0, stdout: JSON.stringify({ isError: true, content: [] }) }, 'INVALID_RESPONSE'],
    [{ timedOut: true }, 'CLIENT_TIMEOUT'],
    [{ outputLimit: true }, 'OUTPUT_LIMIT'],
    [{ startFailed: true }, 'CLIENT_MISSING'],
    [{ code: 0, stdout: 'x'.repeat(1_048_577) }, 'OUTPUT_LIMIT']
  ]) {
    const result = await createGoflowBridge({ runner: async () => response }).inspectGoflow(directory);
    assert.equal(result.error.code, expected);
    assert.equal(result.cloudInference, false);
    assert.equal(JSON.stringify(result).includes('private-log'), false);
  }
});

test('injected runner exceptions and unrecognized route reason cannot leak content', async t => {
  const directory = await fixture(t);
  const failed = await createGoflowBridge({ runner: async () => { throw new Error('Bearer private-runtime-secret'); } }).inspectGoflow(directory);
  assert.equal(failed.error.code, 'CLIENT_ERROR');
  assert.equal(JSON.stringify(failed).includes('private-runtime-secret'), false);
  const bridge = createGoflowBridge({ runner: async (command, args) => envelope(args[1] === 'goflow_status'
    ? status() : { executor: 'go', risk: 'low', complexity: 'simple', reason: 'Bearer private-route-secret C:/private/path' }) });
  const result = await bridge.planGoflow({ projectDirectory: directory, summary: 'ordinary task', risk: 'low', complexity: 'simple' });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('private-route-secret'), false);
  assert.equal(JSON.stringify(result).includes('C:/private'), false);
});
