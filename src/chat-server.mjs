/** Loopback-only chat UI and a bounded official Codex App Server bridge. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ChatCoordinator } from './chat-coordinator.mjs';

export const CHAT_PORT = 18441;
export const CHAT_MODEL = 'qwen3:8b';
const VERSION = '0.4.0';
const ROOT = new URL('../web/', import.meta.url);
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/chat.css', ['chat.css', 'text/css; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/chat-state.mjs', ['chat-state.mjs', 'text/javascript; charset=utf-8']],
  ['/run-state.mjs', ['run-state.mjs', 'text/javascript; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
]);
const error = (code) => Object.assign(new Error(code), { code });

export function validateMessages(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || !Array.isArray(body.messages)
    || body.messages.length < 1 || body.messages.length > 30) throw error('invalid_messages');
  let total = 0;
  const messages = body.messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).length !== 2 || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 12000) throw error('invalid_messages');
    total += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (total > 12000 || messages.at(-1).role !== 'user' || messages.at(-1).content.length > 6000) throw error('invalid_messages');
  return messages;
}

function requestOllama(path, { body, signal, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const encoded = body ? JSON.stringify(body) : null;
    const request = http.request({ hostname: '127.0.0.1', port: 11434, path,
      method: encoded ? 'POST' : 'GET', agent: false, signal,
      headers: encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {},
    }, (response) => {
      if (response.statusCode !== 200) { response.destroy(); reject(error('local_service_unavailable')); return; }
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 512 * 1024) { request.destroy(error('local_output_too_large')); return; }
        if (onChunk) {
          try { onChunk(chunk); } catch { request.destroy(error('invalid_local_response')); }
        } else chunks.push(chunk);
      });
      response.on('error', () => reject(error('local_service_unavailable')));
      response.on('end', () => resolve(chunks.join('')));
    });
    request.setTimeout(body ? 120000 : 3000, () => request.destroy(error('local_timeout')));
    request.on('error', (failure) => reject(error(signal?.aborted ? 'aborted'
      : ['local_output_too_large', 'local_timeout', 'invalid_local_response'].includes(failure.code) ? failure.code : 'local_service_unavailable')));
    if (encoded) request.end(encoded); else request.end();
  });
}

const remote = (value) => value && typeof value === 'object' && Object.entries(value).some(([key, item]) =>
  ['remote_host', 'remote_model', 'cloud'].includes(key.toLowerCase()) && Boolean(item)
  || item && typeof item === 'object' && remote(item));

export const ollamaTransport = {
  async status() {
    const data = JSON.parse(await requestOllama('/api/tags'));
    const installed = data.models?.find((model) => model.name === CHAT_MODEL || model.model === CHAT_MODEL);
    return Boolean(installed && !remote(installed));
  },
  async chat(messages, { signal, onDelta }) {
    let buffer = '', content = '', done = false, truncated = false;
    const consume = (line) => {
      if (!line.trim()) return;
      if (done) throw error('invalid_local_response');
      const event = JSON.parse(line);
      if (event.error || event.model !== CHAT_MODEL || remote(event)) throw error('invalid_local_response');
      const delta = event.message?.content ?? '';
      if (typeof delta !== 'string' || content.length + delta.length > 16000) throw error('local_output_too_large');
      content += delta;
      if (delta) onDelta(delta);
      if (event.done === true) { done = true; truncated = event.done_reason === 'length'; }
    };
    await requestOllama('/api/chat', { signal, body: { model: CHAT_MODEL, messages,
      stream: true, think: false, keep_alive: '2m', options: { num_ctx: 4096, num_predict: 2048, temperature: 0.4 } },
    onChunk(chunk) {
      buffer += chunk;
      if (buffer.length > 65536) throw error('invalid_local_response');
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1); }
    } });
    if (buffer.trim()) consume(buffer);
    if (!done || !content.trim()) throw error('invalid_local_response');
    return { content, truncated };
  },
};

async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw error('request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error('invalid_messages'); }
}

export async function createChatServer({ transport = ollamaTransport, coordinator = new ChatCoordinator(), idleMs = 600000 } = {}) {
  const serverHash = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
  let active = false, lastActivity = Date.now();
  const server = http.createServer(async (request, response) => {
    const expectedHost = `127.0.0.1:${request.socket.localPort}`;
    const origin = `http://${expectedHost}`;
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    if (request.headers.host !== expectedHost || request.headers.origin && request.headers.origin !== origin
      || request.method !== 'GET' && request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])) { send(403, { error: 'untrusted_origin' }); return; }
    if (request.method === 'GET' && request.url === '/api/status') {
      lastActivity = Date.now();
      let available = false;
      try { available = await transport.status(); } catch { /* fixed status only */ }
      const orchestrator = await coordinator.status();
      send(200, { app: 'local-ai-goflow-chat', version: VERSION, serverHash, pid: process.pid, model: CHAT_MODEL,
        localAvailable: available, available: orchestrator.available, orchestrator, mode: 'auto' }); return;
    }
    if (request.method === 'GET' && request.url === '/api/projects') {
      if (request.headers['sec-fetch-site'] && !['same-origin','none'].includes(request.headers['sec-fetch-site'])) { send(403, { error: 'untrusted_origin' }); return; }
      try { send(200, await coordinator.projects()); } catch { send(503, { error: 'coordinator_state_invalid' }); }
      return;
    }
    if (request.method === 'GET' && ASSETS.has(request.url)) {
      const [file, mime] = ASSETS.get(request.url);
      try { const data = await readFile(new URL(file, ROOT)); response.writeHead(200, { 'Content-Type': mime }); response.end(data); }
      catch { send(503, { error: 'ui_not_installed' }); }
      lastActivity = Date.now(); return;
    }
    if (request.method !== 'POST' || !['/api/chat','/api/auto-chat','/api/respond','/api/projects'].includes(request.url)) { send(404, { error: 'not_found' }); return; }
    if (request.headers.origin !== origin || request.headers['x-local-chat'] !== '1'
      || request.headers['content-type'] !== 'application/json') { send(403, { error: 'untrusted_origin' }); return; }
    if (['/api/respond','/api/projects'].includes(request.url)) {
      try {
        const body = await readBody(request);
        const value = request.url === '/api/respond' ? coordinator.respond(body) : await coordinator.registerProject(body);
        send(200, value);
      } catch (failure) {
        const allowed = ['invalid_project','project_limit','invalid_response','stale_approval','request_too_large'];
        send(failure.code === 'stale_approval' ? 409 : 400, { error: allowed.includes(failure.code) ? failure.code : 'invalid_request' });
      }
      return;
    }
    if (active) { send(409, { error: 'local_busy' }); return; }
    active = true;
    lastActivity = Date.now();
    const controller = new AbortController();
    const automatic = request.url === '/api/auto-chat';
    const timer = setTimeout(() => controller.abort(), automatic ? 30 * 60000 : 120000);
    response.on('close', () => { if (!response.writableFinished) controller.abort(); });
    const emit = (event) => { if (!response.destroyed) response.write(JSON.stringify(event) + '\n'); };
    try {
      if (Number(request.headers['content-length']) > 65536) throw error('request_too_large');
      const body = await readBody(request);
      if (automatic) {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3
          || Object.keys(body).some(key => !['sessionId','projectId','messages'].includes(key))) throw error('invalid_messages');
        const messages = validateMessages({ messages: body.messages });
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' }); response.flushHeaders();
        const result = await coordinator.chat({ sessionId: body.sessionId, projectId: body.projectId, messages }, { signal: controller.signal, emit });
        emit({ done: true, ...result }); return;
      }
      const messages = validateMessages(body);
      if (!await transport.status()) { send(503, { error: 'local_model_unavailable' }); return; }
      if (controller.signal.aborted) throw error('aborted');
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      response.flushHeaders();
      const result = await transport.chat(messages, { signal: controller.signal, onDelta: (delta) => emit({ delta }) });
      emit({ done: true, content: result.content, truncated: Boolean(result.truncated) });
    } catch (failure) {
      const known = ['invalid_messages', 'request_too_large', 'local_busy', 'aborted', 'local_output_too_large', 'invalid_local_response', 'local_timeout',
        'invalid_project','session_project_locked','session_limit','chatgpt_login_required','unsupported_codex_provider',
        'codex_not_installed','codex_unavailable','codex_disconnected','codex_protocol_error','codex_request_failed',
        'codex_timeout','codex_empty_reply','codex_turn_failed','unsupported_approval','coordinator_state_invalid'];
      const code = known.includes(failure.code) ? failure.code : automatic ? 'codex_unavailable' : 'local_service_unavailable';
      if (!response.headersSent) send(code === 'request_too_large' ? 413 : code === 'invalid_messages' ? 400 : 503, { error: code });
      else emit({ error: code });
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (!response.writableEnded) response.end();
      active = false;
      lastActivity = Date.now();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  const idleTimer = idleMs > 0 ? setInterval(() => {
    if (!active && Date.now() - lastActivity >= idleMs) { server.close(); server.closeIdleConnections(); }
  }, Math.min(30000, idleMs)) : null;
  idleTimer?.unref();
  server.on('close', () => { clearInterval(idleTimer); coordinator.close(); });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = await createChatServer();
  server.on('error', () => { process.stderr.write('Local chat could not start: the fixed port may be occupied.\n'); process.exitCode = 1; });
  server.listen(CHAT_PORT, '127.0.0.1', () => process.stdout.write(`Local chat ready at http://127.0.0.1:${CHAT_PORT}\n`));
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
}
