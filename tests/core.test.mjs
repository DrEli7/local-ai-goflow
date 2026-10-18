import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { LocalWorker, TASK_TYPES } from '../src/core.mjs';

const model = 'qwen3:8b';
const normalTags = { models: [{ name: model, model, details: { family: 'qwen3' } }] };
const input = (kind = 'summarize', extra = {}) => ({ kind, text: '用两句话总结给定内容。', risk: 'low', ...extra });
const reply = (output, extra = {}) => ({
  model, done: true, done_reason: 'stop', response: typeof output === 'string' ? output : JSON.stringify(output),
  prompt_eval_count: 25, eval_count: 9, ...extra,
});

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'local-ai-goflow-core-'));
  t.after(async () => {
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()), 'cleanup stays directly within the test temp root');
    assert.ok(basename(absolute).startsWith('local-ai-goflow-core-'));
    await rm(absolute, { recursive: true, force: true });
  });
  return join(directory, 'state');
}

function ollama(script = [], { tags = normalTags, version = { version: '0.12.5' }, onRequest } = {}) {
  const calls = [];
  const requestJson = async (request) => {
    calls.push(request);
    if (onRequest) await onRequest(request);
    if (request.path === '/api/tags') {
      if (typeof tags === 'function') return tags(request);
      return tags;
    }
    if (request.path === '/api/version') {
      if (version instanceof Error) throw version;
      return version;
    }
    assert.equal(request.path, '/api/generate');
    assert.equal(request.method, 'POST');
    const item = script.shift();
    if (item instanceof Error) throw item;
    if (typeof item === 'function') return item(request);
    assert.notEqual(item, undefined, 'unexpected additional generation request');
    return item;
  };
  return { calls, requestJson, generates: () => calls.filter((call) => call.path === '/api/generate') };
}

