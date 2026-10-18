import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeTrace } from '../src/agent-trace.mjs';

const ZERO_SUMMARY = {
  total: 0,
  reads: 0,
  writes: 0,
  commands: 0,
  failed: 0,
  files: [],
  commandResults: [],
};

test('returns a zero summary for non-array input', () => {
  const inputs = [undefined, null, 42, 'events', {}, true, () => {}, new Set()];

  for (const input of inputs) {
    assert.deepEqual(summarizeTrace(input), ZERO_SUMMARY);
  }
});

test('returns a zero summary for an empty array', () => {
  assert.deepEqual(summarizeTrace([]), ZERO_SUMMARY);
});

test('counts valid file and command events', () => {
  const result = summarizeTrace([
    { tool: 'read_file', ok: true, path: 'a.txt', bytes: 10 },
    { tool: 'write_file', ok: true, path: 'b.txt', bytes: 20 },
    { tool: 'run_command', ok: true, commandId: 'c1', exitCode: 0 },
  ]);

  assert.equal(result.total, 3);
  assert.equal(result.reads, 1);
  assert.equal(result.writes, 1);
  assert.equal(result.commands, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.files, [
    { path: 'a.txt', read: true, written: false, bytes: 10 },
    { path: 'b.txt', read: false, written: true, bytes: 20 },
  ]);
  assert.deepEqual(result.commandResults, [{ id: 'c1', exitCode: 0, ok: true }]);
});

test('accepts zero bytes for a file event', () => {
  const result = summarizeTrace([
    { tool: 'write_file', ok: true, path: 'empty.txt', bytes: 0 },
  ]);

  assert.equal(result.total, 1);
  assert.deepEqual(result.files, [
    { path: 'empty.txt', read: false, written: true, bytes: 0 },
  ]);
});

test('accepts identifiers of exactly 240 UTF-16 code units', () => {
  const path = 'p'.repeat(240);
  const commandId = 'c'.repeat(240);

  const result = summarizeTrace([
    { tool: 'read_file', ok: true, path, bytes: 5 },
    { tool: 'run_command', ok: true, commandId, exitCode: 0 },
  ]);

  assert.equal(result.total, 2);
  assert.equal(result.files[0].path, path);
  assert.equal(result.commandResults[0].id, commandId);
});

test('counts each failed event exactly once', () => {
  const result = summarizeTrace([
    { tool: 'read_file', ok: false, path: 'a.txt', bytes: 1 },
    { tool: 'write_file', ok: true, path: 'b.txt', bytes: 1 },
    { tool: 'run_command', ok: true, commandId: 'c1', exitCode: 3 },
    { tool: 'run_command', ok: false, commandId: 'c2', exitCode: 0 },
    { tool: 'run_command', ok: false, commandId: 'c3', exitCode: 1 },
    { tool: 'run_command', ok: true, commandId: 'c4', exitCode: null },
    { tool: 'run_command', ok: false, commandId: 'c5', exitCode: null },
  ]);

  assert.equal(result.total, 7);
  assert.equal(result.failed, 5);
});

test('marks command results ok only for clean successful commands', () => {
  const result = summarizeTrace([
    { tool: 'run_command', ok: true, commandId: 'a', exitCode: 0 },
    { tool: 'run_command', ok: true, commandId: 'b', exitCode: 1 },
    { tool: 'run_command', ok: true, commandId: 'c', exitCode: null },
    { tool: 'run_command', ok: false, commandId: 'd', exitCode: 0 },
    { tool: 'run_command', ok: false, commandId: 'e', exitCode: 2 },
    { tool: 'run_command', ok: true, commandId: 'f', exitCode: -1 },
  ]);

  assert.deepEqual(result.commandResults, [
    { id: 'a', exitCode: 0, ok: true },
    { id: 'b', exitCode: 1, ok: false },
    { id: 'c', exitCode: null, ok: false },
    { id: 'd', exitCode: 0, ok: false },
    { id: 'e', exitCode: 2, ok: false },
    { id: 'f', exitCode: -1, ok: false },
  ]);
});

test('deduplicates files by path in first-appearance order', () => {
  const result = summarizeTrace([
    { tool: 'write_file', ok: true, path: 'b.js', bytes: 10 },
    { tool: 'read_file', ok: true, path: 'a.js', bytes: 1 },
    { tool: 'read_file', ok: true, path: 'b.js', bytes: 25 },
    { tool: 'write_file', ok: false, path: 'a.js', bytes: 7 },
    { tool: 'read_file', ok: true, path: 'a.js', bytes: 3 },
  ]);

  assert.equal(result.failed, 1);
  assert.equal(result.reads, 3);
  assert.equal(result.writes, 2);
  assert.equal(result.files.length, 2);
  assert.deepEqual(result.files[0], {
    path: 'b.js',
    read: true,
    written: true,
    bytes: 25,
  });
  assert.deepEqual(result.files[1], {
    path: 'a.js',
    read: true,
    written: true,
    bytes: 3,
  });
});

