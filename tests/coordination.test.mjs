import test from 'node:test';
import assert from 'node:assert/strict';
import { runCoordinatedLocal } from '../src/coordination.mjs';

const task = { projectDirectory: 'synthetic-project', kind: 'rewrite', text: 'synthetic', risk: 'low' };
test('saved off/gpt/go modes stop automatic local inference', async () => {
  for (const mode of ['off', 'gpt', 'go']) {
    const worker = { run: () => assert.fail('local inference must not run') };
    const result = await runCoordinatedLocal(worker, task, async () => ({ ok: true, status: { mode }, blockingCategory: 'mode_disabled' }));
    assert.equal(result.attempts, 0);
    assert.equal(result.status, mode === 'go' ? 'needs_goflow' : 'gpt_required');
  }
});
test('auto mode can use local model while Go login is unavailable', async () => {
  const worker = { run: async (input) => { assert.equal(input.projectDirectory, undefined); return { status: 'local_completed_review_required' }; } };
  const result = await runCoordinatedLocal(worker, task, async () => ({ ok: true, status: { mode: 'auto' }, blockingCategory: 'authorization' }));
  assert.equal(result.status, 'local_completed_review_required');
});
test('explicit local user request can override saved preference but never invalid project', async () => {
  const worker = { run: async () => ({ status: 'local_completed_review_required' }) };
  const explicit = { ...task, explicitLocalRequest: true };
  const result = await runCoordinatedLocal(worker, explicit, async () => ({ ok: true, status: { mode: 'gpt' }, blockingCategory: 'mode_disabled' }));
  assert.equal(result.status, 'local_completed_review_required');
  const invalid = await runCoordinatedLocal({ run: () => assert.fail() }, explicit, async () => ({ ok: false, blockingCategory: 'invalid_project' }));
  assert.equal(invalid.status, 'gpt_required');
});
test('unknown coordination state fails closed for automatic delegation', async () => {
  const result = await runCoordinatedLocal({ run: () => assert.fail() }, task, async () => ({ ok: false, blockingCategory: 'client_disabled' }));
  assert.equal(result.reason, 'coordination_mode_unavailable');
});
