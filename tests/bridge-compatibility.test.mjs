import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGoflowBridge } from '../src/goflow-bridge.mjs';

const response = value => ({ code: 0, stderr: '', stdout: JSON.stringify({
  content: [{ type: 'text', text: JSON.stringify(value) }],
}) });
const status = () => ({ channel: 'opencode-go', version: '1.4.0', runtimeRevision: 'harness-connection-r2',
  executionBackend: 'deepseek-harness', mode: 'auto', providerAllowlist: ['opencode-go'], inferenceAllowed: true,
  billingGuard: { useBalanceDisabledConfirmed: true, activeGoSubscriptionConfirmed: true },
  quota: { fresh: true, category: 'ok', fetchedAt: new Date().toISOString(), quota: {
    reliable: true, available: true, windows: ['rolling', 'weekly', 'monthly'].map(id => ({
      id, percent: 5, status: 'ok', resetAt: new Date(Date.now() + 3600000).toISOString(),
    })),
  } },
});
async function project(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goflow-compat-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

test('ordinary handoff preserves the verified backend and keeps execution guarded', async t => {
  const directory = await project(t), calls = [];
  const bridge = createGoflowBridge({ runner: async (command, args) => {
    calls.push(args[1]);
    return response(args[1] === 'goflow_status' ? status() : {
      executor: 'go', risk: 'low', complexity: 'simple', splitRequired: false,
    });
  } });
  const result = await bridge.planGoflow({ projectDirectory: directory, summary: 'Format a title', risk: 'low', complexity: 'simple' });
  assert.equal(result.ok, true);
  assert.equal(result.status.executionBackend, 'deepseek-harness');
  assert.equal(result.route.splitRequired, false);
  assert.equal(result.cloudInference, false);
  assert.equal(result.cachedEligibilityIsGrant, false);
  assert.deepEqual(calls, ['goflow_status', 'goflow_route']);
});

test('complex handoff retains required package splitting without forwarding raw action text', async t => {
  const directory = await project(t);
  const bridge = createGoflowBridge({ runner: async (command, args) => response(args[1] === 'goflow_status'
    ? status() : { executor: 'gpt', risk: 'high', complexity: 'high', splitRequired: true,
      nextAction: 'synthetic-private-detail', reason: 'synthetic-private-detail' }) });
  const result = await bridge.planGoflow({ projectDirectory: directory, summary: 'Review architecture', risk: 'high', complexity: 'high' });
  assert.equal(result.route.executor, 'gpt');
  assert.equal(result.route.splitRequired, true);
  assert.match(result.nextAction, /independent ordinary feature packages/);
  assert.equal(JSON.stringify(result).includes('synthetic-private-detail'), false);
  assert.equal(result.cloudInference, false);
});
