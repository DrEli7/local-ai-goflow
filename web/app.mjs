import * as chat from './chat-state.mjs';
import { createRun, reduceRun, runLabel } from './run-state.mjs';

// Browser I/O stays here; the server owns Codex sessions and task evidence.
const $ = (id) => document.getElementById(id);
const app = $('app'), input = $('composer-input'), list = $('message-list');
const STORAGE = 'local-ai-goflow-chat-v2', LEGACY_STORAGE = 'local-ai-goflow-chat-v1';
const errors = {
  local_busy: '本地模型正在处理另一个请求，请稍后继续。',
  local_model_unavailable: '本地模型尚未就绪，当前任务没有自动换用其他模型。',
  local_service_unavailable: '本地模型连接中断，请检查 Ollama 后继续。',
  invalid_messages: '对话超出了输入范围，请新建聊天或缩短输入。',
  request_too_large: '输入过长，请缩短后再发送。',
  codex_unavailable: 'Codex 会话服务尚未就绪，请点“重新连接”。',
  codex_login_required: '需要现有 Codex 的 ChatGPT 登录。完成登录后可在这里重新连接。',
  chatgpt_login_required: '需要现有 Codex 的 ChatGPT 登录。完成登录后可在这里重新连接。',
  account_not_chatgpt: '当前 Codex 账户不是 ChatGPT 登录，自动分工暂不可用。',
  orchestrator_unavailable: 'Codex 自动分工服务尚未就绪，请点“重新连接”。',
  codex_timeout: '本轮等待超时。后续请继续原任务，先核实已经完成的步骤。',
  run_busy: '已有任务正在运行，请先等待或停止该任务。',
  busy: '已有任务正在运行，请先等待或停止该任务。',
  invalid_project: '当前工作目录不可用，请新建聊天后重新选择目录。',
  project_required: '请先选择工作目录。',
  invalid_session: '此聊天的后台会话不可用，请新建聊天继续。',
  session_project_mismatch: '此聊天已绑定其他目录，请新建聊天后选择目录。',
  approval_expired: '本次确认已失效，请查看任务的最新状态。',
  invalid_response: '无法提交这次确认，请查看最新任务状态。',
  invalid_origin: '页面来源验证失败，请重新打开本机聊天入口。',
  session_project_locked: '此聊天已绑定工作目录，请新建聊天后选择其他项目。',
  stale_approval: '本次确认已失效，后台不会再次应用这份确认。请查看最新状态。',
  unsupported_approval: '本窗口无法完整展示或处理这类额外许可，已拒绝操作并中断本轮。请缩小任务后继续。',
  codex_turn_failed: 'Codex 本轮执行未完成。继续原任务时会先核实已有任务和文件状态。',
  codex_disconnected: 'Codex 连接已中断。本轮未完成，继续前会先核实已有执行结果。',
  codex_not_installed: '未找到 Codex 原生程序，请确认已安装 Codex 桌面应用。',
  coordinator_state_invalid: '本机自动分工登记状态不可用，请检查 state/chat 中的服务状态。',
};
const RECEIPT_STATUSES = {
  accepted: 'GPT 已审核并接受', reviewed: 'GPT 已完成审核',
  rejected: 'GPT 审核未通过', queued: '已排队',
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
function toast(message) { notice.textContent = message; notice.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => notice.classList.remove('visible'), 5500); }
const safeText = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';
let state = chat.createState();
const projectsBySession = new Map(), autoMessages = new Set(), runs = new Map(), pendingByMessage = new Map(), errorsByMessage = new Map();
let job = null, connected = false, checking = false, projects = [], defaultProjectId = '', projectLoading = false;

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw && raw.length <= 4500000) {
      const saved = JSON.parse(raw); state = chat.deserializeState(saved.chat);
      const sessions = new Set(state.sessions.map(session => session.id));
      const messages = new Set(state.sessions.flatMap(session => session.messages.map(message => message.id)));
      for (const [id, projectId] of Object.entries(saved.projects || {}).slice(0, 20)) if (sessions.has(id) && typeof projectId === 'string') projectsBySession.set(id, projectId.slice(0, 200));
      for (const id of Array.isArray(saved.autoMessages) ? saved.autoMessages.slice(0, 1200) : []) if (messages.has(id)) autoMessages.add(id);
      for (const [id, value] of Object.entries(saved.runs || {}).slice(0, 1200)) {
        if (!messages.has(id) || !value || typeof value !== 'object' || typeof value.id !== 'string') continue;
        let run = createRun(value.id);
        for (const phase of (Array.isArray(value.steps) ? value.steps : []).slice(0, 50)) run = reduceRun(run, { type: 'progress', runId: run.id, phase });
        for (const receipt of (Array.isArray(value.receipts) ? value.receipts : []).slice(-30)) run = reduceRun(run, { ...receipt, type: 'receipt', runId: run.id });
        const terminal = { completed: 'done', failed: 'error', stopped: 'stopped' }[value.terminal];
        if (terminal) run = reduceRun(run, { type: terminal, runId: run.id });
        if (!run.terminal) run = reduceRun(run, { type: 'stopped', runId: run.id });
        runs.set(id, run);
      }
    } else {
      const legacy = localStorage.getItem(LEGACY_STORAGE);
      if (legacy && legacy.length <= 4500000) state = chat.deserializeState(legacy);
    }
  } catch { toast('浏览器暂时无法读取历史，本次仍可聊天。'); }
  for (const session of state.sessions) for (const message of session.messages) if (message.status === 'generating') state = chat.abortAssistantMessage(state, message.id);
  if (!state.activeSessionId) state = chat.createSession(state);
}
restore();

