import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffMetadata } from '../src/handoff-metadata.mjs';

const SPLIT_ACTION =
  'GPT must keep the critical core and route independent ordinary feature packages through GoFlow';

const DEFAULT_ACTION =
  'GPT should use existing GoFlow tools only for authorized bounded code tasks';

const OUTPUT_KEYS = ['executionBackend', 'splitRequired', 'nextAction'];

test('exposes the public function signature', () => {
  assert.equal(typeof handoffMetadata, 'function');
  assert.equal(handoffMetadata.length, 2);
});

test('returns exactly the three public keys and nothing more', () => {
  const result = handoffMetadata('opencode', { executor: 'gpt', splitRequired: true });

  assert.deepEqual(Object.keys(result), OUTPUT_KEYS);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

test('preserves only the known execution backend values', () => {
  assert.equal(handoffMetadata('opencode', {}).executionBackend, 'opencode');
  assert.equal(handoffMetadata('deepseek-harness', {}).executionBackend, 'deepseek-harness');
});

test('missing, unknown and non-string statuses become null', () => {
  const unknownStatuses = [
    undefined,
    null,
    '',
    ' ',
    'OPENCODE',
    'OpenCode',
    'opencode ',
    ' opencode',
    'deepseek_harness',
    'deepseek-harness ',
    'gpt',
    'goflow',
    0,
    1,
    -1,
    Number.NaN,
    true,
    false,
    {},
    [],
    ['opencode'],
    () => 'opencode',
  ];

  for (const status of unknownStatuses) {
    assert.equal(
      handoffMetadata(status, {}).executionBackend,
      null,
      'status ' + String(status) + ' must not be accepted',
    );
  }
});

test('splitRequired is true only for a gpt executor with the boolean true', () => {
  assert.equal(handoffMetadata('opencode', { executor: 'gpt', splitRequired: true }).splitRequired, true);
  assert.equal(
    handoffMetadata('deepseek-harness', { executor: 'gpt', splitRequired: true }).splitRequired,
    true,
  );
  assert.equal(handoffMetadata(null, { executor: 'gpt', splitRequired: true }).splitRequired, true);
});

test('splitRequired is false for legacy, non-gpt and non-boolean routes', () => {
  const cases = [
    undefined,
    null,
    {},
    { executor: 'gpt' },
    { executor: 'gpt', splitRequired: false },
    { executor: 'gpt', splitRequired: 'true' },
    { executor: 'gpt', splitRequired: 1 },
    { executor: 'gpt', splitRequired: null },
    { executor: 'gpt', splitRequired: undefined },
    { executor: 'gpt', splitRequired: {} },
    { executor: 'GPT', splitRequired: true },
    { executor: 'goflow', splitRequired: true },
    { executor: undefined, splitRequired: true },
    { executor: [], splitRequired: true },
    { splitRequired: true },
    'gpt',
    42,
    true,
    [],
    ['gpt'],
  ];

  for (const route of cases) {
    assert.equal(handoffMetadata('opencode', route).splitRequired, false);
  }
});

test('nextAction is the fixed split instruction whenever a split is required', () => {
  const result = handoffMetadata('opencode', { executor: 'gpt', splitRequired: true });

  assert.equal(result.splitRequired, true);
  assert.equal(result.nextAction, SPLIT_ACTION);
  assert.equal(Object.keys(result).length, 3);
});

test('nextAction is the default instruction in every other case', () => {
  const routes = [undefined, null, {}, { executor: 'gpt' }, { executor: 'goflow' }, 'gpt', 1, []];

  for (const route of routes) {
    const result = handoffMetadata('opencode', route);

    assert.equal(result.splitRequired, false);
    assert.equal(result.nextAction, DEFAULT_ACTION);
  }
});

test('nextAction is never taken from the caller input', () => {
  const result = handoffMetadata('opencode', {
    executor: 'gpt',
    splitRequired: true,
    nextAction: 'caller supplied action',
    action: 'caller supplied action',
    reason: 'caller supplied reason',
  });

  assert.equal(result.nextAction, SPLIT_ACTION);
  assert.deepEqual(Object.keys(result), OUTPUT_KEYS);
});

test('never copies arbitrary input fields into the output', () => {
  const result = handoffMetadata(
    { name: 'opencode', value: 'deepseek-harness', toString: () => 'opencode' },
    {
      executor: 'gpt',
      splitRequired: true,
      action: SPLIT_ACTION,
      reason: DEFAULT_ACTION,
      permission: true,
      authority: 'all',
      route: 'opencode',
    },
  );

  assert.deepEqual(result, {
    executionBackend: null,
    splitRequired: true,
    nextAction: SPLIT_ACTION,
  });
  assert.deepEqual(Object.keys(result), OUTPUT_KEYS);
});

test('does not mutate the supplied inputs', () => {
  const status = 'deepseek-harness';
  const route = Object.freeze({ executor: 'gpt', splitRequired: true, action: 'x', reason: 'y' });
  const fallbackRoute = Object.freeze({ executor: 'goflow', action: 'x', reason: 'y' });

  handoffMetadata(status, route);
  handoffMetadata(status, fallbackRoute);
  handoffMetadata(status, { executor: 'gpt', splitRequired: true });

  assert.equal(status, 'deepseek-harness');
  assert.deepEqual(route, { executor: 'gpt', splitRequired: true, action: 'x', reason: 'y' });
  assert.deepEqual(fallbackRoute, { executor: 'goflow', action: 'x', reason: 'y' });
});

test('handles exotic but bounded input shapes safely', () => {
  const nullProtoRoute = Object.create(null);
  nullProtoRoute.executor = 'gpt';
  nullProtoRoute.splitRequired = true;

  assert.deepEqual(handoffMetadata('opencode', nullProtoRoute), {
    executionBackend: 'opencode',
    splitRequired: true,
    nextAction: SPLIT_ACTION,
  });

  assert.deepEqual(handoffMetadata(new String('opencode'), new String('gpt')), {
    executionBackend: null,
    splitRequired: false,
    nextAction: DEFAULT_ACTION,
  });
});

test('returns a fresh plain object on every call', () => {
  const first = handoffMetadata('opencode', { executor: 'gpt', splitRequired: true });
  const second = handoffMetadata('opencode', { executor: 'gpt', splitRequired: true });

  assert.notEqual(first, second);
  assert.deepEqual(first, second);
});