test('ignores individual invalid events', () => {
  const invalidEvents = [
    null,
    undefined,
    42,
    'read_file',
    [],
    true,
    {},
    { tool: 'unknown_tool', ok: true },
    { tool: 'read_file', ok: 'yes', path: 'a', bytes: 1 },
    { tool: 'read_file', ok: 1, path: 'a', bytes: 1 },
    { tool: 'read_file', path: 'a', bytes: 1 },
    { tool: 'read_file', ok: true, path: '', bytes: 1 },
    { tool: 'read_file', ok: true, path: 5, bytes: 1 },
    { tool: 'read_file', ok: true, path: null, bytes: 1 },
    { tool: 'read_file', ok: true, path: 'a'.repeat(241), bytes: 1 },
    { tool: 'read_file', ok: true, path: 'a' },
    { tool: 'read_file', ok: true, path: 'a', bytes: -1 },
    { tool: 'read_file', ok: true, path: 'a', bytes: 1.5 },
    { tool: 'read_file', ok: true, path: 'a', bytes: '1' },
    { tool: 'read_file', ok: true, path: 'a', bytes: null },
    { tool: 'write_file', ok: true, path: 'a', bytes: NaN },
    { tool: 'run_command', ok: true, commandId: '', exitCode: 0 },
    { tool: 'run_command', ok: true, commandId: 'x'.repeat(241), exitCode: 0 },
    { tool: 'run_command', ok: true, commandId: 7, exitCode: 0 },
    { tool: 'run_command', ok: true, commandId: null, exitCode: 0 },
    { tool: 'run_command', open: true, commandId: 'c', exitCode: 0 },
    { tool: 'run_command', ok: true, commandId: 'c', exitCode: 1.5 },
    { tool: 'run_command', ok: true, commandId: 'c', exitCode: '0' },
    { tool: 'run_command', ok: true, commandId: 'c', exitCode: undefined },
    { tool: 'run_command', ok: false, commandId: 'c' },
  ];

  for (const event of invalidEvents) {
    assert.deepEqual(
      summarizeTrace([event]),
      ZERO_SUMMARY,
      `expected zero summary for ${JSON.stringify(event)}`,
    );
  }
});

test('ignores invalid events while counting valid ones', () => {
  const result = summarizeTrace([
    { tool: 'read_file', ok: true, path: 'ok.txt', bytes: 4 },
    { tool: 'read_file', ok: true, path: 'bad.txt', bytes: -2 },
    { tool: 'run_command', ok: true, commandId: 'c', exitCode: 0 },
    { tool: 'run_command', ok: true, commandId: '', exitCode: 0 },
    'nope',
    null,
    17,
  ]);

  assert.equal(result.total, 2);
  assert.equal(result.reads, 1);
  assert.equal(result.writes, 0);
  assert.equal(result.commands, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.files, [
    { path: 'ok.txt', read: true, written: false, bytes: 4 },
  ]);
  assert.deepEqual(result.commandResults, [{ id: 'c', exitCode: 0, ok: true }]);
});

test('processes at most the first 64 events', () => {
  const events = [];
  for (let index = 0; index < 70; index += 1) {
    events.push({ tool: 'read_file', ok: true, path: `p${index}`, bytes: index });
  }

  const result = summarizeTrace(events);

  assert.equal(result.total, 64);
  assert.equal(result.reads, 64);
  assert.equal(result.files.length, 64);
  assert.equal(result.files[0].path, 'p0');
  assert.equal(result.files[63].path, 'p63');
  assert.equal(
    result.files.some((file) => file.path === 'p64'),
    false,
  );
});

test('counts invalid events toward the 64-event window', () => {
  const events = new Array(64).fill(null);
  events.push({ tool: 'read_file', ok: true, path: 'too-late.txt', bytes: 1 });

  const result = summarizeTrace(events);

  assert.deepEqual(result, ZERO_SUMMARY);
});

test('does not mutate its input', () => {
  const events = [
    { tool: 'read_file', ok: true, path: 'a.txt', bytes: 1, meta: { deep: true } },
    { tool: 'run_command', ok: false, commandId: 'cmd', exitCode: 2, meta: { deep: true } },
    { tool: 'write_file', ok: true, path: 'a.txt', bytes: 9 },
  ];
  const snapshot = structuredClone(events);

  const result = summarizeTrace(events);

  assert.deepEqual(events, snapshot);
  assert.notEqual(result.files[0], events[0]);
  assert.equal(result.files[0].path, 'a.txt');
  assert.equal(result.files[0].bytes, 9);
});

test('handles frozen input objects', () => {
  const events = Object.freeze([
    Object.freeze({ tool: 'write_file', ok: true, path: 'frozen.txt', bytes: 2 }),
    Object.freeze({ tool: 'run_command', ok: true, commandId: 'cmd', exitCode: 0 }),
  ]);

  const result = summarizeTrace(events);

  assert.equal(result.total, 2);
  assert.equal(result.files[0].path, 'frozen.txt');
  assert.equal(result.files[0].written, true);
});

test('does not copy extra fields from events', () => {
  const result = summarizeTrace([
    { tool: 'read_file', ok: true, path: 'a.txt', bytes: 1, secret: 'x', meta: { deep: true } },
    { tool: 'run_command', ok: true, commandId: 'c', exitCode: 0, secret: 'y' },
  ]);

  assert.deepEqual(Object.keys(result).sort(), [
    'commandResults',
    'commands',
    'failed',
    'files',
    'reads',
    'total',
    'writes',
  ]);
  assert.deepEqual(Object.keys(result.files[0]).sort(), [
    'bytes',
    'path',
    'read',
    'written',
  ]);
  assert.deepEqual(Object.keys(result.commandResults[0]).sort(), [
    'exitCode',
    'id',
    'ok',
  ]);
});

test('returns JSON-serializable and independent structures', () => {
  const events = [
    { tool: 'read_file', ok: true, path: 'a.txt', bytes: 1 },
    { tool: 'run_command', ok: true, commandId: 'c', exitCode: 0 },
  ];

  const first = summarizeTrace(events);
  const second = summarizeTrace(events);

  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  assert.notEqual(second.files, first.files);
  assert.notEqual(second.files[0], first.files[0]);
  assert.notEqual(second.commandResults, first.commandResults);
  assert.notEqual(second.commandResults[0], first.commandResults[0]);
});
