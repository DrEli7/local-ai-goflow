import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexRpc } from '../src/codex-rpc.mjs';

function fixture(t, { initialize = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.killed = false; child.kill = () => { child.killed = true; };
  const sent = [], spawns = [];
  let buffer = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', chunk => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line); sent.push(message);
      if (message.method === 'initialize' && initialize) queueMicrotask(() => reply(message.id, { userAgent: 'test-codex' }));
      child.emit('sent', message);
    }
  });
  const reply = (id, result) => child.stdout.write(JSON.stringify({ id, result }) + '\n');
  const rpc = new CodexRpc({ cwd: '/private/workspace', executable: async () => '/installed/codex',
    spawnProcess: (...args) => { spawns.push(args); return child; } });
  t.after(() => rpc.close());
  return { child, rpc, sent, spawns, reply };
}

test('stdio launch initializes once with hidden shell-free process and strips inherited API-key overrides', async t => {
  const { rpc, sent, spawns } = fixture(t);
  const syntheticKey = `LOCAL_AI_RPC_TEST_UNTRUSTED_${process.pid}_${Date.now()}`;
  process.env[syntheticKey] = 'SYNTHETIC_ENV_SECRET_DO_NOT_SEND';
  try { await Promise.all([rpc.start(), rpc.start()]); } finally {
    delete process.env[syntheticKey];
  }
  assert.equal(spawns.length, 1);
  const [executable, args, options] = spawns[0];
  assert.equal(executable, '/installed/codex');
  assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.cwd, '/private/workspace');
  assert.equal(Object.keys(options.env).some(key => key.toUpperCase() === 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(options.env, syntheticKey), false);
  assert.equal(JSON.stringify(options.env).includes('SYNTHETIC_ENV_SECRET_DO_NOT_SEND'), false);
  assert.equal(sent.filter(m => m.method === 'initialize').length, 1);
  assert.deepEqual(sent[1], { method: 'initialized' });
  assert.equal(sent[0].params.clientInfo.name, 'local_ai_goflow_chat');
  assert.equal(sent[0].params.capabilities.experimentalApi, false);
});

test('only fixed bounded chat RPC methods may be sent; login, shell, file and generic calls are blocked', async t => {
  const { rpc, sent, reply } = fixture(t); await rpc.start();
  const count = sent.length;
  for (const method of ['account/login/start', 'config/value/write', 'thread/read', 'thread/list', 'command/exec',
    'fs/readFile', 'turn/steer', '__proto__', '', null]) {
    await assert.rejects(rpc.call(method, { arbitrary: true }), { code: 'unsupported_rpc' });
  }
  assert.equal(sent.length, count);
  const pending = rpc.call('account/read', { refreshToken: false });
  const request = sent.at(-1); reply(request.id, { account: { type: 'chatgpt' } });
  assert.deepEqual(await pending, { account: { type: 'chatgpt' } });
});

test('JSON-lines transport handles fragmented UTF-8 output, interleaved notifications and server requests', async t => {
  const { rpc, child, sent, reply } = fixture(t); await rpc.start();
  const notifications = [], requests = [];
  rpc.on('notification', event => notifications.push(event)); rpc.on('request', event => requests.push(event));
  const pending = rpc.call('thread/start', { cwd: '/private/workspace' });
  const id = sent.at(-1).id;
  const encoded = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '你好' } }) + '\n');
  const multibyte = encoded.indexOf(Buffer.from('你'));
  child.stdout.write(encoded.subarray(0, multibyte + 1)); child.stdout.write(encoded.subarray(multibyte + 1));
  child.stdout.write(JSON.stringify({ id: 400, method: 'item/commandExecution/requestApproval', params: { command: 'node --test' } }) + '\n');
  reply(id, { thread: { id: 'owned_thread' } });
  assert.deepEqual(await pending, { thread: { id: 'owned_thread' } });
  assert.equal(notifications[0].params.delta, '你好'); assert.equal(requests[0].id, 400);
  rpc.respond(400, { decision: 'decline' });
  assert.deepEqual(sent.at(-1), { id: 400, result: { decision: 'decline' } });
  rpc.rejectRequest(401);
  assert.deepEqual(sent.at(-1), { id: 401, error: { code: -32601, message: 'Unsupported client request' } });
});