async function lines(stateDir) {
  return (await readFile(join(stateDir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
}

test('status checks the exact local model/version without starting a service or writing state', async (t) => {
  const stateDir = await sandbox(t);
  const fake = ollama();
  let starts = 0;
  const worker = new LocalWorker({ stateDir, requestJson: fake.requestJson, startService: async () => { starts += 1; } });
  const status = await worker.status();
  assert.equal(status.available, true);
  assert.equal(status.version, '0.12.5');
  assert.equal(status.endpoint, 'http://127.0.0.1:11434');
  assert.deepEqual(status.queue, { pending: 0, capacity: 4, concurrency: 1 });
  assert.equal(starts, 0);
  assert.equal(fake.generates().length, 0);
  assert.deepEqual(fake.calls.map((call) => call.method), ['GET', 'GET']);
  await assert.rejects(access(stateDir), { code: 'ENOENT' });
});

test('an unavailable optional version does not prevent valid tags from reporting ready', async (t) => {
  const fake = ollama([], { version: new Error('untrusted diagnostic') });
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  const status = await worker.status();
  assert.equal(status.available, true);
  assert.equal(status.version, null);
  assert.ok(!JSON.stringify(status).includes('untrusted diagnostic'));
});

test('successful work has bounded generation settings, a canonical candidate hash, and metadata only', async (t) => {
  const stateDir = await sandbox(t);
  const fake = ollama([reply({ result: '简洁的摘要。' })]);
  const worker = new LocalWorker({ stateDir, requestJson: fake.requestJson });
  const result = await worker.run(input('summarize', { text: 'DO_NOT_LOG_THIS_INPUT', instruction: 'DO_NOT_LOG_THIS_INSTRUCTION' }));
  assert.equal(result.status, 'local_completed_review_required');
  assert.equal(result.attempts, 1);
  assert.equal(result.source, 'Ollama local qwen3:8b');
  assert.equal(result.candidateHash, createHash('sha256').update('{"result":"简洁的摘要。"}').digest('hex'));
  const request = fake.generates()[0];
  assert.equal(request.timeoutMs, 120000);
  assert.equal(request.maxBytes, 131072);
  assert.equal(request.body.model, model);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.think, false);
  assert.equal(request.body.keep_alive, '2m');
  assert.deepEqual(request.body.options, { num_ctx: 4096, num_predict: 768, temperature: 0 });
  assert.equal(request.body.format.additionalProperties, false);
  const raw = await readFile(join(stateDir, 'events.jsonl'), 'utf8');
  for (const secret of ['DO_NOT_LOG_THIS_INPUT', 'DO_NOT_LOG_THIS_INSTRUCTION', '简洁的摘要。']) assert.ok(!raw.includes(secret));
  assert.equal((await lines(stateDir)).length, 1);
  const metrics = await worker.metrics();
  assert.equal(metrics.tasks, 1);
  assert.equal(metrics.modelRequests, 1);
  assert.equal(metrics.locallyCompleted, 1);
  assert.equal(metrics.usage.reportedPromptTokens, 25);
  assert.equal(metrics.usage.reportedCompletionTokens, 9);
  assert.equal(metrics.usage.requestsWithCompleteTokenUsage, 1);
});

test('all seven task kinds validate their promised result shapes', async (t) => {
  const fake = ollama([
    reply({ result: '摘要' }), reply({ result: '改写' }), reply({ result: 'Hello' }),
    reply({ label: '任务', reason: '属于工作安排。' }),
    reply({ data: { title: '项目', count: 2, active: null } }),
    reply({ explanation: '函数返回一个数。' }),
    reply({ tests: 'assert.equal(2, 2)', assumptions: '', code: 'return 2;' }),
  ]);
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  for (const kind of TASK_TYPES) {
    const args = input(kind, {
      ...(kind === 'classify' ? { labels: ['任务', '消息'] } : {}),
      ...(kind === 'extract_json' ? { fields: [
        { name: 'title', type: 'string' }, { name: 'count', type: 'number' }, { name: 'active', type: 'boolean' },
      ] } : {}),
      ...(kind === 'translate' ? { language: 'English' } : {}),
    });
    const result = await worker.run(args);
    assert.equal(result.kind, kind);
    assert.equal(result.status, 'local_completed_review_required');
  }
  const metrics = await worker.metrics();
  assert.equal(metrics.modelRequests, 7);
  assert.equal(metrics.tasks, 7);
});

test('input validation enforces task/string/list/field boundaries before HTTP', async (t) => {
  const fake = ollama();
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  const bad = [
    undefined, {}, input('unknown'), input('summarize', { text: '' }), input('summarize', { text: 'x'.repeat(2401) }),
    input('summarize', { risk: undefined }), input('summarize', { risk: 'medium' }),
    input('summarize', { instruction: 'x'.repeat(401) }), input('translate', { language: 'x'.repeat(41) }),
    input('summarize', { arbitraryPath: 'do-not-read-this' }),
    input('classify'), input('classify', { labels: [] }), input('classify', { labels: ['a', 'a'] }),
    input('classify', { labels: Array.from({ length: 13 }, (_, index) => `${index}`) }),
    input('classify', { labels: ['x'.repeat(41)] }), input('extract_json'),
    input('extract_json', { fields: [{ name: '__proto__', type: 'string' }] }),
    input('extract_json', { fields: [{ name: 'bad.name', type: 'number' }] }),
    input('extract_json', { fields: [{ name: 'a', type: 'object' }] }),
    input('extract_json', { fields: [{ name: 'a', type: 'string', extra: true }] }),
    input('extract_json', { fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'number' }] }),
    input('extract_json', { fields: Array.from({ length: 13 }, (_, index) => ({ name: `field${index}`, type: 'boolean' })) }),
  ];
  for (const args of bad) await assert.rejects(worker.run(args), { message: 'invalid_task_input' });
  assert.equal(fake.calls.length, 0);
});

