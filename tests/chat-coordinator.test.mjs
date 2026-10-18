import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatCoordinator, toolReceipt } from '../src/chat-coordinator.mjs';

const TASK_ID = '3a219b1e-087b-4bb9-976f-93adb105962b';
const HASH = 'ab'.repeat(32);
const nextTick = () => new Promise(resolve => setImmediate(resolve));

class FakeRpc extends EventEmitter {
  constructor() {
    super(); this.calls = []; this.responses = []; this.rejections = [];
    this.account = { type: 'chatgpt', email: 'PRIVATE_EMAIL@example.invalid' };
    this.provider = 'openai'; this.sequence = 0; this.turnSequence = 0; this.closed = false;
  }
  async start() { this.started = true; }
  async call(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === 'account/read') return { account: this.account };
    if (method === 'thread/start' || method === 'thread/resume') {
      return { modelProvider: this.provider, cwd: params.cwd,
        thread: { id: this.responseThread ?? params.threadId ?? `owned_thread_${++this.sequence}` } };
    }
    if (method === 'turn/start') {
      const turn = { id: `owned_turn_${++this.turnSequence}` };
      this.emit('turnCall', { threadId: params.threadId, turnId: turn.id });
      return { turn };
    }
    if (method === 'turn/interrupt') return {};
    throw new Error(`Unexpected fake RPC method: ${method}`);
  }
  respond(id, result) { this.responses.push({ id, result }); }
  rejectRequest(id) { this.rejections.push(id); }
  close() { this.closed = true; }
  notify(method, params) { this.emit('notification', { method, params }); }
  request(id, method, params) { this.emit('request', { id, method, params }); }
  finish(run, content = '真实最终回复', status = 'completed') {
    this.notify('item/completed', { threadId: run.threadId, turnId: run.turnId,
      item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: content } });
    this.notify('turn/completed', { threadId: run.threadId, turn: { id: run.turnId, status } });
  }
}