test('provider RPC error is replaced with a fixed diagnostic and pending work is cleared', async t => {
  const { rpc, child, sent } = fixture(t); await rpc.start();
  const pending = rpc.call('account/read', { refreshToken: false });
  child.stdout.write(JSON.stringify({ id: sent.at(-1).id, error: { code: 400, message: 'PRIVATE_RAW_TOKEN_ERROR' } }) + '\n');
  await assert.rejects(pending, error => error.code === 'codex_request_failed' && !error.message.includes('PRIVATE_RAW_TOKEN_ERROR'));
  assert.equal(rpc.pending.size, 0);
});

test('invalid protocol JSON terminates only the owned process and rejects pending operations', async t => {
  const { rpc, child } = fixture(t); await rpc.start();
  const pending = rpc.call('turn/start', { threadId: 'owned_thread', input: [] });
  const disconnected = once(rpc, 'disconnected');
  child.stdout.write('PRIVATE_INVALID_JSON\n');
  await assert.rejects(pending, { code: 'codex_protocol_error' });
  assert.deepEqual(await disconnected, ['codex_protocol_error']);
  assert.equal(child.killed, true); assert.equal(rpc.child, null); assert.equal(rpc.pending.size, 0);
});

test('an oversized unterminated protocol line is rejected before forwarding data', async t => {
  const { rpc, child } = fixture(t); await rpc.start();
  const received = []; rpc.on('notification', event => received.push(event));
  const pending = rpc.call('account/read', { refreshToken: false });
  child.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(pending, { code: 'codex_protocol_error' });
  assert.equal(received.length, 0); assert.equal(child.killed, true);
});

test('exit drains stderr without exposing it and rejects all outstanding requests with a fixed code', async t => {
  const { rpc, child } = fixture(t); await rpc.start();
  const notifications = []; rpc.on('notification', event => notifications.push(event));
  const one = rpc.call('thread/start', {}), two = rpc.call('account/read', { refreshToken: false });
  child.stderr.write('PRIVATE_STDERR_DIAGNOSTIC_AND_TOKEN');
  child.emit('exit', 1, null);
  await assert.rejects(one, error => error.code === 'codex_disconnected' && !error.message.includes('PRIVATE_'));
  await assert.rejects(two, { code: 'codex_disconnected' });
  assert.equal(notifications.length, 0); assert.equal(rpc.pending.size, 0);
  await assert.rejects(rpc.call('account/read', {}), { code: 'codex_disconnected' });
});

test('request timeout removes its ID so a late response cannot resolve future requests', async t => {
  const { rpc, sent, reply } = fixture(t); await rpc.start();
  const timeout = rpc.call('account/read', {}, 10);
  const oldId = sent.at(-1).id; await assert.rejects(timeout, { code: 'codex_timeout' });
  assert.equal(rpc.pending.size, 0); reply(oldId, { should: 'be ignored' });
  const next = rpc.call('account/read', {}), newId = sent.at(-1).id;
  assert.notEqual(newId, oldId); reply(newId, { account: null }); assert.deepEqual(await next, { account: null });
});

test('startup failure returns a fixed unavailable diagnostic and never emits raw stderr', async t => {
  const { rpc, child } = fixture(t, { initialize: false });
  const started = rpc.start();
  await new Promise(resolve => setImmediate(resolve));
  child.stderr.write('PRIVATE_STARTUP_FAILURE'); child.emit('error', new Error('PRIVATE_PROCESS_FAILURE'));
  await assert.rejects(started, error => error.code === 'codex_unavailable' && !error.message.includes('PRIVATE_'));
  assert.equal(rpc.child, null); assert.equal(rpc.pending.size, 0);
});

test('late output from a stopped child is never forwarded into another conversation', async t => {
  const { rpc, child } = fixture(t); await rpc.start();
  const received = []; rpc.on('notification', event => received.push(event));
  rpc.close();
  child.stdout.write(JSON.stringify({ method: 'item/agentMessage/delta', params: {
    threadId: 'owned_thread', turnId: 'old_turn', delta: 'PRIVATE_LATE_OLD_PROCESS_CONTENT',
  } }) + '\n');
  assert.equal(received.length, 0);
});
