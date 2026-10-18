/** Policy guard for the fixed local MCP fallback. Configuration contents never leave this module. */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

const PLUGIN_ID = 'local-ai-goflow@goflow-local';
const SERVER_NAME = 'local_ai_goflow';
const TOOLS = new Set(['local_ai_status', 'local_ai_task', 'local_ai_review', 'local_ai_metrics', 'local_ai_goflow_plan']);
const WRITES = new Set(['local_ai_task', 'local_ai_review', 'local_ai_goflow_plan']);
const MODES = new Set(['auto', 'approve', 'prompt', 'writes']);
const TRANSPORT = new Set(['command', 'args', 'env', 'env_vars', 'url', 'cwd', 'http_headers', 'env_http_headers', 'bearer_token_env_var']);
const MAX_CONFIG_BYTES = 1024 * 1024;
const own = (object, key) => Object.hasOwn(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const normalized = value => {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};

function fail(code) {
  // Fixed messages: parser errors, path names and configuration values may contain secrets.
  const error = new Error(code);
  error.code = code;
  throw error;
}

function table(parent, key) {
  if (!own(parent, key)) return undefined;
  if (!record(parent[key])) fail('CONFIG_FORMAT');
  return parent[key];
}

function booleanFlag(object) {
  if (own(object, 'enabled') && typeof object.enabled !== 'boolean') fail('CONFIG_FORMAT');
}

function validateToolPolicy(policy) {
  if (!record(policy)) fail('CONFIG_FORMAT');
  if (own(policy, 'approval_mode') && !MODES.has(policy.approval_mode)) fail('CONFIG_FORMAT');
  if (own(policy, 'output_token_limit') && (!Number.isSafeInteger(policy.output_token_limit) || policy.output_token_limit <= 0))
    fail('CONFIG_FORMAT');
}

function validateServer(server, kind, tool) {
  booleanFlag(server);
  if (server.enabled === false) fail('SERVICE_DISABLED');
  if (kind === 'project' && Object.keys(server).some(key => TRANSPORT.has(key))) fail('PROJECT_OVERRIDE_UNSUPPORTED');
  for (const key of ['enabled_tools', 'disabled_tools']) {
    if (own(server, key) && (!Array.isArray(server[key]) || server[key].some(item => typeof item !== 'string')))
      fail('CONFIG_FORMAT');
  }
  if (own(server, 'default_tools_approval_mode') && !MODES.has(server.default_tools_approval_mode)) fail('CONFIG_FORMAT');
  const policies = table(server, 'tools') ?? {};
  for (const name of TOOLS) if (own(policies, name)) validateToolPolicy(policies[name]);
  // Listing metadata has no tool execution or approval; disabled services still fail above.
  if (tool === 'list') return undefined;
  if ((server.enabled_tools && !server.enabled_tools.includes(tool)) || server.disabled_tools?.includes(tool)) fail('TOOL_DISABLED');
  const policy = policies[tool] ?? {};
  const mode = policy.approval_mode ?? server.default_tools_approval_mode ?? 'auto';
  if (mode === 'prompt' || (mode === 'writes' && WRITES.has(tool))) fail('APPROVAL_REQUIRED');
  return policy.output_token_limit;
}

/** Pure helper. Each record is { kind: 'user' | 'project', config: parsedToml }. Policies only become stricter across records. */
export function validateLocalPolicy(configObjects, tool) {
  if (tool !== 'list' && !TOOLS.has(tool)) fail('TOOL_NOT_ALLOWED');
  if (!Array.isArray(configObjects)) fail('CONFIG_FORMAT');
  let userEnabled = false;
  let outputByteLimit;
  for (const item of configObjects) {
    if (!record(item) || !['user', 'project'].includes(item.kind) || !record(item.config)) fail('CONFIG_FORMAT');
    const { config, kind } = item;
    const plugins = table(config, 'plugins') ?? {};
    const plugin = table(plugins, PLUGIN_ID);
    if (plugin) {
      booleanFlag(plugin);
      if (plugin.enabled === false) fail('PLUGIN_DISABLED');
      if (kind === 'user' && plugin.enabled === true) userEnabled = true;
    }
    const globalServers = table(config, 'mcp_servers') ?? {};
    const pluginServers = plugin ? table(plugin, 'mcp_servers') ?? {} : {};
    for (const servers of [globalServers, pluginServers]) {
      const server = table(servers, SERVER_NAME);
      if (!server) continue;
      const limit = validateServer(server, kind, tool);
      if (limit !== undefined) outputByteLimit = outputByteLimit === undefined ? limit : Math.min(outputByteLimit, limit);
    }
  }
  if (!userEnabled) fail('PLUGIN_NOT_ENABLED');
  // A UTF-8 byte ceiling is deliberately conservative; it never pretends to count model tokens.
  return outputByteLimit === undefined ? {} : { outputByteLimit };
}

async function safeDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let cursor = root;
  for (const component of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    let stat;
    try { stat = await fs.lstat(cursor); }
    catch (error) { if (error.code === 'ENOENT') return false; fail('CONFIG_UNAVAILABLE'); }
    // POSIX directory link counts include children; Windows directories cannot legitimately be hard-linked.
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.size > MAX_CONFIG_BYTES
      || (process.platform === 'win32' && stat.nlink > 1)) fail('CONFIG_PATH_UNSAFE');
  }
  return true;
}

function safeFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= MAX_CONFIG_BYTES;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readConfig(filename) {
  if (!await safeDirectoryChain(path.dirname(filename))) return undefined;
  let before;
  try { before = await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return undefined; fail('CONFIG_UNAVAILABLE'); }
  if (!safeFile(before)) fail('CONFIG_PATH_UNSAFE');
  let handle;
  let text;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!safeFile(opened) || !sameFile(before, opened)) fail('CONFIG_PATH_UNSAFE');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) fail('CONFIG_PATH_UNSAFE');
    const after = await handle.stat();
    const current = await fs.lstat(filename);
    if (!safeFile(after) || !safeFile(current) || !sameFile(opened, after) || !sameFile(opened, current)) fail('CONFIG_PATH_UNSAFE');
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch (error) {
    if (['CONFIG_PATH_UNSAFE', 'CONFIG_UNAVAILABLE'].includes(error.code)) throw error;
    fail('CONFIG_UNAVAILABLE');
  } finally { if (handle) await handle.close().catch(() => {}); }
  if (!await safeDirectoryChain(path.dirname(filename))) fail('CONFIG_PATH_UNSAFE');
  try { return parse(text); }
  catch { fail('CONFIG_FORMAT'); }
}

/** Fixed config discovery only. cwd/home injection is for tests; the CLI never accepts configuration paths. */
export async function assertLocalClientPolicy(tool, { cwd = process.cwd(), home = os.homedir() } = {}) {
  if (tool !== 'list' && !TOOLS.has(tool)) fail('TOOL_NOT_ALLOWED');
  if (typeof cwd !== 'string' || typeof home !== 'string' || !path.isAbsolute(cwd) || !path.isAbsolute(home)) fail('CONFIG_PATH_UNSAFE');
  if (process.env.CODEX_HOME && normalized(process.env.CODEX_HOME) !== normalized(path.join(home, '.codex')))
    fail('CONFIG_HOME_UNSUPPORTED');
  if (!await safeDirectoryChain(cwd) || !await safeDirectoryChain(home)) fail('CONFIG_PATH_UNSAFE');
  const userConfig = path.join(home, '.codex', 'config.toml');
  const configs = [];
  const user = await readConfig(userConfig);
  if (user !== undefined) configs.push({ kind: 'user', config: user });
  let cursor = path.resolve(cwd);
  while (true) {
    const filename = path.join(cursor, '.codex', 'config.toml');
    if (normalized(filename) !== normalized(userConfig)) {
      const config = await readConfig(filename);
      if (config !== undefined) configs.push({ kind: 'project', config });
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return validateLocalPolicy(configs, tool);
}
