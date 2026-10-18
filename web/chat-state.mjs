/**
 * chat-state.mjs —— 聊天会话纯状态模块（无 DOM / 无网络 / 无文件与本地存储访问）
 *
 * 供控制器使用的公共接口：
 *   常量   LIMITS、MESSAGE_STATUS、DEFAULT_TITLE
 *   状态   createState()、normalizeState(raw)、serializeState(state)、deserializeState(json)
 *   查询   getSession(state, id?)、getActiveSession(state)、getSessionMessages(state, id?)、canCreateSession(state)
 *   会话   createSession、switchSession、deleteSession、clearSession、renameSession
 *   消息   validateInput(text)、appendUserMessage、beginAssistantMessage、appendAssistantDelta、
 *          completeAssistantMessage、abortAssistantMessage、failAssistantMessage、retryLastGeneration
 *   请求   buildRequestContext(state, { sessionId }) -> [{ role, content }]
 *
 * 约定：写操作一律返回新的状态对象（不可变更新）；非法输入或找不到目标时原样返回旧状态。
 * 控制器负责 DOM 渲染、流式 HTTP 适配与本地持久化，本模块不做任何 I/O。
 */

export const LIMITS = Object.freeze({
  MAX_SESSIONS: 20,
  MAX_MESSAGES_PER_SESSION: 60,
  MAX_MESSAGE_CHARS: 16000,
  MAX_INPUT_CHARS: 6000,
  MAX_CONTEXT_MESSAGES: 30,
  MAX_CONTEXT_CHARS: 12000,
});

export const MESSAGE_STATUS = Object.freeze({
  GENERATING: 'generating',
  COMPLETE: 'complete',
  ABORTED: 'aborted',
  FAILED: 'failed',
});

export const DEFAULT_TITLE = '新聊天';

const STATE_VERSION = 1;
const VALID_STATUSES = Object.freeze(['generating', 'complete', 'aborted', 'failed']);

let idSequence = 0;

function nextId(prefix) {
  idSequence += 1;
  return prefix + '_' + Date.now().toString(36) + '_' + idSequence.toString(36);
}

function toTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return Date.now();
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) : text;
}

function isState(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.sessions);
}

function cloneState(state) {
  return {
    version: state.version,
    activeSessionId: state.activeSessionId,
    sessions: state.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: Array.isArray(session.messages)
        ? session.messages.map((message) => Object.assign({}, message))
        : [],
    })),
  };
}

function findSessionRef(state, sessionId) {
  return state.sessions.find((session) => session.id === sessionId) || null;
}

function findMessageRef(state, messageId) {
  for (const session of state.sessions) {
    for (const message of session.messages) {
      if (message.id === messageId) return { session, message };
    }
  }
  return null;
}

function sanitizeTitle(title) {
  if (typeof title !== 'string') return DEFAULT_TITLE;
  const trimmed = title.trim();
  return trimmed ? trimmed.slice(0, 60) : DEFAULT_TITLE;
}

function deriveTitle(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 20) : DEFAULT_TITLE;
}

function pushMessage(session, message) {
  session.messages.push(message);
  const overflow = session.messages.length - LIMITS.MAX_MESSAGES_PER_SESSION;
  if (overflow > 0) session.messages.splice(0, overflow);
}

export function createState() {
  return { version: STATE_VERSION, activeSessionId: null, sessions: [] };
}

export function getSession(state, sessionId) {
  if (!isState(state)) return null;
  if (typeof sessionId === 'string') return findSessionRef(state, sessionId);
  if (!state.activeSessionId) return null;
  return findSessionRef(state, state.activeSessionId);
}

export function getActiveSession(state) {
  return getSession(state, undefined);
}

export function getSessionMessages(state, sessionId) {
  const session = getSession(state, sessionId);
  return session ? session.messages : [];
}

export function canCreateSession(state) {
  return isState(state) && state.sessions.length < LIMITS.MAX_SESSIONS;
}

