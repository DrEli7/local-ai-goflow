import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createChatServer, validateMessages } from '../src/chat-server.mjs';

async function fixture(t, transport = { status: async () => true, chat: async (messages, { onDelta }) => {
  onDelta('你好'); onDelta('，本地。'); return { content: '你好，本地。', truncated: false };
} }) {
  const server = await createChatServer({ transport, idleMs: 0, coordinator: {
    status: async () => ({ available: true, account: 'chatgpt', reason: null }), close() {},
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = { messages: [{ role: 'user', content: '你好' }] }, extra = {}) => fetch(base + '/api/chat', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Local-Chat': '1', ...extra.headers },
    body: JSON.stringify(body), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')),
  });
  return { server, base, post };
}

test('validates exact message payload and preserves text without mutation', () => {
  const input = { messages: [{ role: 'assistant', content: '旧回复' }, { role: 'user', content: ' <script>字面文字</script> ' }] };
  const copy = structuredClone(input);
  assert.deepEqual(validateMessages(input), input.messages);
  assert.deepEqual(input, copy);
  const bad = [null, [], {}, { messages: [] }, { messages: [{ role: 'system', content: 'x' }] },
    { messages: [{ role: 'user', content: ' ' }] }, { messages: [{ role: 'user', content: 'x', tool: true }] },
    { messages: [{ role: 'assistant', content: 'x' }] }, { messages: [{ role: 'user', content: 'x' }], model: 'other' },
    { messages: [{ role: 'user', content: 'x'.repeat(6001) }] },
    { messages: [{ role: 'assistant', content: 'x'.repeat(9000) }, { role: 'user', content: 'x'.repeat(4000) }] },
    { messages: Array.from({ length: 31 }, () => ({ role: 'user', content: 'x' })) }];
  for (const value of bad) assert.throws(() => validateMessages(value), { code: 'invalid_messages' });
});

test('status identifies the app without exposing paths or requiring model inference', async t => {
  let generations = 0;
  const { base } = await fixture(t, { status: async () => true, chat: () => { generations++; } });
  const response = await fetch(base + '/api/status');
  const value = await response.json();
  assert.equal(value.app, 'local-ai-goflow-chat');
  assert.equal(value.version, '0.5.0');
  assert.equal(value.model, 'qwen3:8b');
  assert.equal(value.available, true);
  assert.match(value.serverHash, /^[a-f0-9]{64}$/);
  assert.equal(generations, 0);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('cross-origin, wrong Host and missing custom POST header never reach upstream', async t => {
  let calls = 0;
  const { base, post } = await fixture(t, { status: () => { calls++; return true; }, chat: () => { calls++; } });
  assert.equal((await post(undefined, { headers: { Origin: 'https://example.test' } })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(base + '/api/status', { headers: { Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await post(undefined, { headers: { 'X-Local-Chat': '' } })).status, 403);
  assert.equal((await post(undefined, { headers: { Origin: '' } })).status, 403);
  assert.equal((await fetch(base + '/api/chat', { method: 'OPTIONS', headers: { Origin: 'https://example.test' } })).status, 403);
  assert.equal(calls, 0);
});

test('unknown paths and file traversal are not served', async t => {
  const { base } = await fixture(t);
  for (const route of ['/package.json', '/src/chat-server.mjs', '/%2e%2e/package.json', '/api/other']) {
    assert.equal((await fetch(base + route)).status, 404);
  }
});

test('initial navigation may open the app from another site without granting cross-site POST', async t => {
  const { base, post } = await fixture(t);
  const navigation = await fetch(base + '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(navigation.status, 200);
  assert.match(await navigation.text(), /id="app"/);
  assert.equal((await post(undefined, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('streams deltas and an authoritative final result', async t => {
  const { post } = await fixture(t);
  const response = await post();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /x-ndjson/);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events, [{ delta: '你好' }, { delta: '，本地。' }, { done: true, content: '你好，本地。', truncated: false }]);
});

test('oversized and invalid payloads fail before upstream', async t => {
  let calls = 0;
  const { post } = await fixture(t, { status: () => { calls++; return true; }, chat: () => { calls++; } });
  assert.equal((await post({ messages: [{ role: 'user', content: 'x'.repeat(70000) }] })).status, 413);
  assert.equal((await post({ messages: [{ role: 'system', content: 'x' }] })).status, 400);
  assert.equal(calls, 0);
});

test('unavailable model returns a fixed error without chat invocation', async t => {
  const { post } = await fixture(t, { status: async () => false, chat: () => assert.fail('must not generate') });
  const response = await post();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'local_model_unavailable' });
});

test('upstream errors do not disclose raw diagnostics', async t => {
  const { post } = await fixture(t, { status: async () => true, chat: async () => { throw new Error('PRIVATE_DIAGNOSTIC'); } });
  const response = await post();
  const text = await response.text();
  assert.ok(!text.includes('PRIVATE_DIAGNOSTIC'));
  assert.deepEqual(JSON.parse(text), { error: 'local_service_unavailable' });
});

test('one active request is allowed; client abort cancels upstream and releases busy state', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let cancelled;
  const stopped = new Promise(resolve => { cancelled = resolve; });
  let calls = 0;
  const { post } = await fixture(t, { status: async () => true, chat: async (messages, { signal, onDelta }) => {
    calls++;
    if (calls > 1) return { content: '恢复可用', truncated: false };
    onDelta('部分'); started();
    await new Promise(resolve => signal.addEventListener('abort', () => { cancelled(); resolve(); }, { once: true }));
    throw Object.assign(new Error('aborted'), { code: 'aborted' });
  } });
  const controller = new AbortController();
  const first = post(undefined, { signal: controller.signal });
  await ready;
  const response = await first;
  assert.equal((await post()).status, 409);
  controller.abort();
  await assert.rejects(response.text());
  await stopped;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await post()).status, 200);
});
