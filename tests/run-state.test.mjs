import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRun, reduceRun, runLabel } from '../web/run-state.mjs';

const PHASES = ['coordinating', 'local', 'go', 'testing', 'reviewing', 'applying', 'waiting'];

const progress = (runId, phase) => ({ runId, type: 'progress', phase });
const receipt = (runId, source, taskId, status) => ({ runId, type: 'receipt', source, taskId, status });

test('createRun returns a fresh, serializable initial state', () => {
  const run = createRun('run-1');
  assert.deepEqual(run, { id: 'run-1', phase: null, steps: [], receipts: [], terminal: null });
  assert.deepEqual(JSON.parse(JSON.stringify(run)), run);

  const other = createRun('run-1');
  assert.notEqual(other, run);
  assert.notEqual(other.steps, run.steps);
  assert.notEqual(other.receipts, run.receipts);
});

test('createRun truncates oversized ids', () => {
  const run = createRun('x'.repeat(500));
  assert.equal(run.id.length, 120);
});

test('every contract phase is accepted and produces a label', () => {
  for (const phase of PHASES) {
    const run = reduceRun(createRun('r'), progress('r', phase));
    assert.equal(run.phase, phase);
    assert.deepEqual(run.steps, [phase]);
    assert.equal(typeof runLabel(run), 'string');
    assert.notEqual(runLabel(run), '未开始');
  }
});

test('steps dedupe consecutive identical phases only', () => {
  let run = createRun('r');
  for (const phase of ['go', 'go', 'go', 'local', 'go', 'go', 'local']) {
    run = reduceRun(run, progress('r', phase));
  }
  assert.deepEqual(run.steps, ['go', 'local', 'go', 'local']);
  assert.equal(run.phase, 'local');
});

test('steps are capped at 30 entries, dropping the oldest', () => {
  let run = createRun('r');
  const model = [];
  for (let i = 0; i < 50; i += 1) {
    const phase = PHASES[i % PHASES.length];
    run = reduceRun(run, progress('r', phase));
    if (model[model.length - 1] !== phase) model.push(phase);
  }
  assert.equal(run.steps.length, 30);
  assert.deepEqual(run.steps, model.slice(-30));
  assert.equal(run.phase, PHASES[49 % PHASES.length]);
});

test('events from another run are ignored', () => {
  const run = reduceRun(createRun('a'), progress('a', 'go'));

  const afterProgress = reduceRun(run, progress('b', 'testing'));
  assert.deepEqual(afterProgress, run);
  assert.equal(afterProgress.phase, 'go');

  const afterReceipt = reduceRun(run, receipt('b', 'local', 't', 'accepted'));
  assert.deepEqual(afterReceipt.receipts, []);
  assert.equal(afterReceipt.phase, 'go');
});

test('incomplete, unknown and invalid events leave the state untouched', () => {
  const run = reduceRun(createRun('a'), progress('a', 'go'));
  const invalid = [
    null,
    undefined,
    42,
    'progress',
    [],
    {},
    { runId: 'a' },
    { runId: 'a', type: 'unknown' },
    { runId: 'a', type: 'progress' },
    { runId: 'a', type: 'progress', phase: 'nope' },
    { runId: 'a', type: 'progress', phase: '' },
    { runId: 'a', type: 'progress', phase: 7 },
    { type: 'progress', phase: 'go' },
    { runId: 7, type: 'progress', phase: 'go' },
    receipt('a', 'local', 't', 'bogus'),
    receipt('a', 'elsewhere', 't', 'accepted'),
    receipt('a', 'local', '', 'accepted'),
    receipt('a', 'local', undefined, 'accepted'),
    receipt('a', 'local', 't'),
  ];

  for (const event of invalid) {
    assert.deepEqual(reduceRun(run, event), run);
  }
});

test('receipts keep only the contract fields', () => {
  const event = receipt('r', 'local', 't1', 'queued');
  event.note = 'ignore me';
  event.extra = { deep: true };

  const run = reduceRun(createRun('r'), event);
  assert.deepEqual(run.receipts, [{ source: 'local', taskId: 't1', status: 'queued' }]);
  assert.equal(run.phase, null);
  assert.equal(run.terminal, null);
  assert.deepEqual(Object.keys(run).sort(), ['id', 'phase', 'receipts', 'steps', 'terminal']);
});

test('receipts are deduped by source+taskId and updated in place', () => {
  let run = createRun('r');
  run = reduceRun(run, receipt('r', 'local', 't1', 'queued'));
  run = reduceRun(run, receipt('r', 'go', 't1', 'accepted'));
  run = reduceRun(run, receipt('r', 'local', 't1', 'reviewed'));
  run = reduceRun(run, receipt('r', 'local', 't2', 'rejected'));

  assert.deepEqual(run.receipts, [
    { source: 'local', taskId: 't1', status: 'reviewed' },
    { source: 'go', taskId: 't1', status: 'accepted' },
    { source: 'local', taskId: 't2', status: 'rejected' },
  ]);
});

test('receipts are capped at 30 entries, dropping the oldest', () => {
  let run = createRun('r');
  for (let i = 0; i < 40; i += 1) {
    run = reduceRun(run, receipt('r', 'local', `t${i}`, 'accepted'));
  }
  assert.equal(run.receipts.length, 30);
  assert.equal(run.receipts[0].taskId, 't10');
  assert.equal(run.receipts[29].taskId, 't39');
});