test('high risk and recognizable credentials are routed to GPT without any HTTP request or secret logs', async (t) => {
  const stateDir = await sandbox(t);
  const fake = ollama();
  const worker = new LocalWorker({ stateDir, requestJson: fake.requestJson });
  const samples = [
    '-----BEGIN PRIVATE KEY-----\nexample\n-----END PRIVATE KEY-----',
    '-----BEGIN RSA PRIVATE KEY-----\nexample',
    'AKIAABCDEFGHIJKLMNOP',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    'api_key = "abcdefghijklmnopqrstuvwxy123456"',
    'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
  ];
  const high = await worker.run(input('code_draft', { risk: 'high' }));
  assert.equal(high.reason, 'high_risk_requires_gpt');
  for (const text of samples) {
    const result = await worker.run(input('summarize', { text }));
    assert.equal(result.status, 'gpt_required');
    assert.equal(result.reason, 'sensitive_input_requires_gpt');
    assert.equal(result.attempts, 0);
  }
  assert.equal(fake.calls.length, 0);
  const log = await readFile(join(stateDir, 'events.jsonl'), 'utf8');
  for (const sample of samples) assert.ok(!log.includes(sample));
});

test('ordinary code mentioning authentication identifiers is permitted as bounded source text', async (t) => {
  const fake = ollama([reply({ explanation: '这里使用占位符配置认证。' })]);
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  const result = await worker.run(input('code_explain', {
    text: 'const api_key = process.env.API_KEY; const headers = { Authorization: "Bearer token" }; // PRIVATE KEY is a term',
  }));
  assert.equal(result.status, 'local_completed_review_required');
});

test('a schema failure gets one grounded repair in the same task, and uses corrected output only', async (t) => {
  const stateDir = await sandbox(t);
  const fake = ollama([reply({ label: 'unknown', reason: '第一版' }), reply({ label: 'work', reason: '安排工作' })]);
  const worker = new LocalWorker({ stateDir, requestJson: fake.requestJson });
  const result = await worker.run(input('classify', { labels: ['work', 'life'] }));
  assert.equal(result.attempts, 2);
  assert.equal(result.output.label, 'work');
  assert.match(fake.generates()[1].body.prompt, /local_output_invalid/);
  assert.match(fake.generates()[1].body.prompt, /unknown/);
  const events = await lines(stateDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].taskId, result.taskId);
  assert.equal(events[0].attempts, 2);
  assert.equal(result.metrics.reportedPromptTokens, 50);
});

test('duplicate keys, overflow, non-JSON numbers, wrappers, extras, and overlong fields never pass', async (t) => {
  for (const raw of [
    '{"result":"one","result":"two"}', '{"result":"one","\\u0072esult":"two"}',
    '{"result":NaN}', '{"result":Infinity}', '{"result":1e309}',
    '```json\n{"result":"wrapped"}\n```', '{"result":"ok","extra":true}',
    JSON.stringify({ result: 'x'.repeat(6001) }), '{"result":"ok",}',
  ]) {
    const fake = ollama([reply(raw), reply(raw)]);
    const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
    const result = await worker.run(input());
    assert.equal(result.status, 'needs_goflow');
    assert.equal(result.reason, 'local_output_invalid');
    assert.equal(result.attempts, 2);
    assert.equal(result.output, undefined);
    assert.equal(result.candidateHash, undefined);
    assert.equal(fake.generates().length, 2);
  }
});

test('extraction rejects duplicate nested keys, wrong primitive types, missing keys, and extras', async (t) => {
  for (const raw of [
    '{"data":{"count":1,"count":2}}', '{"data":{"count":"1"}}', '{"data":{}}',
    '{"data":{"count":1,"other":true}}', '{"data":{"count":1e309}}',
  ]) {
    const fake = ollama([reply(raw), reply(raw)]);
    const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
    const result = await worker.run(input('extract_json', { fields: [{ name: 'count', type: 'number' }] }));
    assert.equal(result.reason, 'local_output_invalid');
    assert.equal(result.attempts, 2);
  }
});