export function createSession(state, options = {}) {
  const base = isState(state) ? state : createState();
  if (base.sessions.length >= LIMITS.MAX_SESSIONS) return base;
  const timestamp = toTimestamp(options.now);
  const used = new Set(base.sessions.map((session) => session.id));
  const id = typeof options.id === 'string' && options.id && !used.has(options.id)
    ? options.id
    : nextId('s');
  const next = cloneState(base);
  next.sessions.push({
    id,
    title: sanitizeTitle(options.title),
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
  });
  next.activeSessionId = id;
  return next;
}

export function switchSession(state, sessionId) {
  const base = isState(state) ? state : createState();
  if (typeof sessionId !== 'string') return base;
  if (!findSessionRef(base, sessionId)) return base;
  if (base.activeSessionId === sessionId) return base;
  const next = cloneState(base);
  next.activeSessionId = sessionId;
  return next;
}

export function deleteSession(state, sessionId) {
  const base = isState(state) ? state : createState();
  const index = base.sessions.findIndex((session) => session.id === sessionId);
  if (index < 0) return base;
  const next = cloneState(base);
  next.sessions.splice(index, 1);
  if (next.activeSessionId === sessionId) {
    const fallback = next.sessions[index] || next.sessions[index - 1] || null;
    next.activeSessionId = fallback ? fallback.id : null;
  }
  return next;
}

export function clearSession(state, sessionId, options = {}) {
  const base = isState(state) ? state : createState();
  const session = getSession(base, sessionId);
  if (!session) return base;
  const next = cloneState(base);
  const target = findSessionRef(next, session.id);
  target.messages = [];
  target.updatedAt = toTimestamp(options.now);
  return next;
}

export function renameSession(state, sessionId, title) {
  const base = isState(state) ? state : createState();
  const session = getSession(base, sessionId);
  if (!session) return base;
  const nextTitle = sanitizeTitle(title);
  if (nextTitle === session.title) return base;
  const next = cloneState(base);
  findSessionRef(next, session.id).title = nextTitle;
  return next;
}

export function validateInput(text) {
  if (typeof text !== 'string') return { ok: false, error: 'invalid-type' };
  if (text.trim().length === 0) return { ok: false, error: 'empty' };
  if (text.length > LIMITS.MAX_INPUT_CHARS) return { ok: false, error: 'too-long' };
  return { ok: true, value: text };
}

export function appendUserMessage(state, text, options = {}) {
  const base = isState(state) ? state : createState();
  const session = getSession(base, options.sessionId);
  const checked = validateInput(text);
  if (!session || !checked.ok) return base;
  const timestamp = toTimestamp(options.now);
  const next = cloneState(base);
  const target = findSessionRef(next, session.id);
  pushMessage(target, {
    id: typeof options.id === 'string' && options.id ? options.id : nextId('m'),
    role: 'user',
    content: checked.value,
    status: MESSAGE_STATUS.COMPLETE,
    createdAt: timestamp,
  });
  target.updatedAt = timestamp;
  if (target.title === DEFAULT_TITLE) target.title = deriveTitle(checked.value);
  return next;
}

export function beginAssistantMessage(state, options = {}) {
  const base = isState(state) ? state : createState();
  const session = getSession(base, options.sessionId);
  if (!session) return base;
  const timestamp = toTimestamp(options.now);
  const next = cloneState(base);
  const target = findSessionRef(next, session.id);
  pushMessage(target, {
    id: typeof options.id === 'string' && options.id ? options.id : nextId('m'),
    role: 'assistant',
    content: '',
    status: MESSAGE_STATUS.GENERATING,
    createdAt: timestamp,
  });
  target.updatedAt = timestamp;
  return next;
}