async function fixture(t) {
  // Windows deliberately disallows registering LocalAppData, including OS temp.
  const parent = fileURLToPath(new URL('../state/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'coordinator-test-'));
  const stateDir = join(root, 'state');
  const rpc = new FakeRpc();
  const coordinator = new ChatCoordinator({ stateDir, rpc, turnTimeoutMs: 5000 });
  t.after(async () => { coordinator.close(); await coordinator.saving.catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  await coordinator.load();
  return { root, stateDir, rpc, coordinator };
}

async function begin(coordinator, rpc, overrides = {}) {
  const events = [], controller = new AbortController();
  const started = once(rpc, 'turnCall');
  const promise = coordinator.chat({ sessionId: 'browser_session', projectId: 'default',
    messages: [{ role: 'user', content: 'PRIVATE_CHAT_CONTENT' }], ...overrides },
  { signal: controller.signal, emit: event => events.push(event) });
  promise.catch(() => {});
  const [run] = await started;
  await nextTick();
  return { ...run, events, promise, controller };
}

function receiptItem(tool = 'local_ai_review', value = { taskId: TASK_ID, candidateHash: HASH,
  status: 'review_recorded', decision: 'approve' }, server = 'local_ai_goflow') {
  return { type: 'mcpToolCall', id: 'receipt_item', server, tool, status: 'completed',
    error: null, result: { structuredContent: value, content: [] } };
}

test('account status accepts only managed ChatGPT login and never returns account email', async t => {
  const { coordinator, rpc } = await fixture(t);
  assert.deepEqual(await coordinator.status(), { available: true, account: 'chatgpt', reason: null });
  assert.equal(rpc.calls[0].method, 'account/read');
  assert.deepEqual(rpc.calls[0].params, { refreshToken: false });
  for (const account of [{ type: 'apiKey' }, { type: 'apikey' }, null]) {
    rpc.account = account;
    assert.deepEqual(await coordinator.status({ force: true }), {
      available: false, account: null, reason: 'chatgpt_login_required',
    });
  }
  assert.equal(JSON.stringify(await coordinator.projects()).includes('PRIVATE_EMAIL'), false);
});

test('project registration requires an existing absolute directory and rejects root, home and extra actions', async t => {
  const { root, coordinator } = await fixture(t);
  const project = join(root, 'project'); await mkdir(project);
  const file = join(root, 'ordinary.txt'); await writeFile(file, 'fixture');
  for (const body of [{ path: 'relative-project' }, { path: parse(root).root }, { path: homedir() },
    { path: join(root, 'missing') }, { path: file }, { path: project + '\u0000' },
    { path: '\\\\server\\share' }, { path: project, method: 'thread/read' }, null]) {
    await assert.rejects(coordinator.registerProject(body), { code: 'invalid_project' });
  }
  const first = await coordinator.registerProject({ path: project });
  assert.match(first.project.id, /^[a-f0-9-]{36}$/);
  assert.equal(first.project.name, 'project');
  assert.deepEqual(await coordinator.registerProject({ path: project }), first);
  first.project.name = 'MUTATED';
  assert.equal((await coordinator.projects()).projects.find(p => p.id === first.project.id).name, 'project');
});

test('an unregistered project and API-key login cannot start a thread or inference', async t => {
  const { coordinator, rpc } = await fixture(t);
  const options = { signal: new AbortController().signal, emit() {} };
  const body = { sessionId: 'a', projectId: 'unregistered', messages: [{ role: 'user', content: 'request' }] };
  await assert.rejects(coordinator.chat(body, options), { code: 'invalid_project' });
  rpc.account = { type: 'apiKey' };
  await assert.rejects(coordinator.chat({ ...body, projectId: 'default' }, options), { code: 'chatgpt_login_required' });
  assert.equal(rpc.calls.some(c => c.method === 'thread/start' || c.method === 'turn/start'), false);
});

test('a non-OpenAI provider is rejected before turn inference without rewriting session permissions', async t => {
  const { coordinator, rpc } = await fixture(t); rpc.provider = 'other-paid-provider';
  await assert.rejects(coordinator.chat({ sessionId: 'session', projectId: 'default', messages: [{ role: 'user', content: 'request' }] },
    { signal: new AbortController().signal, emit() {} }), { code: 'unsupported_codex_provider' });
  assert.equal(rpc.calls.some(c => c.method === 'turn/start'), false);
  const setup = rpc.calls.find(c => c.method === 'thread/start').params;
  assert.equal(Object.hasOwn(setup, 'approvalPolicy'), false);
  assert.equal(Object.hasOwn(setup, 'sandbox'), false);
  assert.equal(Object.hasOwn(setup, 'config'), false);
});

test('registered session stays bound to its project and only its stored thread is resumed after restart', async t => {
  const { root, stateDir, coordinator, rpc } = await fixture(t);
  const run = await begin(coordinator, rpc);
  rpc.finish(run); assert.equal((await run.promise).content, '真实最终回复');
  const project = join(root, 'second-project'); await mkdir(project);
  const second = await coordinator.registerProject({ path: project });
  const calls = rpc.calls.length;
  await assert.rejects(coordinator.chat({ sessionId: 'browser_session', projectId: second.project.id,
    messages: [{ role: 'user', content: 'request' }] }, { signal: new AbortController().signal, emit() {} }), { code: 'session_project_locked' });
  assert.equal(rpc.calls.length, calls);
  const stored = await readFile(join(stateDir, 'coordinator.json'), 'utf8');
  assert.equal(stored.includes('PRIVATE_CHAT_CONTENT'), false);
  assert.equal(stored.includes('PRIVATE_EMAIL'), false);
  assert.deepEqual(Object.keys(JSON.parse(stored).sessions[0]).sort(), ['id', 'projectId', 'threadId']);
  coordinator.close();
  const rpc2 = new FakeRpc(), resumed = new ChatCoordinator({ stateDir, rpc: rpc2, turnTimeoutMs: 5000 });
  t.after(() => resumed.close());
  const later = await begin(resumed, rpc2, { messages: [{ role: 'assistant', content: 'do not replay this old answer' }, { role: 'user', content: 'only newest request' }] });
  assert.equal(rpc2.calls.some(c => c.method === 'thread/start'), false);
  assert.equal(rpc2.calls.find(c => c.method === 'thread/resume').params.threadId, run.threadId);
  assert.equal(rpc2.calls.find(c => c.method === 'turn/start').params.input[0].text, 'only newest request');
  rpc2.finish(later, '恢复成功'); assert.equal((await later.promise).content, '恢复成功');
});

test('resume cannot replace its registered thread with a different server thread', async t => {
  const { coordinator, rpc } = await fixture(t);
  const run = await begin(coordinator, rpc); rpc.finish(run); await run.promise;
  rpc.responseThread = 'unregistered_thread';
  const count = rpc.calls.filter(c => c.method === 'turn/start').length;
  await assert.rejects(coordinator.chat({ sessionId: 'browser_session', projectId: 'default', messages: [{ role: 'user', content: 'next' }] },
    { signal: new AbortController().signal, emit() {} }), { code: 'codex_protocol_error' });
  assert.equal(rpc.calls.filter(c => c.method === 'turn/start').length, count);
});

test('notifications from another thread or an old turn cannot stream content, receipts or finish the active turn', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  const before = run.events.length;
  for (const address of [{ threadId: 'someone_elses_thread', turnId: run.turnId }, { threadId: run.threadId, turnId: 'old_turn' }]) {
    rpc.notify('item/agentMessage/delta', { ...address, itemId: 'old_answer', delta: 'PRIVATE_OTHER_CHAT' });
    rpc.notify('item/completed', { ...address, item: receiptItem() });
  }
  rpc.notify('turn/started', { threadId: run.threadId, turn: { id: 'old_turn', status: 'inProgress' } });
  rpc.notify('turn/completed', { threadId: run.threadId, turn: { id: 'old_turn', status: 'completed' } });
  await nextTick();
  assert.equal(coordinator.active?.turnId, run.turnId);
  assert.equal(run.events.length, before);
  rpc.finish(run, '当前回合'); assert.equal((await run.promise).content, '当前回合');
});

test('commentary, command output and self-reported review text never become actual review receipts', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  rpc.notify('item/started', { threadId: run.threadId, turnId: run.turnId,
    item: { id: 'commentary', type: 'agentMessage', phase: 'commentary' } });
  rpc.notify('item/agentMessage/delta', { threadId: run.threadId, turnId: run.turnId, itemId: 'commentary', delta: 'PRIVATE_REASONING' });
  rpc.notify('item/commandExecution/outputDelta', { threadId: run.threadId, turnId: run.turnId, delta: 'PRIVATE_COMMAND_OUTPUT' });
  rpc.finish(run, '我已经审核通过（仅模型自述）');
  assert.equal((await run.promise).content, '我已经审核通过（仅模型自述）');
  assert.equal(run.events.some(e => e.type === 'receipt'), false);
  assert.equal(JSON.stringify(run.events).includes('PRIVATE_'), false);
});

test('failed, interrupted and empty completed turns are never successful replies', async t => {
  const { coordinator, rpc } = await fixture(t);
  for (const [status, code, answer] of [['failed', 'codex_turn_failed', 'partial'], ['interrupted', 'aborted', 'partial'], ['completed', 'codex_empty_reply', '']]) {
    const run = await begin(coordinator, rpc); rpc.finish(run, answer, status);
    await assert.rejects(run.promise, { code });
    assert.equal(coordinator.active, null);
  }
});

test('real MCP receipt parsing requires a valid task, candidate hash and trusted review decision', () => {
  assert.deepEqual(toolReceipt(receiptItem()), { source: 'local', taskId: TASK_ID, status: 'reviewed' });
  const localRejected = receiptItem('local_ai_review', { taskId: TASK_ID, candidateHash: HASH, status: 'review_recorded', decision: 'reject' });
  assert.equal(toolReceipt(localRejected).status, 'rejected');
  const go = receiptItem('goflow_accept', { taskId: TASK_ID, status: 'accepted', review: {
    accepted: true, reviewer: 'GPT', decision: 'approve', candidateHash: HASH,
  } }, 'goflow');
  assert.deepEqual(toolReceipt(go), { source: 'go', taskId: TASK_ID, status: 'accepted' });
  const fallback = structuredClone(go); fallback.result = { content: [{ type: 'text', text: JSON.stringify(go.result.structuredContent) }] };
  assert.deepEqual(toolReceipt(fallback), toolReceipt(go));
  const invalid = [
    { ...go, type: 'agentMessage' }, { ...go, status: 'failed' }, { ...go, error: { message: 'failed' } },
    { ...go, server: 'unrelated_mcp_server' }, { ...go, tool: 'not_goflow_accept' },
    { ...go, result: { ...go.result, isError: true } },
    receiptItem('local_ai_review', { taskId: TASK_ID, candidateHash: 'wrong', status: 'review_recorded', decision: 'approve' }),
    receiptItem('local_ai_review', { taskId: 'not-task-id', candidateHash: HASH, status: 'review_recorded', decision: 'approve' }),
    receiptItem('local_ai_review', { taskId: TASK_ID, candidateHash: HASH, status: 'review_recorded', decision: 'maybe' }),
    ...['Go', undefined].map(reviewer => receiptItem('goflow_accept', { ...go.result.structuredContent,
      review: { ...go.result.structuredContent.review, reviewer } }, 'goflow')),
    receiptItem('goflow_accept', { ...go.result.structuredContent, review: { ...go.result.structuredContent.review, candidateHash: 'bad' } }, 'goflow'),
    receiptItem('goflow_accept', { ...go.result.structuredContent, review: { ...go.result.structuredContent.review, decision: 'reject' } }, 'goflow'),
  ];
  for (const item of invalid) assert.equal(toolReceipt(item), null, JSON.stringify({ server: item.server, tool: item.tool, result: item.result }));
});

test('command approvals use opaque session-bound single-use local handles', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  rpc.request(71, 'item/commandExecution/requestApproval', { ...run, command: 'node --test safe.test.mjs', cwd: 'fixture-project', reason: '运行项目测试' });
  const pending = run.events.find(e => e.type === 'pending');
  assert.match(pending.id, /^[a-f0-9-]{36}$/); assert.notEqual(pending.id, '71');
  assert.equal(Object.hasOwn(pending, 'rpcId'), false);
  assert.throws(() => coordinator.respond({ sessionId: 'different_session', id: pending.id, decision: 'accept' }), { code: 'stale_approval' });
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'acceptForSession' }), { code: 'invalid_response' });
  assert.deepEqual(coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'accept' }), { ok: true });
  assert.deepEqual(rpc.responses.at(-1), { id: 71, result: { decision: 'accept' } });
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'accept' }), { code: 'stale_approval' });
  rpc.finish(run); await run.promise;
});

