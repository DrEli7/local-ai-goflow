/** Private stdio transport to the installed Codex App Server. Never handles auth tokens. */
import { spawn } from 'node:child_process';
import { readdir, stat, realpath } from 'node:fs/promises';
import { join, isAbsolute, basename } from 'node:path';
import { EventEmitter } from 'node:events';

export const rpcError = (code) => Object.assign(new Error(code), { code });
const METHODS = new Set(['initialize', 'account/read', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']);

export async function findCodex() {
  const candidates = [];
  if (process.env.LOCAL_AI_CODEX_EXE) candidates.push(process.env.LOCAL_AI_CODEX_EXE);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const installed = await Promise.all(entries.filter(e => e.isDirectory()).map(async e => {
      const path = join(root, e.name, 'codex.exe');
      return { path, time: (await stat(path).catch(() => null))?.mtimeMs ?? 0 };
    }));
    candidates.push(...installed.filter(e => e.time).sort((a, b) => b.time - a.time).map(e => e.path));
  }
  for (const folder of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (isAbsolute(folder)) candidates.push(join(folder, process.platform === 'win32' ? 'codex.exe' : 'codex'));
  }
  for (const path of candidates) {
    if (!isAbsolute(path) || !/^codex(?:\.exe)?$/i.test(basename(path))) continue;
    try { if ((await stat(path)).isFile()) return await realpath(path); } catch { /* next installed executable */ }
  }
  throw rpcError('codex_not_installed');
}

function environment() {
  // Existing managed login is owned by Codex. Do not inherit API-key/provider overrides.
  const result = {};
  const keys = new Set(['SYSTEMROOT','WINDIR','COMSPEC','PATH','PATHEXT','TEMP','TMP','APPDATA','LOCALAPPDATA',
    'USERPROFILE','HOMEDRIVE','HOMEPATH','HOME','CODEX_HOME','LANG','LC_ALL','NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY']);
  for (const [key, value] of Object.entries(process.env)) if (keys.has(key.toUpperCase())) result[key] = value;
  return result;
}

export class CodexRpc extends EventEmitter {
  constructor({ cwd, spawnProcess = spawn, executable = findCodex } = {}) {
    super(); this.cwd = cwd; this.spawnProcess = spawnProcess; this.executable = executable;
    this.pending = new Map(); this.nextId = 0; this.child = null; this.starting = null;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this._start();
    try { await this.starting; } finally { this.starting = null; }
  }
  async _start() {
    const executable = await this.executable();
    const child = this.spawnProcess(executable, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, shell: false, windowsHide: true, env: environment(), stdio: ['pipe','pipe','pipe'],
    });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { this.close('codex_protocol_error'); return; }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { this.close('codex_protocol_error'); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close('codex_protocol_error'); return; }
        if (message.method && Object.hasOwn(message, 'id')) this.emit('request', message);
        else if (message.method) this.emit('notification', message);
        else if (this.pending.has(message.id)) {
          const entry = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(entry.timer);
          if (message.error) entry.reject(rpcError('codex_request_failed')); else entry.resolve(message.result);
        }
      }
    });
    // Never forward or persist stderr, raw tool results, authentication diagnostics or reasoning.
    child.stderr.resume();
    child.on('error', () => this._ended(child, 'codex_unavailable'));
    child.on('exit', () => this._ended(child, 'codex_disconnected'));
    try {
      await this.call('initialize', { clientInfo: { name: 'local_ai_goflow_chat', title: 'Local AI GoFlow', version: '0.5.0' },
        capabilities: { experimentalApi: false, requestAttestation: false } });
      this._write({ method: 'initialized' });
    } catch (failure) { this.close(); throw failure; }
  }
  _ended(child, code) {
    if (this.child !== child) return;
    this.child = null;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(rpcError(code)); }
    this.pending.clear(); this.emit('disconnected', code);
  }
  _write(value) {
    if (!this.child || this.child.stdin.destroyed) throw rpcError('codex_disconnected');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  call(method, params, timeoutMs = 60000) {
    if (!METHODS.has(method)) return Promise.reject(rpcError('unsupported_rpc'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(rpcError('codex_timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this._write({ id, method, ...(params === undefined ? {} : { params }) }); }
      catch (failure) { clearTimeout(timer); this.pending.delete(id); reject(failure); }
    });
  }
  respond(id, result) { this._write({ id, result }); }
  rejectRequest(id) { this._write({ id, error: { code: -32601, message: 'Unsupported client request' } }); }
  close(code = 'codex_disconnected') {
    const child = this.child;
    if (!child) return;
    this._ended(child, code); child.kill();
  }
}