test('length-truncated generation is rejected even when the partial content looks valid JSON', async (t) => {
  const fake = ollama([reply({ result: '看似完整' }, { done_reason: 'length' }), reply({ result: '仍被截断' }, { done_reason: 'length' })]);
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  const result = await worker.run(input());
  assert.equal(result.status, 'needs_goflow');
  assert.equal(result.reason, 'local_output_truncated');
  assert.equal(result.output, undefined);
});

test('one transient connection retry shares the two-request budget and preserves unknown usage', async (t) => {
  const error = Object.assign(new Error('sensitive-raw-network-message'), { code: 'ECONNRESET' });
  const fake = ollama([error, reply({ result: '恢复成功' })]);
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  const result = await worker.run(input());
  assert.equal(result.status, 'local_completed_review_required');
  assert.equal(result.attempts, 2);
  assert.equal(result.metrics.requestsWithoutCompleteTokenUsage, 1);
  assert.equal(result.metrics.requestsWithCompleteTokenUsage, 1);
  assert.ok(!JSON.stringify(result).includes(error.message));
  const metrics = await worker.metrics();
  assert.equal(metrics.modelRequests, 2);
  assert.equal(metrics.usage.requestsWithoutCompleteTokenUsage, 1);
  assert.equal(metrics.usage.reportedPromptTokens, 25);
});

test('transient retry followed by invalid schema cannot trigger a third model request', async (t) => {
  const fake = ollama([Object.assign(new Error('reset'), { code: 'ECONNRESET' }), reply({ invalid: 'shape' })]);
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  const result = await worker.run(input());
  assert.equal(result.status, 'needs_goflow');
  assert.equal(result.attempts, 2);
  assert.equal(fake.generates().length, 2);
});

test('a nontransient error stops immediately and never echoes diagnostics or paths', async (t) => {
  const fake = ollama([new Error('credential=DO_NOT_ECHO C:/private/settings.json')]);
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  const result = await worker.run(input());
  assert.equal(result.reason, 'local_request_failed');
  assert.equal(result.attempts, 1);
  assert.equal(result.metrics.reportedPromptTokens, null);
  assert.equal(result.metrics.reportedCompletionTokens, null);
  assert.ok(!JSON.stringify(result).includes('DO_NOT_ECHO'));
  assert.ok(!JSON.stringify(result).includes('settings.json'));
});

test('run can start the service once after a failed preflight, then verifies tags again', async (t) => {
  let ready = false;
  let starts = 0;
  const fake = ollama([reply({ result: '已启动' })], { tags: () => {
    if (!ready) throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    return normalTags;
  } });
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson,
    startService: async () => { starts += 1; ready = true; } });
  const before = await worker.status();
  assert.equal(before.available, false);
  assert.equal(starts, 0);
  const result = await worker.run(input());
  assert.equal(result.status, 'local_completed_review_required');
  assert.equal(starts, 1);
  assert.equal(fake.calls.filter((call) => call.path === '/api/tags').length, 3);
});

test('failed startup is a fixed failure with no generation or repeated startup', async (t) => {
  let starts = 0;
  const fake = ollama([], { tags: () => { throw new Error('unavailable'); } });
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson,
    startService: async () => { starts += 1; throw new Error('C:/private/path'); } });
  const result = await worker.run(input());
  assert.equal(result.reason, 'local_service_start_failed');
  assert.equal(result.attempts, 0);
  assert.equal(starts, 1);
  assert.equal(fake.generates().length, 0);
});