test('file change approval requires the actual announced file item and can be declined', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  const change = { id: 'file_change', type: 'fileChange', changes: [{ path: 'safe.mjs', kind: { type: 'update' }, diff: '+expected' }] };
  rpc.notify('item/started', { ...run, item: change });
  rpc.request(72, 'item/fileChange/requestApproval', { ...run, itemId: change.id, reason: '写入请求范围内文件' });
  const pending = run.events.find(e => e.type === 'pending');
  assert.match(pending.detail, /safe\.mjs/);
  coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'decline' });
  assert.deepEqual(rpc.responses.at(-1), { id: 72, result: { decision: 'decline' } });
  rpc.finish(run); await run.promise;
});

test('user-input answers map only the announced question IDs and reject secret questions', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  rpc.request(73, 'item/tool/requestUserInput', { ...run, questions: [
    { id: 'language', question: '选择语言', options: [{ label: '中文', description: '中文界面' }] },
    { id: 'name', question: '项目名称', options: null },
  ] });
  const pending = run.events.find(e => e.type === 'pending');
  assert.equal(pending.kind, 'question');
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: pending.id, answers: { language: '中文', unknown: 'x' } }), { code: 'invalid_response' });
  coordinator.respond({ sessionId: 'browser_session', id: pending.id, answers: { language: '中文', name: 'demo' } });
  assert.deepEqual(rpc.responses.at(-1), { id: 73, result: { answers: { language: { answers: ['中文'] }, name: { answers: ['demo'] } } } });
  rpc.request(74, 'item/tool/requestUserInput', { ...run, questions: [{ id: 'key', question: 'secret', isSecret: true }] });
  await assert.rejects(run.promise, { code: 'unsupported_approval' });
  assert.ok(rpc.rejections.includes(74));
});

