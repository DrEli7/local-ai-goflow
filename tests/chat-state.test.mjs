import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LIMITS,
  MESSAGE_STATUS,
  DEFAULT_TITLE,
  createState,
  createSession,
  switchSession,
  deleteSession,
  clearSession,
  renameSession,
  getSession,
  getActiveSession,
  getSessionMessages,
  canCreateSession,
  validateInput,
  appendUserMessage,
  beginAssistantMessage,
  appendAssistantDelta,
  completeAssistantMessage,
  abortAssistantMessage,
  failAssistantMessage,
  retryLastGeneration,
  buildRequestContext,
  serializeState,
  deserializeState,
  normalizeState,
} from '../web/chat-state.mjs';

function fresh(title = '测试会话') {
  return createSession(createState(), { id: 's-1', title, now: 1000 });
}

function messagesOf(state, sessionId = 's-1') {
  return getSession(state, sessionId).messages;
}

function roleCount(list, role) {
  return list.filter((message) => message.role === role).length;
}

/* ---------------------------------------------------------------- 多轮与隔离 */

test('多轮对话累积在同一会话，且不同会话互相隔离', () => {
  let state = createState();
  state = createSession(state, { id: 'a', title: 'A', now: 1000 });
  state = createSession(state, { id: 'b', title: 'B', now: 2000 });
  assert.equal(state.activeSessionId, 'b');

  state = appendUserMessage(state, '你好', { now: 3000 });
  state = beginAssistantMessage(state, { id: 'a1', now: 3001 });
  state = appendAssistantDelta(state, 'a1', '你好，', { now: 3002 });
  state = appendAssistantDelta(state, 'a1', '有什么可以帮你？', { now: 3003 });
  state = completeAssistantMessage(state, 'a1', { now: 3004 });

  const b = messagesOf(state, 'b');
  assert.equal(b.length, 2);
  assert.equal(b[0].role, 'user');
  assert.equal(b[0].content, '你好');
  assert.equal(b[1].role, 'assistant');
  assert.equal(b[1].content, '你好，有什么可以帮你？');
  assert.equal(b[1].status, MESSAGE_STATUS.COMPLETE);

  // 会话 A 完全没有受到影响
  assert.equal(messagesOf(state, 'a').length, 0);

  state = switchSession(state, 'a');
  assert.equal(state.activeSessionId, 'a');
  assert.deepEqual(buildRequestContext(state), []);

  const ctxB = buildRequestContext(state, { sessionId: 'b' });
  assert.deepEqual(ctxB, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，有什么可以帮你？' },
  ]);
});

/* ---------------------------------------------------------------- 会话 CRUD */

test('创建、切换、删除、清空与重命名会话', () => {
  let state = createState();
  state = createSession(state, { id: 's1', now: 1 });
  state = createSession(state, { id: 's2', now: 2 });
  state = createSession(state, { id: 's3', now: 3 });
  assert.equal(state.sessions.length, 3);
  assert.equal(state.activeSessionId, 's3');
  assert.equal(getSession(state, 's1').title, DEFAULT_TITLE);

  state = switchSession(state, 's1');
  assert.equal(state.activeSessionId, 's1');
  state = switchSession(state, '不存在的会话');
  assert.equal(state.activeSessionId, 's1');

  state = appendUserMessage(state, '第一句');
  state = appendUserMessage(state, '第二句');
  assert.equal(messagesOf(state, 's1').length, 2);

  state = renameSession(state, 's1', '  重命名后的标题  ');
  assert.equal(getSession(state, 's1').title, '重命名后的标题');
  state = renameSession(state, 's1', '   ');
  assert.equal(getSession(state, 's1').title, DEFAULT_TITLE);

  state = clearSession(state, 's1');
  assert.equal(messagesOf(state, 's1').length, 0);
  assert.equal(state.sessions.length, 3);

  state = switchSession(state, 's1');
  state = deleteSession(state, 's1');
  assert.equal(state.sessions.length, 2);
  assert.notEqual(state.activeSessionId, 's1');
  assert.equal(state.activeSessionId, 's2');

  const before = state;
  assert.equal(deleteSession(state, 's1'), before);
  assert.equal(switchSession(state, 'ghost'), before);
  assert.equal(state.sessions.length, 2);
});

/* ---------------------------------------------------------------- 边界配额 */