test('missing, inexact, cloud, and remote-backed models cannot trigger generation or startup', async (t) => {
  const samples = [
    [{ name: 'qwen3:latest' }], [{ name: 'qwen3:8b-cloud' }],
    [{ name: model, model, remote_host: 'https://remote.example' }],
    [{ name: model, remote_model: 'qwen3:8b' }],
    [{ name: model, details: { cloud: true } }],
    [{ name: model, model: 'different:latest' }],
  ];
  for (const models of samples) {
    let starts = 0;
    const fake = ollama([], { tags: { models } });
    const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson,
      startService: async () => { starts += 1; } });
    const result = await worker.run(input());
    assert.equal(result.status, 'needs_goflow');
    assert.equal(result.attempts, 0);
    assert.equal(starts, 0);
    assert.equal(fake.generates().length, 0);
  }
});

test('a generation wrapper must be complete, from the fixed model, and free of remote markers', async (t) => {
  for (const overrides of [{ done: false }, { model: 'other:8b' }, { remote_host: 'https://remote.example' }, { cloud: true }, { response: null }]) {
    const fake = ollama([reply({ result: '无效' }, overrides)]);
    const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
    const result = await worker.run(input());
    assert.equal(result.reason, 'invalid_local_response');
    assert.equal(result.attempts, 1);
    assert.equal(result.output, undefined);
  }
});

test('transport JSON strings are strictly decoded, including duplicate wrapper keys', async (t) => {
  const fake = ollama(['{"model":"qwen3:8b","done":true,"response":"{}","response":"{}"}']);
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  const result = await worker.run(input());
  assert.equal(result.reason, 'local_request_failed');
  assert.equal(result.attempts, 1);
});

test('the queue serializes generation, caps pending work at four, and snapshots queued arguments', async (t) => {
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  let active = 0;
  let maxActive = 0;
  const observedTexts = [];
  const fake = ollama(Array.from({ length: 4 }, (_, index) => async (request) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    observedTexts.push(request.body.prompt);
    if (index === 0) await gate;
    await new Promise((done) => setImmediate(done));
    active -= 1;
    return reply({ result: `结果${index}` });
  }));
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  const queued = input('summarize', { text: 'ORIGINAL_QUEUED_TEXT' });
  const tasks = [worker.run(input()), worker.run(queued), worker.run(input()), worker.run(input())];
  queued.text = 'MUTATED_QUEUED_TEXT';
  await new Promise((done) => setImmediate(done));
  assert.equal((await worker.status()).queue.pending, 4);
  const rejected = await worker.run(input());
  assert.equal(rejected.reason, 'local_queue_full');
  assert.equal(rejected.attempts, 0);
  release();
  const results = await Promise.all(tasks);
  assert.ok(results.every((result) => result.status === 'local_completed_review_required'));
  assert.equal(maxActive, 1);
  assert.equal(observedTexts.length, 4);
  assert.match(observedTexts[1], /ORIGINAL_QUEUED_TEXT/);
  assert.doesNotMatch(observedTexts[1], /MUTATED_QUEUED_TEXT/);
  assert.equal((await worker.status()).queue.pending, 0);
  const metrics = await worker.metrics();
  assert.equal(metrics.tasks, 5);
  assert.equal(metrics.modelRequests, 4);
  assert.equal(metrics.needsGoflow, 1);
});

test('review requires the exact task/hash, is idempotent, and survives restart without retaining feedback', async (t) => {
  const stateDir = await sandbox(t);
  const fake = ollama([reply({ result: '待审草稿' })]);
  const worker = new LocalWorker({ stateDir, requestJson: fake.requestJson });
  const task = await worker.run(input());
  await assert.rejects(worker.review({ taskId: task.taskId, candidateHash: '0'.repeat(64), decision: 'approve', feedback: '候选哈希与当前任务不匹配，应拒绝此次审核。' }), { message: 'unknown_review_candidate' });
  for (const feedback of [undefined, '', '            ', '理由不足', 'x'.repeat(601)]) {
    await assert.rejects(worker.review({ taskId: task.taskId, candidateHash: task.candidateHash, decision: 'approve', feedback }), { message: 'invalid_review_input' });
  }
  const review = { taskId: task.taskId, candidateHash: task.candidateHash, decision: 'approve', feedback: 'DO_NOT_STORE_REVIEW_TEXT' };
  const result = await worker.review(review);
  assert.equal(result.status, 'review_recorded');
  assert.equal(result.feedbackStored, false);
  await worker.review(review);
  await assert.rejects(worker.review({ ...review, decision: 'reject' }), { message: 'review_already_recorded' });
  assert.equal(fake.generates().length, 1);
  const raw = await readFile(join(stateDir, 'events.jsonl'), 'utf8');
  assert.ok(!raw.includes(review.feedback));
  assert.equal((await lines(stateDir)).length, 2);
  const restarted = new LocalWorker({ stateDir, requestJson: fake.requestJson });
  const metrics = await restarted.metrics();
  assert.deepEqual(metrics.reviews, { approved: 1, rejected: 0 });
  await restarted.review(review);
  assert.equal((await lines(stateDir)).length, 2);
});