test('unknown, cross-thread and expanded-permission requests fail closed', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  rpc.request(80, 'item/commandExecution/requestApproval', { threadId: 'other_thread', turnId: run.turnId, command: 'outside' });
  assert.ok(rpc.rejections.includes(80));
  assert.equal(run.events.some(e => e.type === 'pending'), false);
  rpc.request(81, 'item/permissions/requestApproval', { threadId: run.threadId, turnId: run.turnId, permissions: { network: true } });
  await assert.rejects(run.promise, { code: 'unsupported_approval' });
  assert.deepEqual(rpc.responses.find(r => r.id === 81).result, { permissions: {}, scope: 'turn' });
  const later = await begin(coordinator, rpc);
  rpc.request(82, 'item/commandExecution/requestApproval', { ...later, cwd: 'fixture-project', command: 'curl outside', networkApprovalContext: {} });
  await assert.rejects(later.promise, { code: 'unsupported_approval' });
  assert.deepEqual(rpc.responses.find(r => r.id === 82).result, { decision: 'decline' });
});

test('stop declines pending approvals, interrupts the owned turn and invalidates response handles', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  rpc.request(90, 'item/commandExecution/requestApproval', { ...run, cwd: 'fixture-project', command: 'node --test' });
  const pending = run.events.find(e => e.type === 'pending'); run.controller.abort();
  await assert.rejects(run.promise, { code: 'aborted' });
  assert.deepEqual(rpc.responses.find(r => r.id === 90).result, { decision: 'decline' });
  assert.ok(rpc.calls.some(c => c.method === 'turn/interrupt' && c.params.threadId === run.threadId && c.params.turnId === run.turnId));
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'accept' }), { code: 'stale_approval' });
  assert.equal(coordinator.active, null);
});