test('会话数量上限为 20，超出的创建请求被忽略', () => {
  let state = createState();
  for (let i = 0; i < 25; i += 1) {
    state = createSession(state, { id: 'sess-' + i });
  }
  assert.equal(state.sessions.length, LIMITS.MAX_SESSIONS);
  assert.equal(canCreateSession(state), false);

  const overflowed = createSession(state, { id: 'sess-over' });
  assert.equal(overflowed.sessions.length, LIMITS.MAX_SESSIONS);
  assert.equal(overflowed.sessions.some((session) => session.id === 'sess-over'), false);
});

test('单会话只保留最新 60 条消息', () => {
  let state = fresh();
  for (let i = 0; i < 80; i += 1) {
    state = appendUserMessage(state, '用户消息 ' + i, { id: 'u' + i });
  }
  const messages = messagesOf(state);
  assert.equal(messages.length, LIMITS.MAX_MESSAGES_PER_SESSION);
  assert.equal(messages[0].content, '用户消息 20');
  assert.equal(messages[messages.length - 1].content, '用户消息 79');
});

test('助手消息内容被截断到 16000 UTF-16 字符', () => {
  let state = fresh();
  state = appendUserMessage(state, '开始');
  state = beginAssistantMessage(state, { id: 'a1' });
  state = appendAssistantDelta(state, 'a1', 'x'.repeat(LIMITS.MAX_MESSAGE_CHARS + 5000));
  const message = messagesOf(state)[1];
  assert.equal(message.content.length, LIMITS.MAX_MESSAGE_CHARS);

  const afterLimit = appendAssistantDelta(state, 'a1', '再多一点');
  assert.equal(messagesOf(afterLimit)[1].content.length, LIMITS.MAX_MESSAGE_CHARS);
});

/* ---------------------------------------------------------------- 输入校验 */

test('输入校验：拒绝空白与超长，接受 Unicode', () => {
  assert.equal(validateInput('').ok, false);
  assert.equal(validateInput('').error, 'empty');
  assert.equal(validateInput('   ').ok, false);
  assert.equal(validateInput('\n\t  \r\n').ok, false);
  assert.equal(validateInput(123).ok, false);
  assert.equal(validateInput(null).ok, false);
  assert.equal(validateInput(undefined).ok, false);

  const unicode = '你好，世界 🌏 émoji — 混合文本';
  const accepted = validateInput(unicode);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.value, unicode);

  const exactly = 'a'.repeat(LIMITS.MAX_INPUT_CHARS);
  assert.equal(validateInput(exactly).ok, true);
  assert.equal(validateInput(exactly + 'a').ok, false);

  let state = fresh();
  state = appendUserMessage(state, '   ');
  state = appendUserMessage(state, exactly + 'a');
  state = appendUserMessage(state, unicode);
  assert.equal(messagesOf(state).length, 1);
  assert.equal(messagesOf(state)[0].content, unicode);
});

/* ------------------------------------------------------- 生成 / 停止 / 失败 */

test('生成、完成、停止与失败都会保留已有输出', () => {
  let state = fresh();
  state = appendUserMessage(state, '写一首诗', { id: 'u1' });
  state = beginAssistantMessage(state, { id: 'a1' });
  assert.equal(messagesOf(state)[1].status, MESSAGE_STATUS.GENERATING);
  assert.equal(messagesOf(state)[1].content, '');

  state = appendAssistantDelta(state, 'a1', '白日依山尽，');
  state = abortAssistantMessage(state, 'a1');
  assert.equal(messagesOf(state)[1].status, MESSAGE_STATUS.ABORTED);
  assert.equal(messagesOf(state)[1].content, '白日依山尽，');

  state = beginAssistantMessage(state, { id: 'a2' });
  state = appendAssistantDelta(state, 'a2', '黄河入海流。');
  state = failAssistantMessage(state, 'a2');
  assert.equal(messagesOf(state)[2].status, MESSAGE_STATUS.FAILED);
  assert.equal(messagesOf(state)[2].content, '黄河入海流。');

  state = beginAssistantMessage(state, { id: 'a3' });
  state = appendAssistantDelta(state, 'a3', '欲穷千里目');
  state = completeAssistantMessage(state, 'a3', { append: '，更上一层楼。' });
  assert.equal(messagesOf(state)[3].status, MESSAGE_STATUS.COMPLETE);
  assert.equal(messagesOf(state)[3].content, '欲穷千里目，更上一层楼。');

  // 已完成的消息不再接受增量
  const frozen = messagesOf(state)[3].content;
  state = appendAssistantDelta(state, 'a3', '追加无效');
  assert.equal(messagesOf(state)[3].content, frozen);

  // 找不到消息时原样返回
  const same = appendAssistantDelta(state, '不存在', 'x');
  assert.equal(same, state);
  assert.equal(completeAssistantMessage(state, '不存在'), state);
});

