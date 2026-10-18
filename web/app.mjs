import * as chat from './chat-state.mjs';

// The UI state module is pure. This reviewed adapter owns browser I/O only.
const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/app.css'; document.head.append(style);
const icon = document.createElement('link'); icon.rel = 'icon'; icon.href = '/icon.svg'; document.head.append(icon);
const $ = (id) => document.getElementById(id);
const app = $('app'), input = $('composer-input'), list = $('message-list');
const STORAGE = 'local-ai-goflow-chat-v1';
const errors = {
  local_busy: '本地模型正在处理另一个请求，请稍后重试。',
  local_model_unavailable: '本地模型尚未就绪。请启动 Ollama 并安装 qwen3:8b，再点“重新连接”。',
  local_service_unavailable: '本地模型连接中断，请检查 Ollama 后重试。',
  invalid_local_response: '本地模型回复未完整结束，可以重试。',
  local_timeout: '生成等待时间过长，已停止本次请求，可以重试。',
  local_output_too_large: '本次回复超过长度上限，可以缩小问题后再问。',
  invalid_messages: '对话超出了输入范围，请新建聊天或缩短输入。',
  request_too_large: '输入过长，请缩短后再发送。',
};
const element = (tag, className, text) => {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text !== undefined) node.textContent = text; return node;
};
const button = (text, className, action, label) => {
  const node = element('button', className, text); node.type = 'button';
  if (label) node.setAttribute('aria-label', label); node.addEventListener('click', action); return node;
};
const notice = element('div', 'toast'); notice.setAttribute('role', 'status'); document.body.append(notice);
let toastTimer;
function toast(message) { notice.textContent = message; notice.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => notice.classList.remove('visible'), 4500); }
let state = chat.createState();
try { const raw = localStorage.getItem(STORAGE); if (raw && raw.length <= 4500000) state = chat.deserializeState(raw); }
catch { toast('浏览器暂时无法读取历史，本次仍可聊天。'); }
for (const session of state.sessions) for (const message of session.messages) {
  if (message.status === 'generating') state = chat.abortAssistantMessage(state, message.id);
}
if (!state.activeSessionId) state = chat.createSession(state);
let job = null, connected = false, checking = false;

