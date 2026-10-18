/**
 * web/run-state.mjs
 *
 * Pure, dependency-free and I/O-free reducer for a single chat run lifecycle.
 *
 * Public API:
 *   createRun(id)           -> fresh, JSON serializable run state
 *   reduceRun(state, event) -> next state; the input state is never mutated
 *   runLabel(state)         -> human readable Chinese label of the current stage
 *
 * Contract kept in state objects: id, phase, steps, receipts, terminal.
 */

const MAX_STEPS = 30;
const MAX_RECEIPTS = 30;
const MAX_STRING = 120;

const IDLE_LABEL = '未开始';

const PHASE_LABELS = new Map([
  ['coordinating', '协调中'],
  ['local', '本地处理中'],
  ['go', 'Go 处理中'],
  ['testing', '测试中'],
  ['reviewing', '评审中'],
  ['applying', '应用中'],
  ['waiting', '等待中'],
]);

const TERMINAL_LABELS = new Map([
  ['completed', '已完成'],
  ['failed', '已失败'],
  ['stopped', '已停止'],
]);

const PHASE_SET = new Set(PHASE_LABELS.keys());
const SOURCE_SET = new Set(['local', 'go']);
const STATUS_SET = new Set(['accepted', 'reviewed', 'queued', 'rejected']);
const TERMINAL_BY_TYPE = new Map([
  ['done', 'completed'],
  ['error', 'failed'],
  ['stopped', 'stopped'],
]);

function clampString(value) {
  if (typeof value !== 'string') return '';
  return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneStepList(steps) {
  return Array.isArray(steps) ? steps.slice() : [];
}

function cloneReceipt(receipt) {
  const source = isPlainObject(receipt) ? receipt.source : undefined;
  const taskId = isPlainObject(receipt) ? receipt.taskId : undefined;
  const status = isPlainObject(receipt) ? receipt.status : undefined;
  return { source, taskId, status };
}

function cloneReceiptList(receipts) {
  return Array.isArray(receipts) ? receipts.map(cloneReceipt) : [];
}

function withState(state, patch) {
  return {
    id: state.id,
    phase: Object.prototype.hasOwnProperty.call(patch, 'phase') ? patch.phase : state.phase,
    steps: Object.prototype.hasOwnProperty.call(patch, 'steps') ? patch.steps : cloneStepList(state.steps),
    receipts: Object.prototype.hasOwnProperty.call(patch, 'receipts')
      ? patch.receipts
      : cloneReceiptList(state.receipts),
    terminal: Object.prototype.hasOwnProperty.call(patch, 'terminal') ? patch.terminal : state.terminal,
  };
}

function applyProgress(state, phase) {
  if (typeof phase !== 'string' || !PHASE_SET.has(phase)) return state;

  const steps = cloneStepList(state.steps);
  if (steps[steps.length - 1] !== phase) {
    steps.push(phase);
    while (steps.length > MAX_STEPS) steps.shift();
  }

  return withState(state, { phase, steps });
}

function applyReceipt(state, source, taskId, status) {
  if (typeof source !== 'string' || !SOURCE_SET.has(source)) return state;
  if (typeof status !== 'string' || !STATUS_SET.has(status)) return state;
  if (typeof taskId !== 'string') return state;

  const safeTaskId = clampString(taskId);
  if (safeTaskId.length === 0) return state;

  const receipts = cloneReceiptList(state.receipts);
  const index = receipts.findIndex(
    (entry) => entry.source === source && entry.taskId === safeTaskId,
  );
  const next = { source, taskId: safeTaskId, status };

  if (index >= 0) {
    receipts[index] = next;
  } else {
    receipts.push(next);
    while (receipts.length > MAX_RECEIPTS) receipts.shift();
  }

  return withState(state, { receipts });
}

/**
 * Creates a fresh run state. The id is copied and length limited.
 */
export function createRun(id) {
  return {
    id: clampString(id),
    phase: null,
    steps: [],
    receipts: [],
    terminal: null,
  };
}

/**
 * Reduces one event into a brand new state.
 *
 * Events that are unknown, incomplete or invalid, events belonging to another
 * run and any event arriving after the terminal state are ignored: the supplied
 * state is returned untouched.
 */
export function reduceRun(state, event) {
  if (!isPlainObject(state)) return state;
  if (state.terminal) return state;
  if (!isPlainObject(event)) return state;
  if (typeof event.runId !== 'string') return state;
  if (clampString(event.runId) !== state.id) return state;

  if (event.type === 'progress') {
    return applyProgress(state, event.phase);
  }

  if (event.type === 'receipt') {
    return applyReceipt(state, event.source, event.taskId, event.status);
  }

  const terminal = TERMINAL_BY_TYPE.get(event.type);
  if (terminal === undefined) return state;

  return withState(state, { terminal });
}

/**
 * Human readable Chinese label of the current stage. Terminal outcomes win
 * over the last recorded phase.
 */
export function runLabel(state) {
  if (isPlainObject(state)) {
    const terminalLabel = TERMINAL_LABELS.get(state.terminal);
    if (terminalLabel !== undefined) return terminalLabel;

    const phaseLabel = PHASE_LABELS.get(state.phase);
    if (phaseLabel !== undefined) return phaseLabel;
  }

  return IDLE_LABEL;
}