test('disconnect fails the active turn and rejects pending permissions without leaking connection diagnostics', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  rpc.request(91, 'item/commandExecution/requestApproval', { ...run, cwd: 'fixture-project', command: 'node --test' });
  rpc.emit('disconnected', 'PRIVATE_STDERR_OR_TOKEN');
  await assert.rejects(run.promise, { code: 'codex_disconnected' });
  assert.equal(coordinator.active, null);
  assert.equal(JSON.stringify(run.events).includes('PRIVATE_STDERR_OR_TOKEN'), false);
  assert.deepEqual(rpc.responses.find(r => r.id === 91).result, { decision: 'decline' });
});

test('concurrent setup cannot create two active sessions while account readiness is being checked', async t => {
  const { coordinator, rpc } = await fixture(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  const originalCall = rpc.call.bind(rpc);
  rpc.call = async (method, params) => { if (method === 'account/read') await gate; return originalCall(method, params); };
  const controllers = [new AbortController(), new AbortController()];
  const started = once(rpc, 'turnCall');
  const runs = controllers.map((controller, index) => coordinator.chat({ sessionId: `parallel_${index}`, projectId: 'default',
    messages: [{ role: 'user', content: 'bounded request' }] }, { signal: controller.signal, emit() {} }));
  runs.forEach(promise => promise.catch(() => {}));
  await nextTick(); release(); await started; await nextTick();
  const inferenceCalls = rpc.calls.filter(c => c.method === 'turn/start').length;
  controllers.forEach(controller => controller.abort());
  const outcomes = await Promise.allSettled(runs);
  assert.equal(inferenceCalls, 1);
  assert.equal(outcomes[1].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'local_busy');
});

test('queue and negative review receipts keep their real backend and require complete review evidence', () => {
  const queued = receiptItem('goflow_submit', { taskId: TASK_ID, status: 'queued' }, 'goflow');
  assert.deepEqual(toolReceipt(queued), { source: 'go', taskId: TASK_ID, status: 'queued' });
  assert.equal(toolReceipt(receiptItem('local_ai_review', { taskId: TASK_ID, status: 'queued' })), null);
  const rejection = { taskId: TASK_ID, status: 'revision_requested', review: {
    reviewer: 'GPT', candidateHash: HASH, decision: 'reject', accepted: false,
  } };
  assert.deepEqual(toolReceipt(receiptItem('goflow_accept', rejection, 'goflow')), { source: 'go', taskId: TASK_ID, status: 'rejected' });
  for (const review of [{ decision: 'reject' }, { ...rejection.review, reviewer: 'Go' },
    { ...rejection.review, candidateHash: 'invalid' }]) {
    assert.equal(toolReceipt(receiptItem('goflow_accept', { ...rejection, review }, 'goflow')), null);
  }
});

for (const notifiedTurn of [false, true]) {
  test(`abort during unanswered turn/start promptly ${notifiedTurn ? 'interrupts the notified turn' : 'closes the RPC when the turn ID is unknown'} and discards late events`, async t => {
    const { coordinator, rpc } = await fixture(t);
    const originalCall = rpc.call.bind(rpc);
    let releaseStart;
    rpc.call = (method, params) => {
      if (method !== 'turn/start') return originalCall(method, params);
      rpc.calls.push({ method, params: structuredClone(params) });
      const deferred = new Promise(resolve => { releaseStart = resolve; });
      rpc.emit('turnCall', { threadId: params.threadId, turnId: 'notified_cancel_turn' });
      return deferred;
    };
    const run = await begin(coordinator, rpc);
    if (notifiedTurn) rpc.notify('turn/started', {
      threadId: run.threadId, turn: { id: run.turnId, status: 'inProgress' },
    });
    assert.equal(coordinator.active.turnId, notifiedTurn ? run.turnId : null);
    run.controller.abort();
    const emitLateEvents = () => {
      rpc.notify('item/agentMessage/delta', { threadId: run.threadId, turnId: run.turnId,
        itemId: 'late_answer', delta: 'PRIVATE_LATE_CANCELLED_ANSWER' });
      rpc.notify('item/completed', { threadId: run.threadId, turnId: run.turnId, item: receiptItem() });
      rpc.finish(run, 'PRIVATE_LATE_CANCELLED_FINAL');
    };
    const eventsAfterAbort = run.events.length;
    emitLateEvents();
    let timeout;
    try {
      const result = await Promise.race([
        run.promise.then(value => ({ state: 'fulfilled', value }), error => ({ state: 'rejected', error })),
        new Promise(resolve => { timeout = setTimeout(() => resolve({ state: 'still_waiting_for_start_rpc' }), 750); }),
      ]);
      assert.equal(result.state, 'rejected', 'abort must finish while the turn/start RPC remains unanswered');
      assert.equal(result.error.code, 'aborted');
      if (notifiedTurn) {
        assert.ok(rpc.calls.some(call => call.method === 'turn/interrupt'
          && call.params.threadId === run.threadId && call.params.turnId === run.turnId));
      } else {
        assert.equal(rpc.closed, true, 'without a turn ID the owned RPC must close rather than abandon the running request');
        assert.equal(rpc.calls.some(call => call.method === 'turn/interrupt'), false);
      }
      assert.equal(coordinator.active, null);
      emitLateEvents();
      assert.equal(run.events.length, eventsAfterAbort);
      assert.equal(run.events.some(event => event.type === 'receipt'), false);
      assert.equal(JSON.stringify(run.events).includes('PRIVATE_LATE_CANCELLED'), false);
    } finally {
      clearTimeout(timeout);
      // Release only after cancellation assertions; it cannot satisfy the deadline above.
      releaseStart({ turn: { id: run.turnId } });
      await run.promise.catch(() => {});
    }
  });
}

test('oversized approval command is declined without exposing a truncated approvable handle', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  rpc.request(120, 'item/commandExecution/requestApproval', {
    threadId: run.threadId, turnId: run.turnId, cwd: 'fixture-project',
    command: 'x'.repeat(10001) + ' HIDDEN_COMMAND_TAIL', reason: '检查完整命令可见性',
  });
  assert.deepEqual(rpc.responses.find(response => response.id === 120).result, { decision: 'decline' });
  assert.equal(coordinator.active.pending.size, 0);
  assert.equal(run.events.some(event => event.type === 'pending'), false);
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: TASK_ID, decision: 'accept' }), { code: 'stale_approval' });
  await assert.rejects(run.promise, { code: 'unsupported_approval' });
  assert.equal(coordinator.active, null);
  assert.equal(rpc.responses.some(response => response.result?.decision === 'accept'), false);
});