export function appendAssistantDelta(state, messageId, text, options = {}) {
  const base = isState(state) ? state : createState();
  if (typeof messageId !== 'string' || typeof text !== 'string' || text.length === 0) return base;
  const next = cloneState(base);
  const found = findMessageRef(next, messageId);
  if (!found) return base;
  if (found.message.role !== 'assistant' || found.message.status !== MESSAGE_STATUS.GENERATING) return base;
  const room = LIMITS.MAX_MESSAGE_CHARS - found.message.content.length;
  if (room <= 0) return base;
  found.message.content += truncate(text, room);
  found.session.updatedAt = toTimestamp(options.now);
  return next;
}

function finishAssistantMessage(state, messageId, status, options = {}) {
  const base = isState(state) ? state : createState();
  if (typeof messageId !== 'string') return base;
  const next = cloneState(base);
  const found = findMessageRef(next, messageId);
  if (!found || found.message.role !== 'assistant') return base;
  const message = found.message;
  if (typeof options.content === 'string') {
    message.content = truncate(options.content, LIMITS.MAX_MESSAGE_CHARS);
  }
  if (typeof options.append === 'string' && options.append.length > 0) {
    const room = LIMITS.MAX_MESSAGE_CHARS - message.content.length;
    if (room > 0) message.content += truncate(options.append, room);
  }
  message.status = status;
  found.session.updatedAt = toTimestamp(options.now);
  return next;
}

export function completeAssistantMessage(state, messageId, options = {}) {
  return finishAssistantMessage(state, messageId, MESSAGE_STATUS.COMPLETE, options);
}

export function abortAssistantMessage(state, messageId, options = {}) {
  return finishAssistantMessage(state, messageId, MESSAGE_STATUS.ABORTED, options);
}

export function failAssistantMessage(state, messageId, options = {}) {
  return finishAssistantMessage(state, messageId, MESSAGE_STATUS.FAILED, options);
}

/**
 * 重试：绝不重复写入用户消息。
 * 先清掉尾部“空的、未完成”的助手占位，再追加一条新的 generating 助手消息。
 */
export function retryLastGeneration(state, options = {}) {
  const base = isState(state) ? state : createState();
  const session = getSession(base, options.sessionId);
  if (!session) return base;
  if (!session.messages.some((message) => message.role === 'user')) return base;
  const timestamp = toTimestamp(options.now);
  const next = cloneState(base);
  const target = findSessionRef(next, session.id);
  while (target.messages.length > 0) {
    const last = target.messages[target.messages.length - 1];
    if (last.role === 'assistant' && last.status !== MESSAGE_STATUS.COMPLETE && last.content.length === 0) {
      target.messages.pop();
    } else {
      break;
    }
  }
  pushMessage(target, {
    id: typeof options.id === 'string' && options.id ? options.id : nextId('m'),
    role: 'assistant',
    content: '',
    status: MESSAGE_STATUS.GENERATING,
    createdAt: timestamp,
  });
  target.updatedAt = timestamp;
  return next;
}

/**
 * 构造有界请求上下文：
 *   - 只保留 role 与 content；
 *   - 只含 user / assistant；
 *   - 去掉空助手占位（以及任何空内容消息）；
 *   - 最多 30 条、总长最多 12000 UTF-16；
 *   - 始终保留最新一条用户消息（必要时只保留其受支持的前缀）。
 */
export function buildRequestContext(state, options = {}) {
  const session = getSession(state, options.sessionId);
  if (!session) return [];

  const entries = [];
  for (const message of session.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    let content = typeof message.content === 'string' ? message.content : '';
    if (content.length === 0) continue;
    if (content.length > LIMITS.MAX_MESSAGE_CHARS) content = content.slice(0, LIMITS.MAX_MESSAGE_CHARS);
    entries.push({ role: message.role, content });
  }
  if (entries.length === 0) return [];

  let newestUser = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role === 'user') {
      newestUser = i;
      break;
    }
  }

  const picked = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (picked.length >= LIMITS.MAX_CONTEXT_MESSAGES) break;
    const entry = entries[i];
    if (total + entry.content.length > LIMITS.MAX_CONTEXT_CHARS) continue;
    picked.unshift(entry);
    total += entry.content.length;
  }

  // 最新用户消息必须保留；若它本身超出总长上限，则只保留受支持的前缀。
  if (newestUser >= 0 && picked.indexOf(entries[newestUser]) < 0) {
    let target = entries[newestUser];
    if (target.content.length > LIMITS.MAX_CONTEXT_CHARS) {
      target = { role: 'user', content: target.content.slice(0, LIMITS.MAX_CONTEXT_CHARS) };
    }
    while (picked.length > 0 && total + target.content.length > LIMITS.MAX_CONTEXT_CHARS) {
      total -= picked[0].content.length;
      picked.shift();
    }
    while (picked.length >= LIMITS.MAX_CONTEXT_MESSAGES) {
      total -= picked[0].content.length;
      picked.shift();
    }
    picked.unshift(target);
    total += target.content.length;
  }

  return picked;
}