/* ---------------------------------------------------------------- 请求上下文 */

test('请求上下文裁剪到 30 条 / 12000 字符，且不丢最新用户消息', () => {
  let state = fresh();
  for (let i = 0; i < 20; i += 1) {
    state = appendUserMessage(state, '问题 ' + i + ' ' + 'x'.repeat(985), { id: 'u' + i });
    state = beginAssistantMessage(state, { id: 'a' + i });
    state = completeAssistantMessage(state, 'a' + i, { content: '回答 ' + i + ' ' + 'y'.repeat(985) });
  }
  state = appendUserMessage(state, '最后一个问题', { id: 'u-last' });
  assert.equal(messagesOf(state).length, 41);

  const context = buildRequestContext(state);
  assert.ok(context.length > 0);
  assert.ok(context.length <= LIMITS.MAX_CONTEXT_MESSAGES);
  assert.ok(context.length < 41);

  const total = context.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total <= LIMITS.MAX_CONTEXT_CHARS);

  const last = context[context.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content, '最后一个问题');

  // 只包含 role 与 content 两个字段
  for (const message of context) {
    assert.deepEqual(Object.keys(message).sort(), ['content', 'role']);
    assert.ok(message.role === 'user' || message.role === 'assistant');
  }
});

test('请求上下文丢弃空的助手占位，也不混合其它会话', () => {
  let state = createState();
  state = createSession(state, { id: 'x', now: 1 });
  state = createSession(state, { id: 'y', now: 2 });

  state = appendUserMessage(state, '在吗', { sessionId: 'x' });
  state = beginAssistantMessage(state, { id: 'pending', sessionId: 'x' });

  const context = buildRequestContext(state, { sessionId: 'x' });
  assert.deepEqual(context, [{ role: 'user', content: '在吗' }]);
  assert.deepEqual(buildRequestContext(state, { sessionId: 'y' }), []);
});

/* ---------------------------------------------------------------- 重试语义 */

test('失败后重试不会重复插入相同的用户消息', () => {
  let state = fresh();
  state = appendUserMessage(state, '请重试', { id: 'u1' });
  state = beginAssistantMessage(state, { id: 'a1' });
  state = appendAssistantDelta(state, 'a1', '半截输出');
  state = failAssistantMessage(state, 'a1');

  const usersBefore = roleCount(messagesOf(state), 'user');
  assert.equal(usersBefore, 1);

  const retried = retryLastGeneration(state, { id: 'a2' });
  const messages = messagesOf(retried);

  assert.equal(roleCount(messages, 'user'), usersBefore);
  assert.equal(messages.filter((m) => m.role === 'user' && m.content === '请重试').length, 1);

  const last = messages[messages.length - 1];
  assert.equal(last.role, 'assistant');
  assert.equal(last.status, MESSAGE_STATUS.GENERATING);

  // 保留失败时的部分输出
  assert.equal(messages.filter((m) => m.content === '半截输出').length, 1);

  const context = buildRequestContext(retried);
  assert.equal(context.filter((m) => m.role === 'user' && m.content === '请重试').length, 1);
  assert.equal(roleCount(context, 'user'), 1);
});

test('重试会清理尾部未完成的空助手占位', () => {
  let state = fresh();
  state = appendUserMessage(state, '你好');
  state = beginAssistantMessage(state, { id: 'a1' });
  state = retryLastGeneration(state, { id: 'a2' });

  const messages = messagesOf(state);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].id, 'a2');
  assert.equal(messages[1].status, MESSAGE_STATUS.GENERATING);
});

test('没有用户消息时重试不会改变状态', () => {
  const state = fresh();
  assert.equal(retryLastGeneration(state), state);
});

/* ---------------------------------------------------------------- 序列化 */