test('oversized approval file diff is declined without exposing a truncated approvable handle', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  const item = { id: 'oversized_file_diff', type: 'fileChange', changes: [{
    path: 'safe.mjs', kind: { type: 'update' }, diff: '+'.repeat(24001) + 'HIDDEN_DIFF_TAIL',
  }] };
  rpc.notify('item/started', { threadId: run.threadId, turnId: run.turnId, item });
  rpc.request(121, 'item/fileChange/requestApproval', {
    threadId: run.threadId, turnId: run.turnId, itemId: item.id, reason: '检查完整补丁可见性', grantRoot: 'fixture-project',
  });
  assert.deepEqual(rpc.responses.find(response => response.id === 121).result, { decision: 'decline' });
  assert.equal(coordinator.active.pending.size, 0);
  assert.equal(run.events.some(event => event.type === 'pending'), false);
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: TASK_ID, decision: 'accept' }), { code: 'stale_approval' });
  await assert.rejects(run.promise, { code: 'unsupported_approval' });
  assert.equal(coordinator.active, null);
  assert.equal(rpc.responses.some(response => response.result?.decision === 'accept'), false);
});

test('trusted empty GoFlow elicitation requires an explicit session-bound single-use confirmation', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  rpc.request(140, 'mcpServer/elicitation/request', {
    threadId: run.threadId, turnId: run.turnId, serverName: 'goflow', mode: 'form',
    message: '确认应用已审核的 GoFlow 候选', requestedSchema: { type: 'object', properties: {}, required: [] },
  });
  const pending = run.events.find(event => event.type === 'pending');
  assert.equal(pending.kind, 'approval');
  assert.equal(pending.detail, '确认应用已审核的 GoFlow 候选');
  assert.equal(rpc.responses.some(response => response.id === 140), false, 'confirmation must never auto-accept');
  assert.throws(() => coordinator.respond({ sessionId: 'different_session', id: pending.id, decision: 'accept' }), { code: 'stale_approval' });
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'accept', answers: { secret: 'unrequested' } }), { code: 'invalid_response' });
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'accept', content: {} }), { code: 'invalid_response' });
  assert.equal(rpc.responses.some(response => response.id === 140), false);
  assert.deepEqual(coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'accept' }), { ok: true });
  assert.deepEqual(rpc.responses.find(response => response.id === 140).result, { action: 'accept', content: {}, _meta: null });
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'accept' }), { code: 'stale_approval' });
  assert.equal(rpc.responses.filter(response => response.id === 140).length, 1);
  rpc.finish(run); await run.promise;
});