/* ---------- 归一化 / 序列化 ---------- */

function normalizeMessage(raw, usedMessageIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const role = raw.role;
  if (role !== 'user' && role !== 'assistant') return null;
  if (typeof raw.content !== 'string') return null;
  // 用户消息受输入上限约束（6000），助手消息受正文上限约束（16000）
  const maxChars = role === 'user' ? LIMITS.MAX_INPUT_CHARS : LIMITS.MAX_MESSAGE_CHARS;
  // 跨会话 / 会话内重复的消息 ID 会破坏“按 ID 写入”的隔离性，这里统一改写为唯一值。
  let id = typeof raw.id === 'string' && raw.id ? raw.id : null;
  if (id === null || usedMessageIds.has(id)) id = nextId('m');
  usedMessageIds.add(id);
  return {
    id,
    role,
    content: truncate(raw.content, maxChars),
    status:
      role === 'assistant' && VALID_STATUSES.indexOf(raw.status) >= 0
        ? raw.status
        : MESSAGE_STATUS.COMPLETE,
    createdAt: toTimestamp(raw.createdAt),
  };
}

function normalizeSession(raw, usedMessageIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  const messages = [];
  for (const item of rawMessages) {
    const message = normalizeMessage(item, usedMessageIds);
    if (message) messages.push(message);
  }
  const createdAt = toTimestamp(raw.createdAt);
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : nextId('s'),
    title: sanitizeTitle(raw.title),
    createdAt,
    updatedAt: toTimestamp(raw.updatedAt === undefined ? createdAt : raw.updatedAt),
    messages: messages.slice(-LIMITS.MAX_MESSAGES_PER_SESSION),
  };
}

/** 把任意输入归一化为合法的有界状态；永不抛错。 */
export function normalizeState(raw) {
  const state = createState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return state;
  const rawSessions = Array.isArray(raw.sessions) ? raw.sessions : [];
  const usedSessionIds = new Set();
  const usedMessageIds = new Set();
  for (const item of rawSessions) {
    if (state.sessions.length >= LIMITS.MAX_SESSIONS) break;
    const session = normalizeSession(item, usedMessageIds);
    if (!session) continue;
    if (usedSessionIds.has(session.id)) session.id = nextId('s');
    usedSessionIds.add(session.id);
    state.sessions.push(session);
  }
  const requested = typeof raw.activeSessionId === 'string' ? raw.activeSessionId : null;
  if (requested && state.sessions.some((session) => session.id === requested)) {
    state.activeSessionId = requested;
  } else {
    state.activeSessionId = state.sessions.length > 0 ? state.sessions[0].id : null;
  }
  return state;
}

export function serializeState(state) {
  return JSON.stringify(normalizeState(state));
}

/** 从 JSON 恢复状态；坏 JSON / 畸形数据一律降级为安全状态，不抛错。 */
export function deserializeState(json) {
  let raw = null;
  if (typeof json === 'string') {
    try {
      raw = JSON.parse(json);
    } catch {
      raw = null;
    }
  } else if (json && typeof json === 'object') {
    raw = json;
  }
  return normalizeState(raw);
}