test('序列化往返后状态完全一致', () => {
  let state = createState();
  state = createSession(state, { id: 's1', title: '会话一', now: 10 });
  state = appendUserMessage(state, '你好 🌟 这是一个测试', { id: 'u1', now: 11 });
  state = beginAssistantMessage(state, { id: 'a1', now: 12 });
  state = appendAssistantDelta(state, 'a1', '你好呀');
  state = completeAssistantMessage(state, 'a1', { now: 13 });
  state = createSession(state, { id: 's2', now: 14 });
  state = appendUserMessage(state, '第二个会话', { id: 'u2', now: 15 });
  state = switchSession(state, 's1');

  const json = serializeState(state);
  const restored = deserializeState(json);
  assert.deepEqual(restored, state);
  assert.deepEqual(deserializeState(serializeState(restored)), restored);
  assert.equal(typeof json, 'string');
});

/* ---------------------------------------------------- 坏 JSON / 畸形 / 超量 */

test('坏 JSON 恢复为安全空状态且不抛错', () => {
  for (const bad of ['{ 这不是 JSON', '', 'null', '42', '"text"', '[1,2,3]', undefined, null]) {
    const state = deserializeState(bad);
    assert.equal(state.sessions.length, 0);
    assert.equal(state.activeSessionId, null);
    assert.deepEqual(buildRequestContext(state), []);
  }
  assert.equal(normalizeState(undefined).sessions.length, 0);
  assert.equal(normalizeState('nope').sessions.length, 0);
});

test('畸形历史被过滤为合法结构', () => {
  const malformed = deserializeState(JSON.stringify({
    version: 1,
    activeSessionId: 'ghost',
    sessions: [
      null,
      'nope',
      {
        id: 'x',
        title: '   ',
        createdAt: 'not-a-date',
        messages: [
          { role: 'system', content: '不应保留' },
          { role: 'user', content: 123 },
          { role: 'user', content: '保留我' },
          { role: 'assistant', content: 'ok', status: 'weird-status' },
          'garbage',
        ],
      },
    ],
  }));

  assert.equal(malformed.sessions.length, 1);
  const session = malformed.sessions[0];
  assert.equal(session.id, 'x');
  assert.equal(session.title, DEFAULT_TITLE);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].role, 'user');
  assert.equal(session.messages[0].content, '保留我');
  assert.equal(session.messages[1].role, 'assistant');
  assert.equal(session.messages[1].status, MESSAGE_STATUS.COMPLETE);
  assert.equal(typeof session.messages[0].createdAt, 'number');

  // 指向不存在的会话时回落到第一个会话
  assert.equal(malformed.activeSessionId, 'x');
});

test('超量历史被裁剪到 20 会话 / 60 消息 / 16000 字符', () => {
  const sessions = [];
  for (let i = 0; i < 30; i += 1) {
    const messages = [];
    for (let j = 0; j < 90; j += 1) {
      messages.push({
        id: 'm' + i + '_' + j,
        role: j % 2 === 0 ? 'user' : 'assistant',
        content: 'c' + j,
      });
    }
    sessions.push({ id: 's' + i, title: '会话' + i, messages });
  }

  const state = deserializeState(JSON.stringify({ activeSessionId: 's5', sessions }));
  assert.equal(state.sessions.length, LIMITS.MAX_SESSIONS);
  assert.equal(state.activeSessionId, 's5');

  const first = state.sessions[0];
  assert.equal(first.messages.length, LIMITS.MAX_MESSAGES_PER_SESSION);
  assert.equal(first.messages[0].content, 'c30');
  assert.equal(first.messages[LIMITS.MAX_MESSAGES_PER_SESSION - 1].content, 'c89');

  const huge = 'Z'.repeat(LIMITS.MAX_MESSAGE_CHARS + 1000);
  const truncated = deserializeState(JSON.stringify({
    sessions: [{ id: 'z', messages: [{ role: 'assistant', content: huge }] }],
  }));
  assert.equal(truncated.sessions[0].messages[0].content.length, LIMITS.MAX_MESSAGE_CHARS);
});

/* -------------------------------------- 畸形长用户消息与请求上下文上限回归 */