test('reject records a GPT review and recommends original GoFlow handling without invoking a model', async (t) => {
  const stateDir = await sandbox(t);
  const fake = ollama([reply({ code: 'return null;', tests: '', assumptions: '' })]);
  const worker = new LocalWorker({ stateDir, requestJson: fake.requestJson });
  const task = await worker.run(input('code_draft'));
  await assert.rejects(worker.review({ taskId: task.taskId, candidateHash: task.candidateHash, decision: 'reject' }), { message: 'invalid_review_input' });
  const review = await worker.review({ taskId: task.taskId, candidateHash: task.candidateHash, decision: 'reject', feedback: '代码未满足原任务，需要按原任务修正。' });
  assert.match(review.nextAction, /原 GoFlow/);
  assert.equal(fake.generates().length, 1);
  assert.deepEqual((await worker.metrics()).reviews, { approved: 0, rejected: 1 });
  assert.equal((await lines(stateDir))[1].reviewer, 'GPT');
});

test('missing token usage stays unknown, while task and model request counts remain separate', async (t) => {
  const fake = ollama([reply({ result: '没有用量字段' }, { prompt_eval_count: undefined, eval_count: undefined })]);
  const worker = new LocalWorker({ stateDir: await sandbox(t), requestJson: fake.requestJson });
  await worker.run(input());
  await worker.run(input('summarize', { risk: 'high' }));
  const metrics = await worker.metrics();
  assert.equal(metrics.tasks, 2);
  assert.equal(metrics.modelRequests, 1);
  assert.equal(metrics.gptRequired, 1);
  assert.equal(metrics.usage.reportedPromptTokens, null);
  assert.equal(metrics.usage.reportedCompletionTokens, null);
  assert.equal(metrics.usage.requestsWithoutCompleteTokenUsage, 1);
  assert.match(metrics.accountingNote, /未计算 API 费用或节约百分比/);
});

test('bounded metadata reading tolerates corrupt/oversized lines and reports truncated history', async (t) => {
  const stateDir = await sandbox(t);
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'events.jsonl'), `${'x'.repeat(2 * 1024 * 1024 + 500)}\n{not json}\n`, 'utf8');
  const fake = ollama();
  const worker = new LocalWorker({ stateDir, requestJson: fake.requestJson });
  const metrics = await worker.metrics();
  assert.equal(metrics.tasks, 0);
  assert.equal(metrics.modelRequests, 0);
  assert.equal(metrics.historyTruncated, true);
  assert.equal(metrics.historyReadLimitBytes, 2 * 1024 * 1024);
  assert.equal(fake.calls.length, 0);
});

test('state errors expose a fixed reason without leaking the filesystem location', async (t) => {
  const stateDir = await sandbox(t);
  await writeFile(stateDir, 'state is a file', 'utf8');
  const fake = ollama([reply({ result: '无法持久化' })]);
  const worker = new LocalWorker({ stateDir, requestJson: fake.requestJson });
  await assert.rejects(worker.run(input()), { message: 'local_state_unavailable' });
  assert.equal((await worker.status()).queue.pending, 0);
});