test('stopping a pending trusted empty elicitation sends a native decline and invalidates its handle', async t => {
  const { coordinator, rpc } = await fixture(t); const run = await begin(coordinator, rpc);
  rpc.request(141, 'mcpServer/elicitation/request', {
    threadId: run.threadId, turnId: run.turnId, serverName: 'goflow_plugin', mode: 'form',
    message: '确认本次 GoFlow 操作', requestedSchema: { type: 'object', properties: {} },
  });
  const pending = run.events.find(event => event.type === 'pending');
  assert.ok(pending);
  assert.equal(rpc.responses.some(response => response.id === 141), false);
  run.controller.abort();
  await assert.rejects(run.promise, { code: 'aborted' });
  assert.deepEqual(rpc.responses.filter(response => response.id === 141), [
    { id: 141, result: { action: 'decline', content: null, _meta: null } },
  ]);
  assert.throws(() => coordinator.respond({ sessionId: 'browser_session', id: pending.id, decision: 'accept' }), { code: 'stale_approval' });
  assert.equal(coordinator.active, null);
});

test('elicitation rejects nonempty or secret forms, URL requests and untrusted server names', async t => {
  const { coordinator, rpc } = await fixture(t);
  const valid = { serverName: 'goflow', mode: 'form', message: '确认本次工具操作', requestedSchema: { type: 'object', properties: {} } };
  const invalid = [
    { requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } },
    { requestedSchema: { type: 'object', properties: { key: { type: 'string', format: 'password', writeOnly: true } } } },
    { requestedSchema: { type: 'object', properties: {}, required: ['unrequested_field'] } },
    ...[null, false, 0, ''].map(required => ({ requestedSchema: { type: 'object', properties: {}, required } })),
    { mode: 'url', url: 'https://example.invalid/authorization' },
    { serverName: 'untrusted_mcp_server' },
    { serverName: 'goflow_attacker' },
  ];
  for (const [index, patch] of invalid.entries()) {
    const run = await begin(coordinator, rpc);
    const id = 150 + index;
    rpc.request(id, 'mcpServer/elicitation/request', { ...valid, ...patch, threadId: run.threadId, turnId: run.turnId });
    assert.equal(run.events.some(event => event.type === 'pending'), false);
    assert.equal(coordinator.active.pending.size, 0);
    await assert.rejects(run.promise, { code: 'unsupported_approval' });
    assert.deepEqual(rpc.responses.find(response => response.id === id).result, { action: 'decline', content: null, _meta: null });
    assert.equal(rpc.responses.some(response => response.id === id && response.result.action === 'accept'), false);
  }
});