function persist() {
  const sessionIds = new Set(state.sessions.map(session => session.id));
  const messageIds = new Set(state.sessions.flatMap(session => session.messages.map(message => message.id)));
  for (const id of projectsBySession.keys()) if (!sessionIds.has(id)) projectsBySession.delete(id);
  for (const id of autoMessages) if (!messageIds.has(id)) autoMessages.delete(id);
  for (const collection of [runs, pendingByMessage, errorsByMessage]) for (const id of collection.keys()) if (!messageIds.has(id)) collection.delete(id);
  try {
    localStorage.setItem(STORAGE, JSON.stringify({ chat: JSON.parse(chat.serializeState(state)), projects: Object.fromEntries(projectsBySession), autoMessages: [...autoMessages], runs: Object.fromEntries(runs) }));
  } catch { toast('历史保存失败，可能是本机浏览器空间已满；当前对话仍在窗口中。'); }
}
function closeSidebar() { app.classList.remove('sidebar-open'); $('sidebar-backdrop').hidden = true; $('sidebar-toggle').setAttribute('aria-expanded', 'false'); }
function projectForSession(session = chat.getActiveSession(state)) { return projectsBySession.get(session?.id) || defaultProjectId; }
function renderStatus() {
  app.dataset.state = job ? 'busy' : 'idle'; $('status').dataset.state = job ? 'busy' : connected ? 'idle' : 'error';
  const pending = job && pendingByMessage.get(job.messageId);
  $('status-text').textContent = job ? (pending?.some(item => !item.resolved) ? '等待确认' : '任务进行中') : checking ? '连接中…' : connected ? 'Codex 已连接' : 'Codex 未连接';
  $('send').hidden = Boolean(job); $('stop').hidden = !job;
  $('send').disabled = Boolean(job) || !input.value.trim() || !connected || !projects.some(project => project.id === projectForSession()); input.disabled = Boolean(job);
}
function renderProjects() {
  const active = chat.getActiveSession(state), locked = Boolean(active?.messages.length || job), selected = projectForSession(active), select = $('project-select');
  const fragment = document.createDocumentFragment();
  for (const project of projects) { const option = element('option', '', project.name); option.value = project.id; fragment.append(option); }
  if (!projects.length) { const option = element('option', '', projectLoading ? '正在读取项目…' : '工作目录不可用'); option.value = ''; fragment.append(option); }
  else if (!projects.some(project => project.id === selected) && selected) { const option = element('option', '', '原工作目录不可用'); option.value = selected; fragment.append(option); }
  select.replaceChildren(fragment); select.value = selected; select.disabled = locked || projectLoading || !projects.length;
  $('project-add').disabled = locked || projectLoading; $('project-add').hidden = locked;
  const project = projects.find(item => item.id === selected);
  $('project-path').textContent = (project?.path || '默认使用独立工作目录') + (locked ? ' · 此聊天已绑定目录' : ' · 可在首条消息前更改'); $('project-path').title = project?.path || '';
  if (locked) $('project-form').hidden = true;
}
function renderHistory() {
  const fragment = document.createDocumentFragment();
  for (const session of [...state.sessions].reverse()) {
    const item = element('li', 'session-list__item' + (session.id === state.activeSessionId ? ' is-active' : ''));
    item.append(button(session.title, 'session-list__button', () => { stop(); state = chat.switchSession(state, session.id); closeSidebar(); persist(); render(); }, '打开会话：' + session.title));
    item.append(button('×', 'session-list__delete', () => { stop(); state = chat.deleteSession(state, session.id); if (!state.sessions.length) state = chat.createSession(state); persist(); render(); }, '删除会话：' + session.title)); fragment.append(item);
  }
  $('session-list').replaceChildren(fragment);
}
function textBlocks(parent, text) {
  const parts = text.split('```');
  for (let index = 0; index < parts.length; index++) {
    if (index % 2) { const pre = element('pre', 'code-block'), code = element('code', '', parts[index].replace(/^[A-Za-z0-9_+#.-]*\n/, '')); pre.append(code); parent.append(pre); }
    else parent.append(document.createTextNode(parts[index]));
  }
}
async function postJson(path, body, signal) {
  const response = await fetch(path, { method: 'POST', signal, credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Local-Chat': '1' }, body: JSON.stringify(body) });
  if (!response.ok) { let code; try { code = (await response.json()).error; } catch { /* fixed fallback */ } throw new Error(errors[code] || '本机服务暂时不可用，请稍后继续。'); }
  return response;
}
async function respond(item, answer, current) {
  if (job !== current || item.submitting || item.resolved) return;
  item.submitting = true; item.error = ''; renderMessages();
  try { await postJson('/api/respond', { sessionId: current.sessionId, id: item.id, ...answer }, current.controller.signal); item.submitted = true; }
  catch (failure) { if (job === current) { item.submitting = false; item.error = failure.message || '提交失败，请重试。'; } }
  if (job === current) renderMessages();
}
function renderPending(item, current) {
  const card = element('section', 'pending-card'); card.setAttribute('aria-label', item.kind === 'approval' ? '本次操作确认' : '补充信息');
  card.append(element('h3', 'pending-card__title', item.title || (item.kind === 'approval' ? '需要你确认本次操作' : '需要补充信息')));
  if (item.detail) card.append(element('pre', 'pending-card__detail', item.detail));
  if (!current || item.resolved) { card.append(element('p', 'pending-card__note', item.resolved ? '已处理' : '本轮已结束，此确认已失效')); return card; }
  const disabled = item.submitting || item.submitted;
  if (item.kind === 'question') {
    for (const question of item.questions) {
      const field = element('label', 'pending-question'); field.append(element('span', 'pending-question__label', question.question));
      const answer = element('textarea', 'pending-question__input'); answer.rows = 2; answer.maxLength = 4000; answer.value = item.answers[question.id] || ''; answer.disabled = disabled;
      answer.addEventListener('input', () => { item.answers[question.id] = answer.value; }); field.append(answer);
      if (question.options?.length) {
        const options = element('div', 'pending-options');
        for (const option of question.options) { const pick = button(option.label, 'pending-option', () => { item.answers[question.id] = option.label; answer.value = option.label; answer.focus(); }); pick.disabled = disabled; if (option.description) pick.title = option.description; options.append(pick); } field.append(options);
      }
      card.append(field);
    }
    const submit = button(item.submitted ? '已提交，等待继续' : '提交回答', 'btn btn--primary', () => {
      if (!item.questions.every(question => typeof item.answers[question.id] === 'string' && item.answers[question.id].trim())) { toast('请为每个问题输入回答，也可以填写自己的答案。'); return; }
      respond(item, { answers: { ...item.answers } }, current);
    }); submit.disabled = disabled; card.append(submit);
  } else {
    const actions = element('div', 'pending-actions'), accept = button(item.submitted ? '已提交，等待继续' : '允许本次', 'btn btn--primary', () => respond(item, { decision: 'accept' }, current)), decline = button('拒绝本次', 'btn btn--ghost', () => respond(item, { decision: 'decline' }, current));
    accept.disabled = disabled; decline.disabled = disabled; actions.append(accept, decline); card.append(actions, element('p', 'pending-card__note', '此选择仅针对上方这一项操作。'));
  }
  if (item.error) card.append(element('p', 'pending-card__error', item.error)); return card;
}
function renderRun(message) {
  if (!autoMessages.has(message.id)) return null;
  const run = runs.get(message.id), panel = element('section', 'run-panel'); panel.setAttribute('aria-label', '任务执行与审核记录');
  const status = message.status === 'generating' ? (run?.phase ? runLabel(run) : '正在连接 Codex') : message.status === 'complete' ? '本轮已完成' : message.status === 'aborted' ? '本轮已停止' : '本轮未完成';
  panel.append(element('p', 'run-panel__phase', status));
  if (run?.receipts.length) {
    const receipts = element('ul', 'run-receipts');
    for (const receipt of run.receipts) {
      const item = element('li', 'run-receipt'); item.append(element('span', 'run-receipt__source', receipt.source === 'local' ? '本地模型' : 'OpenCode Go'), element('span', 'run-receipt__status', RECEIPT_STATUSES[receipt.status] || receipt.status));
      const task = element('code', 'run-receipt__id', receipt.taskId); task.title = '真实任务 ID'; item.append(task); receipts.append(item);
    }
    panel.append(receipts);
  } else if (message.status === 'complete') panel.append(element('p', 'run-panel__note', '本轮未返回本地 / Go 任务收据。'));
  if (errorsByMessage.has(message.id)) panel.append(element('p', 'run-panel__error', errorsByMessage.get(message.id)));
  const current = job?.messageId === message.id ? job : null;
  for (const item of pendingByMessage.get(message.id) || []) if (!item.resolved) panel.append(renderPending(item, current)); return panel;
}
function renderMessages() {
  const messages = chat.getSessionMessages(state); $('welcome').hidden = messages.length > 0;
  const nearBottom = $('messages').scrollHeight - $('messages').scrollTop - $('messages').clientHeight < 150, fragment = document.createDocumentFragment();
  for (const [index, message] of messages.entries()) {
    const item = element('li', 'message message--' + message.role); item.dataset.status = message.status;
    item.append(element('div', 'message__role', message.role === 'user' ? '你' : autoMessages.has(message.id) ? 'Codex · 自动分工' : '助手（历史记录）'));
    const bubble = element('div', 'message__bubble'); textBlocks(bubble, message.content || (message.status === 'generating' ? '已收到，正在处理…' : '')); item.append(bubble);
    if (message.role === 'assistant') {
      const run = renderRun(message); if (run) item.append(run); const actions = element('div', 'message-actions');
      if (message.content) actions.append(button('复制', 'text-button', async () => { try { await navigator.clipboard.writeText(message.content); toast('已复制'); } catch { toast('复制失败，请选中文字后复制。'); } }, '复制助手回复'));
      if (message.status === 'aborted') actions.append(element('span', 'message__note', '已停止；再次提问会保留当前上下文'));
      if (message.status === 'failed') actions.append(element('span', 'message__note', '本轮未完成；已执行步骤不会自动重发'));
      if (index === messages.length - 1 && ['aborted', 'failed'].includes(message.status)) actions.append(button('继续原任务', 'text-button', () => { input.value = '请继续上一个未完成任务，先核实已有任务与文件状态，不要重复执行已完成步骤。'; input.focus(); renderStatus(); }));
      item.append(actions);
    }
    fragment.append(item);
  }
  list.replaceChildren(fragment); if (nearBottom || !job) $('messages').scrollTop = $('messages').scrollHeight;
}
function render() { renderHistory(); renderProjects(); renderMessages(); renderStatus(); }
function stop() {
  if (!job) return; const previous = job; job = null; previous.controller.abort();
  const run = runs.get(previous.messageId); if (run) runs.set(previous.messageId, reduceRun(run, { type: 'stopped', runId: run.id }));
  state = chat.abortAssistantMessage(state, previous.messageId); persist(); render(); input.focus();
}
function progress(event, current) {
  if (job !== current) return;
  let run = runs.get(current.messageId);
  if (!run && typeof event.runId === 'string') run = createRun(event.runId);
  if (run && event.runId === run.id) { run = reduceRun(run, event); runs.set(current.messageId, run); if (event.type === 'receipt') persist(); }
  const pending = pendingByMessage.get(current.messageId);
  if (event.type === 'pending' && ['approval', 'question'].includes(event.kind) && typeof event.id === 'string') {
    if (!pending.some(item => item.id === event.id) && pending.length < 12) {
      const questions = (Array.isArray(event.questions) ? event.questions : []).slice(0, 12).filter(question => question && typeof question.id === 'string' && typeof question.question === 'string').map(question => ({
        id: safeText(question.id), question: safeText(question.question, 8000), options: (Array.isArray(question.options) ? question.options : []).slice(0, 20).filter(option => option && typeof option.label === 'string').map(option => ({ label: safeText(option.label, 1000), description: safeText(option.description, 2000) })),
      }));
      pending.push({ id: safeText(event.id), kind: event.kind, title: safeText(event.title, 1000), detail: safeText(event.detail, 64000), questions, answers: Object.create(null), resolved: false, submitting: false, submitted: false });
    }
  }
  if (event.type === 'resolved') { const item = pending.find(value => value.id === event.id); if (item) item.resolved = true; }
  renderMessages(); renderStatus();
}
async function request(body, current) {
  const response = await postJson('/api/auto-chat', body, current.controller.signal);
  if (!response.body || !response.headers.get('content-type')?.startsWith('application/x-ndjson')) throw new Error('本机服务返回了无法识别的响应。');
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', final = null, bytes = 0;
  const consume = (line) => {
    if (!line.trim()) return; const event = JSON.parse(line);
    if (event.error) throw new Error(errors[event.error] || '本轮未完成。你可以继续原任务，先核实已有执行结果。');
    if (final) throw new Error('任务响应格式异常。');
    if (typeof event.delta === 'string' && job === current) { state = chat.appendAssistantDelta(state, current.messageId, event.delta); renderMessages(); }
    if (event.type) progress(event, current);
    if (event.done === true && typeof event.content === 'string' && event.content.length <= 16000) final = event;
  };
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) { buffer += decoder.decode(); break; }
      bytes += value.byteLength; if (bytes > 2 * 1024 * 1024) throw new Error('任务事件超过窗口上限，已停止接收；继续前请先核实任务状态。');
      buffer += decoder.decode(value, { stream: true }); let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 1); }
      if (buffer.length > 128 * 1024) throw new Error('任务响应格式异常。');
    }
    if (buffer.trim()) consume(buffer); if (!final) throw new Error('本轮连接未完整结束，已保留收到的内容。继续前请核实任务状态。'); return final;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function send() {
  if (job) return; const text = input.value, checked = chat.validateInput(text);
  if (!checked.ok) { toast(checked.error === 'too-long' ? '每条消息最多 6000 个字符。' : '请先输入消息。'); return; }
  if (!connected) { toast('Codex 尚未连接，请点“重新连接”后发送。'); return; }
  const active = chat.getActiveSession(state), projectId = projectForSession(active);
  if (!projects.some(project => project.id === projectId)) { toast('请先选择可用的工作目录。'); return; }
  projectsBySession.set(active.id, projectId); state = chat.appendUserMessage(state, text); state = chat.beginAssistantMessage(state);
  const session = chat.getActiveSession(state), messageId = session.messages.at(-1)?.id; if (!messageId || session.messages.at(-1).role !== 'assistant') return;
  autoMessages.add(messageId); pendingByMessage.set(messageId, []);
  let messages = chat.buildRequestContext(state); messages = messages.slice(0, messages.findLastIndex(message => message.role === 'user') + 1);
  const current = { controller: new AbortController(), messageId, sessionId: session.id }; job = current; input.value = ''; persist(); render();
  try {
    const result = await request({ sessionId: session.id, projectId, messages }, current); if (job !== current) return;
    state = chat.completeAssistantMessage(state, messageId, { content: result.content });
    const run = runs.get(messageId); if (run) runs.set(messageId, reduceRun(run, { type: 'done', runId: run.id }));
    if (result.truncated) toast('已达到本次回复长度上限，可以继续追问。');
  } catch (failure) {
    if (job !== current) return;
    state = current.controller.signal.aborted ? chat.abortAssistantMessage(state, messageId) : chat.failAssistantMessage(state, messageId);
    const run = runs.get(messageId); if (run) runs.set(messageId, reduceRun(run, { type: 'error', runId: run.id }));
    errorsByMessage.set(messageId, failure.message || '本轮未完成。'); if (!current.controller.signal.aborted) toast(errorsByMessage.get(messageId));
  } finally { if (job === current) { job = null; persist(); render(); input.focus(); } }
}
async function checkStatus() {
  if (checking) return; checking = true; renderStatus();
  try {
    const response = await fetch('/api/status', { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) }), status = await response.json();
    connected = response.ok && status.app === 'local-ai-goflow-chat' && status.orchestrator?.available === true && status.orchestrator.account === 'chatgpt';
    $('status').title = connected ? '使用现有 ChatGPT 登录的 Codex 协调任务' : (errors[status.orchestrator?.reason] || 'Codex 自动分工服务未就绪');
  } catch { connected = false; $('status').title = '本机聊天服务连接失败'; }
  checking = false; renderStatus();
}
async function loadProjects() {
  if (projectLoading) return; projectLoading = true; renderProjects();
  try {
    const response = await fetch('/api/projects', { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new Error('工作目录列表未就绪，请重新连接。'); const value = await response.json();
    projects = (Array.isArray(value.projects) ? value.projects : []).slice(0, 100).filter(project => project && typeof project.id === 'string' && typeof project.name === 'string' && typeof project.path === 'string').map(project => ({ id: project.id.slice(0, 200), name: project.name.slice(0, 200), path: project.path.slice(0, 1024) }));
    defaultProjectId = typeof value.defaultProjectId === 'string' ? value.defaultProjectId : projects[0]?.id || '';
    for (const session of state.sessions) if (session.messages.length && !projectsBySession.has(session.id)) projectsBySession.set(session.id, defaultProjectId); persist();
  } catch (failure) { toast(failure.message || '无法读取工作目录。'); }
  projectLoading = false; renderProjects(); renderStatus();
}

$('composer').addEventListener('submit', event => { event.preventDefault(); send(); });
input.maxLength = 6000; input.rows = 2; input.addEventListener('input', renderStatus);
input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); } });
$('stop').addEventListener('click', stop);
$('new-chat').addEventListener('click', () => {
  stop(); if (!chat.canCreateSession(state)) { toast('最多保存 20 个会话，请先删除不需要的历史。'); return; }
  if (chat.getActiveSession(state)?.messages.length) state = chat.createSession(state); closeSidebar(); persist(); render(); input.focus();
});
$('sidebar-toggle').addEventListener('click', () => { const open = app.classList.toggle('sidebar-open'); $('sidebar-backdrop').hidden = !open; $('sidebar-toggle').setAttribute('aria-expanded', String(open)); });
$('sidebar-backdrop').addEventListener('click', closeSidebar);
document.querySelectorAll('[data-prompt]').forEach(node => node.addEventListener('click', () => { input.value = node.dataset.prompt; input.focus(); renderStatus(); }));
$('project-select').addEventListener('change', () => {
  const active = chat.getActiveSession(state); if (active?.messages.length || job) { renderProjects(); return; }
  if (projects.some(project => project.id === $('project-select').value)) projectsBySession.set(active.id, $('project-select').value); persist(); renderProjects(); renderStatus();
});
$('project-add').addEventListener('click', () => { if (job || chat.getActiveSession(state)?.messages.length) return; $('project-form').hidden = false; $('project-directory').focus(); });
$('project-cancel').addEventListener('click', () => { $('project-form').hidden = true; });
$('project-form').addEventListener('submit', async event => {
  event.preventDefault(); const active = chat.getActiveSession(state); if (job || active?.messages.length) return;
  const path = $('project-directory').value.trim(); if (!path) { toast('请填写本机项目的完整路径。'); return; } $('project-confirm').disabled = true;
  try {
    const response = await postJson('/api/projects', { path }, AbortSignal.timeout(15000)), value = await response.json(), project = value.project;
    if (!project || typeof project.id !== 'string' || typeof project.name !== 'string' || typeof project.path !== 'string') throw new Error('工作目录注册结果无效。');
    if (!projects.some(item => item.id === project.id)) projects.push({ id: project.id.slice(0, 200), name: project.name.slice(0, 200), path: project.path.slice(0, 1024) });
    if (chat.getActiveSession(state)?.id === active.id && !chat.getActiveSession(state).messages.length && !job) projectsBySession.set(active.id, project.id);
    $('project-form').hidden = true; $('project-directory').value = ''; persist(); renderProjects(); renderStatus();
  } catch (failure) { toast(failure.message || '目录注册失败，请确认路径存在。'); } finally { $('project-confirm').disabled = false; }
});
const reconnect = button('重新连接', 'text-button', () => { checkStatus(); loadProjects(); }); $('status').append(reconnect);
let clearArmed = false;
const clear = button('清空窗口历史', 'text-button', () => {
  if (!clearArmed) { clearArmed = true; clear.textContent = '再次点击确认清空'; setTimeout(() => { clearArmed = false; clear.textContent = '清空窗口历史'; }, 4000); return; }
  stop(); state = chat.createSession(chat.createState()); projectsBySession.clear(); autoMessages.clear(); runs.clear(); pendingByMessage.clear(); errorsByMessage.clear();
  try { localStorage.removeItem(STORAGE); localStorage.removeItem(LEGACY_STORAGE); } catch { toast('无法清除浏览器存储，请检查浏览器设置。'); }
  clearArmed = false; clear.textContent = '清空窗口历史'; persist(); render();
});
document.querySelector('.sidebar__foot').prepend(clear);
document.querySelector('.sidebar__note').textContent = '窗口历史保存在本机。需求会交给使用 ChatGPT 登录的 Codex；本地模型与 Go 按规则接收所需内容。清空窗口历史不会删除项目文件或后台任务记录。';
const footer = element('p', 'composer-note', '本地处理简单任务 · Go 实现普通编码 · GPT 协调审核　｜　沿用本机 Codex 权限，需要确认的操作会在此窗口询问'); $('composer').append(footer);
window.addEventListener('pagehide', stop);
render(); checkStatus(); loadProjects(); setInterval(checkStatus, 30000); input.focus();