test('updating an existing receipt past the cap does not evict others', () => {
  let run = createRun('r');
  for (let i = 0; i < 30; i += 1) {
    run = reduceRun(run, receipt('r', 'go', `t${i}`, 'queued'));
  }
  run = reduceRun(run, receipt('r', 'go', 't0', 'reviewed'));

  assert.equal(run.receipts.length, 30);
  assert.equal(run.receipts[0].taskId, 't0');
  assert.equal(run.receipts[0].status, 'reviewed');
});

test('receipts never change the phase nor complete a run', () => {
  let run = createRun('r');
  for (const status of ['accepted', 'reviewed', 'queued', 'rejected']) {
    run = reduceRun(run, receipt('r', 'local', `t-${status}`, status));
  }
  assert.equal(run.terminal, null);
  assert.equal(run.phase, null);
  assert.deepEqual(run.steps, []);
  assert.equal(run.receipts.length, 4);
});

test('done, error and stopped move the run to an irreversible terminal state', () => {
  const cases = [
    ['done', 'completed'],
    ['error', 'failed'],
    ['stopped', 'stopped'],
  ];

  for (const [type, terminal] of cases) {
    const active = reduceRun(createRun('r'), progress('r', 'testing'));
    const finished = reduceRun(active, { runId: 'r', type });

    assert.equal(finished.terminal, terminal);
    assert.equal(finished.phase, 'testing');
    assert.deepEqual(finished.steps, ['testing']);

    assert.deepEqual(reduceRun(finished, progress('r', 'go')), finished);
    assert.deepEqual(reduceRun(finished, receipt('r', 'go', 't', 'accepted')), finished);
    assert.deepEqual(reduceRun(finished, { runId: 'r', type: 'error' }), finished);
    assert.deepEqual(reduceRun(finished, { runId: 'other', type: 'done' }), finished);
  }
});

test('terminal state is reported by runLabel', () => {
  const active = reduceRun(createRun('r'), progress('r', 'reviewing'));
  assert.equal(runLabel(reduceRun(active, { runId: 'r', type: 'done' })), '已完成');
  assert.equal(runLabel(reduceRun(active, { runId: 'r', type: 'error' })), '已失败');
  assert.equal(runLabel(reduceRun(active, { runId: 'r', type: 'stopped' })), '已停止');
});

test('runLabel returns the readable Chinese label of the current phase', () => {
  const expected = {
    coordinating: '协调中',
    local: '本地处理中',
    go: 'Go 处理中',
    testing: '测试中',
    reviewing: '评审中',
    applying: '应用中',
    waiting: '等待中',
  };

  for (const [phase, label] of Object.entries(expected)) {
    const run = reduceRun(createRun('r'), progress('r', phase));
    assert.equal(runLabel(run), label);
  }

  assert.equal(runLabel(createRun('r')), '未开始');
  assert.equal(runLabel(null), '未开始');
  assert.equal(runLabel({ phase: 'nope' }), '未开始');
});

test('reduceRun never mutates the supplied state', () => {
  const initial = createRun('r');
  const snapshot = JSON.parse(JSON.stringify(initial));

  const stepped = reduceRun(initial, progress('r', 'local'));
  const withReceipt = reduceRun(stepped, receipt('r', 'local', 't1', 'queued'));
  const finished = reduceRun(withReceipt, { runId: 'r', type: 'done' });

  assert.deepEqual(initial, snapshot);
  assert.notEqual(stepped, initial);
  assert.notEqual(withReceipt, stepped);
  assert.notEqual(finished, withReceipt);
  assert.notEqual(stepped.steps, initial.steps);
  assert.notEqual(withReceipt.receipts, stepped.receipts);
  assert.notEqual(finished.steps, withReceipt.steps);
  assert.notEqual(finished.receipts, withReceipt.receipts);

  assert.deepEqual(stepped.steps, ['local']);
  assert.deepEqual(withReceipt.receipts, [{ source: 'local', taskId: 't1', status: 'queued' }]);
});

test('stored values are copies, not aliases of the input event', () => {
  const event = receipt('r', 'local', 't1', 'queued');
  const run = reduceRun(createRun('r'), event);
  assert.notEqual(run.receipts[0], event);

  event.status = 'rejected';
  event.taskId = 'mutated';
  assert.equal(run.receipts[0].status, 'queued');
  assert.equal(run.receipts[0].taskId, 't1');

  const next = reduceRun(run, receipt('r', 'go', 't2', 'accepted'));
  assert.notEqual(next.receipts[0], run.receipts[0]);
  assert.equal(next.receipts[0].status, 'queued');
  assert.deepEqual(next.receipts[1], { source: 'go', taskId: 't2', status: 'accepted' });
});

test('oversized task ids are truncated', () => {
  const run = reduceRun(createRun('r'), receipt('r', 'local', 'y'.repeat(500), 'accepted'));
  assert.equal(run.receipts[0].taskId.length, 120);
});

test('final states stay JSON serializable', () => {
  let run = createRun('r');
  run = reduceRun(run, progress('r', 'applying'));
  run = reduceRun(run, receipt('r', 'go', 't', 'accepted'));
  run = reduceRun(run, { runId: 'r', type: 'done' });

  const clone = JSON.parse(JSON.stringify(run));
  assert.deepEqual(clone, run);
  assert.deepEqual(Object.keys(clone).sort(), ['id', 'phase', 'receipts', 'steps', 'terminal']);
});
