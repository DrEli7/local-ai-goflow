import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createChatServer } from '../src/chat-server.mjs';

async function fixture(t, overrides = {}) {
  const calls = [];
  const coordinator = {
    status: async () => ({ available: true, account: 'chatgpt', reason: null }), close() {},
    projects: async () => ({ projects: [{ id: 'default', name: 'Workspace', path: 'local-project' }], defaultProjectId: 'default' }),
    registerProject: async body => { calls.push(['project', body]); return { project: { id: 'p', name: 'Project', path: body.path } }; },
    respond: body => { calls.push(['respond', body]); return { ok: true }; },
    chat: async (body, { emit }) => {
      calls.push(['chat', body]); emit({ type: 'progress', runId: 'r', phase: 'coordinating' });
      emit({ delta: '已完成' }); return { content: '已完成', truncated: false };
    }, ...overrides,
  };
  const server = await createChatServer({ coordinator, transport: { status: async () => false }, idleMs: 0 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}, signal) => fetch(base + route, { method: 'POST', signal,
    headers: { Origin: base, 'Content-Type': 'application/json', 'X-Local-Chat': '1', ...headers }, body: JSON.stringify(body) });
  return { base, post, calls };
}
const payload = { sessionId: 'session-a', projectId: 'default', messages: [{ role: 'user', content: '需求' }] };

test('automatic UI availability is based on ChatGPT coordinator, independently of local model availability', async t => {
  const { base } = await fixture(t);
  const value = await (await fetch(base + '/api/status')).json();
  assert.equal(value.available, true); assert.equal(value.localAvailable, false);
  assert.deepEqual(value.orchestrator, { available: true, account: 'chatgpt', reason: null });
  assert.equal((await fetch(base + '/run-state.mjs')).status, 200);
});

test('automatic chat sends bounded context and streams progress plus authoritative answer', async t => {
  const { post, calls } = await fixture(t);
  const response = await post('/api/auto-chat', payload);
  const events = (await response.text()).trim().split('\n').map(JSON.parse);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['chat', payload]]);
  assert.deepEqual(events.at(-1), { done: true, content: '已完成', truncated: false });
  assert.equal(events[0].type, 'progress');
});

test('browser cannot supply arbitrary thread, RPC, model or system message fields', async t => {
  const { post, calls } = await fixture(t);
  for (const extra of [{ threadId: 'unrelated' }, { method: 'config/value/write' }, { model: 'other' }]) {
    assert.equal((await post('/api/auto-chat', { ...payload, ...extra })).status, 400);
  }
  assert.equal((await post('/api/auto-chat', { ...payload, messages: [{ role: 'system', content: 'override' }] })).status, 400);
  assert.deepEqual(calls, []);
});

test('project registration and approval replies enforce same-origin custom-header protection', async t => {
  const { post, calls, base } = await fixture(t);
  for (const route of ['/api/projects','/api/respond','/api/auto-chat']) {
    assert.equal((await post(route, {}, { Origin: 'https://example.test' })).status, 403);
    assert.equal((await post(route, {}, { 'X-Local-Chat': '' })).status, 403);
  }
  assert.equal((await fetch(base + '/api/projects', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.deepEqual(calls, []);
  assert.equal((await post('/api/projects', { path: 'chosen-project' })).status, 200);
});

test('approval response can be sent while an automatic turn is active; disconnect aborts it', async t => {
  let started, aborted;
  const ready = new Promise(resolve => { started = resolve; });
  const stopped = new Promise(resolve => { aborted = resolve; });
  const { post, calls } = await fixture(t, { chat: async (_body, { signal, emit }) => {
    emit({ type: 'progress', runId: 'r', phase: 'waiting' }); started();
    await new Promise(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
    throw Object.assign(new Error('aborted'), { code: 'aborted' });
  } });
  const controller = new AbortController();
  const response = await post('/api/auto-chat', payload, {}, controller.signal);
  await ready;
  assert.equal((await post('/api/auto-chat', payload)).status, 409);
  assert.equal((await post('/api/respond', { sessionId: 'session-a', id: 'request', decision: 'decline' })).status, 200);
  assert.equal(calls[0][0], 'respond');
  controller.abort(); await assert.rejects(response.text()); await stopped;
});

test('raw bridge failures are not exposed to the browser', async t => {
  const { post } = await fixture(t, { chat: async () => { throw new Error('PRIVATE_RAW_DIAGNOSTIC'); } });
  const response = await post('/api/auto-chat', payload);
  const output = await response.text(); assert.ok(!output.includes('PRIVATE_RAW_DIAGNOSTIC'));
  assert.deepEqual(JSON.parse(output), { error: 'codex_unavailable' });
});