test('畸形历史中的超长用户消息被裁剪到 6000，请求上下文始终不超过 12000', () => {
  const longUser = 'u'.repeat(LIMITS.MAX_INPUT_CHARS + 4000);
  const state = deserializeState(JSON.stringify({
    activeSessionId: 's1',
    sessions: [{
      id: 's1',
      messages: [
        { id: 'u1', role: 'user', content: longUser },
        { id: 'a1', role: 'assistant', content: 'A'.repeat(LIMITS.MAX_MESSAGE_CHARS) },
      ],
    }],
  }));

  const messages = getSession(state, 's1').messages;
  assert.equal(messages[0].content.length, LIMITS.MAX_INPUT_CHARS);
  assert.equal(messages[1].content.length, LIMITS.MAX_MESSAGE_CHARS);

  const context = buildRequestContext(state, { sessionId: 's1' });
  const total = context.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total <= LIMITS.MAX_CONTEXT_CHARS);
  assert.ok(context.length <= LIMITS.MAX_CONTEXT_MESSAGES);
  assert.equal(context[context.length - 1].role, 'user');
  assert.equal(context[context.length - 1].content.length, LIMITS.MAX_INPUT_CHARS);
  assert.equal(context[context.length - 1].content, 'u'.repeat(LIMITS.MAX_INPUT_CHARS));
});

test('未归一化的超长用户消息进入请求上下文时仍被限制在 12000 字符内', () => {
  const state = {
    version: 1,
    activeSessionId: 's1',
    sessions: [{
      id: 's1',
      title: 'x',
      createdAt: 0,
      updatedAt: 0,
      messages: [
        { id: 'u1', role: 'user', content: 'x'.repeat(30000) },
        { id: 'a1', role: 'assistant', content: '好的' },
      ],
    }],
  };

  const context = buildRequestContext(state);
  const total = context.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(total <= LIMITS.MAX_CONTEXT_CHARS);
  assert.ok(context.length <= LIMITS.MAX_CONTEXT_MESSAGES);

  const last = context[context.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content.length, LIMITS.MAX_CONTEXT_CHARS);
  assert.equal(last.content, 'x'.repeat(LIMITS.MAX_CONTEXT_CHARS));

  for (const message of context) {
    assert.ok(message.content.length > 0);
    assert.ok(message.role === 'user' || message.role === 'assistant');
  }
});

/* --------------------------------------------------------- 重复 message.id 隔离 */

test('跨会话重复的 message.id 在归一化时被改写为唯一值，写入不会串到别的会话', () => {
  const state = deserializeState(JSON.stringify({
    activeSessionId: 'x',
    sessions: [
      { id: 'x', messages: [{ id: 'dup', role: 'assistant', content: 'X 的回答', status: 'generating' }] },
      { id: 'y', messages: [{ id: 'dup', role: 'assistant', content: 'Y 的回答', status: 'generating' }] },
    ],
  }));

  const xId = getSession(state, 'x').messages[0].id;
  const yId = getSession(state, 'y').messages[0].id;
  assert.notEqual(xId, yId);

  const next = appendAssistantDelta(state, yId, '，追加');
  assert.equal(getSession(next, 'y').messages[0].content, 'Y 的回答，追加');
  assert.equal(getSession(next, 'x').messages[0].content, 'X 的回答');
  assert.equal(getSession(next, 'x').messages[0].id, xId);
});

test('同一会话内重复的 message.id 也会被改写为唯一值', () => {
  const state = deserializeState(JSON.stringify({
    sessions: [{
      id: 's1',
      messages: [
        { id: 'same', role: 'user', content: '第一条' },
        { id: 'same', role: 'assistant', content: '第二条' },
      ],
    }],
  }));

  const messages = getSession(state, 's1').messages;
  assert.equal(messages.length, 2);
  assert.notEqual(messages[0].id, messages[1].id);
  assert.equal(messages[0].content, '第一条');
  assert.equal(messages[1].content, '第二条');
});

/* ---------------------------------------------------------------- 其他细节 */

test('getActiveSession / getSessionMessages 跟随激活会话', () => {
  let state = createState();
  assert.equal(getActiveSession(state), null);
  assert.deepEqual(getSessionMessages(state), []);
  assert.deepEqual(buildRequestContext(state), []);

  state = fresh();
  state = appendUserMessage(state, '嗨');
  assert.equal(getActiveSession(state).id, 's-1');
  assert.equal(getSessionMessages(state).length, 1);
  assert.equal(getSessionMessages(state, '不存在').length, 0);
});