function persist() {
  try { localStorage.setItem(STORAGE, chat.serializeState(state)); }
  catch { toast('历史保存失败，可能是本机浏览器空间已满；当前对话仍在窗口中。'); }
}
function closeSidebar() { app.classList.remove('sidebar-open'); $('sidebar-backdrop').hidden = true; $('sidebar-toggle').setAttribute('aria-expanded', 'false'); }
function renderStatus() {
  app.dataset.state = job ? 'busy' : 'idle';
  $('status').dataset.state = job ? 'busy' : connected ? 'idle' : 'error';
  $('status-text').textContent = job ? '正在生成…' : checking ? '连接中…' : connected ? '本地已连接' : '模型未连接';
  $('send').hidden = Boolean(job); $('stop').hidden = !job;
  $('send').disabled = Boolean(job) || !input.value.trim(); input.disabled = Boolean(job);
}
function renderHistory() {
  const fragment = document.createDocumentFragment();
  for (const session of [...state.sessions].reverse()) {
    const item = element('li', 'session-list__item' + (session.id === state.activeSessionId ? ' is-active' : ''));
    item.append(button(session.title, 'session-list__button', () => { stop(); state = chat.switchSession(state, session.id); closeSidebar(); persist(); render(); }, '打开会话：' + session.title));
    item.append(button('×', 'session-list__delete', () => { stop(); state = chat.deleteSession(state, session.id); if (!state.sessions.length) state = chat.createSession(state); persist(); render(); }, '删除会话：' + session.title));
    fragment.append(item);
  }
  $('session-list').replaceChildren(fragment);
}
function textBlocks(parent, text) {
  // Code fences improve readability without interpreting HTML or Markdown.
  const parts = text.split('```');
  for (let index = 0; index < parts.length; index++) {
    if (index % 2) {
      const pre = element('pre', 'code-block'); const code = element('code', '', parts[index].replace(/^[A-Za-z0-9_+#.-]*\n/, '')); pre.append(code); parent.append(pre);
    } else parent.append(document.createTextNode(parts[index]));
  }
}
function renderMessages() {
  const messages = chat.getSessionMessages(state);
  $('welcome').hidden = messages.length > 0;
  const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 150;
  const fragment = document.createDocumentFragment();
  for (const [index, message] of messages.entries()) {
    const item = element('li', 'message message--' + message.role); item.dataset.status = message.status;
    item.append(element('div', 'message__role', message.role === 'user' ? '你' : 'Qwen3 8B'));
    const bubble = element('div', 'message__bubble'); textBlocks(bubble, message.content || (message.status === 'generating' ? '正在思考…' : '')); item.append(bubble);
    if (message.role === 'assistant') {
      const actions = element('div', 'message-actions');
      if (message.content) actions.append(button('复制', 'text-button', async () => {
        try { await navigator.clipboard.writeText(message.content); toast('已复制'); } catch { toast('复制失败，请选中文字后复制。'); }
      }, '复制助手回复'));
      if (message.status === 'aborted') actions.append(element('span', 'message__note', '已停止，已保留生成内容'));
      if (message.status === 'failed') actions.append(element('span', 'message__note', '本次生成未完成'));
      if (index === messages.length - 1 && ['aborted', 'failed'].includes(message.status)) actions.append(button('重新生成', 'text-button', () => send(true)));
      item.append(actions);
    }
    fragment.append(item);
  }
  list.replaceChildren(fragment);
  if (nearBottom || !job) $('messages').scrollTop = $('messages').scrollHeight;
}
function render() { renderHistory(); renderMessages(); renderStatus(); }
function stop() {
  if (!job) return;
  const previous = job; job = null; previous.controller.abort();
  state = chat.abortAssistantMessage(state, previous.messageId); persist(); render(); input.focus();
}
async function request(messages, { signal, onDelta }) {
  const response = await fetch('/api/chat', { method: 'POST', signal, credentials: 'omit', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-Local-Chat': '1' }, body: JSON.stringify({ messages }) });
  if (!response.ok) { let code; try { code = (await response.json()).error; } catch { /* generic below */ } throw new Error(errors[code] || '本地服务暂时不可用，请稍后重试。'); }
  if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) throw new Error('本地服务返回了无法识别的响应。');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', final = null, bytes = 0;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.error) throw new Error(errors[event.error] || '生成未完成，请重试。');
    if (final) throw new Error('生成响应格式异常。');
    if (typeof event.delta === 'string') onDelta(event.delta);
    if (event.done === true && typeof event.content === 'string' && event.content.length <= 16000) final = event;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      bytes += value.byteLength; if (bytes > 512 * 1024) throw new Error('本次回复过长，请缩小问题后重试。');
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1); }
      if (buffer.length > 65536) throw new Error('生成响应格式异常。');
    }
    if (buffer.trim()) consume(buffer);
    if (!final) throw new Error('回复未完整结束，已保留收到的内容。');
    return final;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function send(retry = false) {
  if (job) return;
  const text = input.value;
  if (!retry) {
    const checked = chat.validateInput(text);
    if (!checked.ok) { toast(checked.error === 'too-long' ? '每条消息最多 6000 个字符。' : '请先输入消息。'); return; }
    state = chat.appendUserMessage(state, text);
    state = chat.beginAssistantMessage(state);
  } else state = chat.retryLastGeneration(state);
  const session = chat.getActiveSession(state), messageId = session.messages.at(-1)?.id;
  if (!messageId || session.messages.at(-1).role !== 'assistant') return;
  // Regeneration ends the request at the latest user, excluding partial replies.
  let context = chat.buildRequestContext(state);
  const latestUser = context.findLastIndex(message => message.role === 'user');
  context = context.slice(0, latestUser + 1);
  const current = { controller: new AbortController(), messageId, sessionId: session.id }; job = current;
  if (!retry) input.value = '';
  persist(); render();
  try {
    const result = await request(context, { signal: current.controller.signal, onDelta(delta) {
      if (job !== current) return;
      state = chat.appendAssistantDelta(state, messageId, delta); renderMessages();
    } });
    if (job !== current) return;
    state = chat.completeAssistantMessage(state, messageId, { content: result.content });
    if (result.truncated) toast('已达到本次回复长度上限，可以继续追问。');
  } catch (failure) {
    if (job !== current) return;
    state = current.controller.signal.aborted ? chat.abortAssistantMessage(state, messageId) : chat.failAssistantMessage(state, messageId);
    if (!current.controller.signal.aborted) toast(failure.message || '生成失败，请重试。');
  } finally {
    if (job === current) { job = null; persist(); render(); input.focus(); }
  }
}
async function checkStatus() {
  if (checking) return;
  checking = true; renderStatus();
  try {
    const response = await fetch('/api/status', { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) });
    const status = await response.json(); connected = response.ok && status.app === 'local-ai-goflow-chat' && status.available === true;
  } catch { connected = false; }
  checking = false; renderStatus();
}

$('composer').addEventListener('submit', event => { event.preventDefault(); send(); });
input.maxLength = 6000; input.rows = 2; input.addEventListener('input', renderStatus);
input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } });
$('stop').addEventListener('click', stop);
$('new-chat').addEventListener('click', () => {
  stop(); if (!chat.canCreateSession(state)) { toast('最多保存 20 个会话，请先删除不需要的历史。'); return; }
  const active = chat.getActiveSession(state); if (active?.messages.length) state = chat.createSession(state);
  closeSidebar(); persist(); render(); input.focus();
});
$('sidebar-toggle').addEventListener('click', () => { const open = app.classList.toggle('sidebar-open'); $('sidebar-backdrop').hidden = !open; $('sidebar-toggle').setAttribute('aria-expanded', String(open)); });
$('sidebar-backdrop').addEventListener('click', closeSidebar);
document.querySelectorAll('[data-prompt]').forEach(node => node.addEventListener('click', () => { input.value = node.dataset.prompt; input.focus(); renderStatus(); }));
const reconnect = button('重新连接', 'text-button', checkStatus); $('status').append(reconnect);
let clearArmed = false;
const clear = button('清空历史', 'text-button', () => {
  if (!clearArmed) { clearArmed = true; clear.textContent = '再次点击确认清空'; setTimeout(() => { clearArmed = false; clear.textContent = '清空历史'; }, 4000); return; }
  stop(); state = chat.createSession(chat.createState());
  try { localStorage.removeItem(STORAGE); } catch { toast('无法清除浏览器存储，请检查浏览器设置。'); }
  clearArmed = false; clear.textContent = '清空历史'; render();
});
document.querySelector('.sidebar__foot').prepend(clear);
document.querySelector('.sidebar__note').textContent = '对话历史仅保存在本机浏览器。此窗口仅与本地模型对话；项目编码自动分工和 GPT 审核在 Codex 中进行。';
const footer = element('p', 'composer-note', 'Qwen3 8B · 本地运行 · 发送最近的有限上下文，长对话建议新建聊天。'); $('composer').append(footer);
window.addEventListener('pagehide', stop);
render(); checkStatus(); setInterval(checkStatus, 30000); input.focus();
