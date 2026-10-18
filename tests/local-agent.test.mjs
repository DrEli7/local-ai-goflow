import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AgentWorkspace } from '../src/agent-files.mjs';
import { LocalAgent, runSelectedCommand } from '../src/local-agent.mjs';

const calls = (...selected) => ({ model: 'qwen3:8b', done: true,
  message: { role: 'assistant', content: '', tool_calls: selected } });
const tool = (name, args) => ({ function: { name, arguments: args } });
const final = (content = '已生成结果并完成受限检查，等待 GPT 审核。') => ({ model: 'qwen3:8b', done: true,
  message: { role: 'assistant', content } });
const review = result => ({ taskId: result.taskId, candidateHash: result.candidateHash,
  reviewer: 'GPT', decision: 'approve', feedback: '已核对选定输入、候选正文和真实检查结果，内容符合需求。' });
const absent = async path => assert.rejects(access(path), { code: 'ENOENT' });

async function fixture(t, script = []) {
  const parent = resolve(fileURLToPath(new URL('../state/', import.meta.url)));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'local-agent-test-'));
  const projectDirectory = join(root, 'project'), stateDir = join(root, 'agent-state');
  await mkdir(projectDirectory);
  await writeFile(join(projectDirectory, 'notes.txt'), '周三提交文档，周五演示。\n', 'utf8');
  const requests = [], signals = [];
  const agent = new LocalAgent({ stateDir, preflight: async () => {}, chat: async (body, signal) => {
    const index = requests.length; requests.push(structuredClone(body)); signals.push(signal);
    assert.ok(script[index], 'fake chat script must explicitly declare every model response');
    return typeof script[index] === 'function' ? await script[index](body, signal) : structuredClone(script[index]);
  } });
  const args = { projectDirectory, task: '读取 notes.txt，整理到 summary.md，并统计输出文本。',
    readFiles: ['notes.txt'], writeFiles: ['summary.md'],
    commands: [{ id: 'summary_stats', kind: 'text_stats', path: 'summary.md' }], risk: 'low', maxSteps: 8 };
  t.after(async () => {
    // Remove only the exact mkdtemp result under this repository's ignored fixture parent.
    assert.equal(dirname(resolve(root)), parent);
    assert.ok(basename(root).startsWith('local-agent-test-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { root, projectDirectory, stateDir, agent, args, requests, signals };
}

const summarize = [
  calls(tool('read_file', { path: 'notes.txt' })),
  calls(tool('write_file', { path: 'summary.md', content: '- 周三提交文档\n- 周五演示\n' })),
  calls(tool('run_command', { commandId: 'summary_stats' })),
  final(),
];

test('native read/write/command loop produces actual snapshot evidence and applies only after GPT acceptance', async t => {
  const { agent, args, projectDirectory, requests, signals } = await fixture(t, summarize);
  const progress = [], result = await agent.run(args, { progress: event => progress.push(event) });
  assert.equal(result.status, 'local_agent_review_required');
  assert.match(result.taskId, /^[a-f0-9-]{36}$/); assert.match(result.candidateHash, /^[a-f0-9]{64}$/);
  assert.equal(result.source, 'Ollama local qwen3:8b'); assert.equal(result.modelRequests, 4);
  assert.equal(result.outputFiles.length, 1); assert.equal(result.outputFiles[0].path, 'summary.md');
  assert.equal(result.outputFiles[0].content, '- 周三提交文档\n- 周五演示\n');
  assert.equal(result.toolResults[0].content, '周三提交文档，周五演示。\n');
  const command = result.toolResults.find(item => item.tool === 'run_command');
  assert.equal(command.commandId, 'summary_stats'); assert.equal(command.exitCode, 0); assert.equal(command.ok, true);
  assert.equal(JSON.parse(command.stdout).unicodeCodePoints, [...result.outputFiles[0].content].length);
  assert.equal(result.trace.reads, 1); assert.equal(result.trace.writes, 1); assert.equal(result.trace.commands, 1);
  assert.equal(signals.every(signal => signal instanceof AbortSignal), true);
  assert.deepEqual(progress.map(event => event.step), [1, 2, 3, 4]);
  assert.equal(requests.every(body => body.model === 'qwen3:8b' && body.stream === false && body.think === false), true);
  assert.deepEqual(requests[0].tools.map(value => value.function.name), ['read_file', 'write_file', 'run_command']);
  const readEvidence = requests[1].messages.find(message => message.role === 'tool');
  assert.equal(JSON.parse(readEvidence.content).content, '周三提交文档，周五演示。\n');
  await absent(join(projectDirectory, 'summary.md'));
  assert.deepEqual(await agent.task(result.taskId), result);
  const accepted = await agent.review(review(result));
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.candidateHash, result.candidateHash);
  assert.equal(accepted.review.reviewer, 'GPT'); assert.equal(accepted.review.accepted, true);
  assert.equal(accepted.review.feedbackStored, false);
  assert.equal(await readFile(join(projectDirectory, 'summary.md'), 'utf8'), result.outputFiles[0].content);
  assert.equal(await readFile(join(projectDirectory, 'notes.txt'), 'utf8'), '周三提交文档，周五演示。\n');
  await assert.rejects(agent.review(review(result)), { message: 'agent_review_candidate_invalid' });
});

test('GPT rejection preserves the candidate and evidence without writing project files', async t => {
  const { agent, args, projectDirectory } = await fixture(t, summarize);
  const result = await agent.run(args);
  const rejected = await agent.review({ ...review(result), decision: 'reject', feedback: '候选缺少负责人信息，请保留证据，不接受这次结果。' });
  assert.equal(rejected.status, 'rejected'); assert.equal(rejected.review.accepted, false);
  assert.equal(rejected.review.decision, 'reject');
  await absent(join(projectDirectory, 'summary.md'));
  assert.equal((await agent.task(result.taskId)).outputFiles[0].content, result.outputFiles[0].content);
});

test('changed original input blocks acceptance and durably records the failed application', async t => {
  const { agent, args, projectDirectory } = await fixture(t, summarize);
  const result = await agent.run(args);
  await writeFile(join(projectDirectory, 'notes.txt'), '用户已在任务生成后修改原文。');
  await assert.rejects(agent.review(review(result)), { message: 'agent_original_changed' });
  await absent(join(projectDirectory, 'summary.md'));
  const failed = await agent.task(result.taskId);
  assert.equal(failed.status, 'apply_failed'); assert.equal(failed.reason, 'agent_original_changed');
  assert.equal(failed.review.accepted, false);
  await assert.rejects(agent.review(review(result)), { message: 'agent_review_candidate_invalid' });
  assert.equal(await readFile(join(projectDirectory, 'notes.txt'), 'utf8'), '用户已在任务生成后修改原文。');
});

test('candidate snapshot tampering blocks approval and rejection instead of trusting a stale hash', async t => {
  const { agent, args, projectDirectory } = await fixture(t, summarize);
  const result = await agent.run(args);
  await writeFile(join(result.evidenceDirectory, 'workspace', 'summary.md'), '候选已被其他执行者更改。');
  for (const decision of ['approve', 'reject'])
    await assert.rejects(agent.review({ ...review(result), decision }), { message: 'agent_candidate_changed' });
  await absent(join(projectDirectory, 'summary.md'));
  assert.equal((await agent.task(result.taskId)).status, 'local_agent_review_required');
});

test('only exact GPT review fields and matching candidate hashes are accepted', async t => {
  const { agent, args, projectDirectory } = await fixture(t, summarize);
  const result = await agent.run(args), valid = review(result);
  for (const patch of [{ reviewer: 'Qwen3' }, { feedback: 'short' }, { decision: 'maybe' }, { force: true }])
    await assert.rejects(agent.review({ ...valid, ...patch }), { message: 'agent_review_invalid' });
  await assert.rejects(agent.review({ ...valid, candidateHash: 'cd'.repeat(32) }), { message: 'agent_review_candidate_invalid' });
  await absent(join(projectDirectory, 'summary.md'));
});

test('filesystem review lease blocks another agent instance and is never removed by the blocked reviewer', async t => {
  const { agent, args, projectDirectory, stateDir } = await fixture(t, summarize);
  const result = await agent.run(args);
  const lockPath = join(stateDir, 'agent-review.lock'), lease = await open(lockPath, 'wx');
  const other = new LocalAgent({ stateDir, preflight: async () => {}, chat: async () => { throw new Error('must_not_infer'); } });
  try {
    await assert.rejects(other.review(review(result)), { code: 'EEXIST' });
    await access(lockPath); await absent(join(projectDirectory, 'summary.md'));
    assert.equal((await agent.task(result.taskId)).status, 'local_agent_review_required');
  } finally { await lease.close(); await unlink(lockPath); }
  assert.equal((await other.review(review(result))).status, 'accepted');
  assert.equal(await readFile(join(projectDirectory, 'summary.md'), 'utf8'), result.outputFiles[0].content);
});

test('fixed checks use trusted helpers and JavaScript --check never executes a selected script', async t => {
  const { projectDirectory, stateDir } = await fixture(t);
  const marker = join(projectDirectory, 'must-not-exist.txt');
  const contents = {
    'sample.txt': 'A🌿\n',
    'valid.json': '{"items":[1,2],"enabled":true}', 'invalid.json': '{invalid}',
    'valid.csv': '名称,备注\n甲,"有,逗号"\n乙,"第一行\n第二行"\n', 'invalid.csv': 'a,b\n"unterminated\n',
    'syntax.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');\n`,
    'syntax.js': `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`,
    'invalid.mjs': 'const = ;\n',
  };
  for (const [path, content] of Object.entries(contents)) await writeFile(join(projectDirectory, path), content);
  const workspace = await AgentWorkspace.create({ projectDirectory, stateDir, taskId: randomUUID(), readFiles: Object.keys(contents), writeFiles: [] });
  const run = (kind, path) => runSelectedCommand({ id: kind, kind, ...(path ? { path } : {}) }, workspace);
  const stats = await run('text_stats', 'sample.txt');
  assert.equal(stats.exitCode, 0); assert.deepEqual(JSON.parse(stats.stdout), { bytes: 6, unicodeCodePoints: 3, lines: 2 });
  const json = await run('json_validate', 'valid.json');
  assert.equal(json.ok, true); assert.deepEqual(JSON.parse(json.stdout), { valid: true, type: 'object', entries: 2 });
  const csv = await run('csv_stats', 'valid.csv');
  assert.equal(csv.ok, true); assert.deepEqual(JSON.parse(csv.stdout), { rows: 3, dataRows: 2, columns: 2, consistent: true });
  const syntax = await run('javascript_check', 'syntax.mjs');
  assert.equal(syntax.ok, true); assert.equal(syntax.exitCode, 0); await absent(marker);
  const ordinaryJs = await run('javascript_check', 'syntax.js');
  assert.equal(ordinaryJs.ok, true); assert.equal(ordinaryJs.exitCode, 0); await absent(marker);
  const version = await run('node_version');
  assert.equal(version.ok, true); assert.equal(version.stdout, process.version);
  for (const [kind, path] of [['json_validate', 'invalid.json'], ['csv_stats', 'invalid.csv'], ['javascript_check', 'invalid.mjs']]) {
    const failed = await run(kind, path);
    assert.equal(failed.ok, false); assert.notEqual(failed.exitCode, 0);
    assert.equal(failed.stdout, ''); assert.equal(failed.error, 'selected_file_check_failed');
    assert.equal(JSON.stringify(failed).includes(projectDirectory), false);
    assert.equal(JSON.stringify(failed).includes('SyntaxError'), false);
  }
  await assert.rejects(run('execute_shell', 'sample.txt'), { message: 'agent_command_invalid' });
  await assert.rejects(run('text_stats', 'unselected.txt'), { message: 'agent_file_not_selected' });
});

test('failed real command evidence remains a failed check instead of becoming an invented success', async t => {
  const { agent, args } = await fixture(t, [
    calls(tool('read_file', { path: 'notes.txt' })),
    calls(tool('write_file', { path: 'summary.json', content: '{invalid}' })),
    calls(tool('run_command', { commandId: 'json_check' })),
    final('检查失败，需要 GPT 审核。'),
  ]);
  const result = await agent.run({ ...args, writeFiles: ['summary.json'], commands: [{ id: 'json_check', kind: 'json_validate', path: 'summary.json' }] });
  assert.equal(result.status, 'local_agent_review_required');
  const command = result.toolResults.find(item => item.tool === 'run_command');
  assert.equal(command.ok, false); assert.notEqual(command.exitCode, 0); assert.equal(result.trace.failed, 1);
  assert.equal((await agent.review({ ...review(result), decision: 'reject' })).status, 'rejected');
});

test('cancelling a local model step keeps evidence, prevents application and releases the agent', async t => {
  const controller = new AbortController();
  const { agent, args, projectDirectory, requests } = await fixture(t, [
    calls(tool('read_file', { path: 'notes.txt' })),
    (_body, signal) => { assert.equal(signal.aborted, false); controller.abort(); return final('停止后的内容不应成功。'); },
  ]);
  const result = await agent.run(args, { signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.reason, 'agent_cancelled');
  assert.equal(result.modelRequests, 2); assert.equal(result.trace.reads, 1); assert.equal(result.candidateHash, null);
  assert.equal(agent.running, false); assert.equal(requests.length, 2);
  await absent(join(projectDirectory, 'summary.md'));
  await assert.rejects(agent.review({ ...review(result), candidateHash: 'ab'.repeat(32) }), { message: 'agent_review_candidate_invalid' });
  await assert.rejects(agent.run(args, { signal: controller.signal }), { message: 'agent_cancelled' });
});

test('preflight executes before inference, preserves cancellation and blocks unavailable local service', async t => {
  const { agent, args, requests } = await fixture(t, summarize);
  let checks = 0;
  agent.preflight = async signal => { checks++; assert.ok(signal instanceof AbortSignal); throw new Error('agent_model_missing'); };
  const blocked = await agent.run(args);
  assert.equal(checks, 1); assert.equal(blocked.status, 'failed'); assert.equal(blocked.reason, 'agent_model_missing');
  assert.equal(blocked.modelRequests, 0); assert.equal(requests.length, 0);
  const controller = new AbortController();
  agent.preflight = async () => { controller.abort(); };
  const cancelled = await agent.run(args, { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.reason, 'agent_cancelled');
  assert.equal(cancelled.modelRequests, 0); assert.equal(requests.length, 0);
});

test('unknown tools, extra tool arguments and unselected file or command requests fail without project writes', async t => {
  const cases = [
    [tool('execute_shell', { command: 'untrusted program' }), 'agent_tool_invalid'],
    [tool('read_file', { path: 'notes.txt', extra: true }), 'agent_tool_arguments_invalid'],
    [tool('read_file', { path: 'unselected.txt' }), 'agent_file_not_selected'],
    [tool('read_file', { path: '../outside.txt' }), 'agent_path_denied'],
    [tool('write_file', { path: 'notes.txt', content: 'unauthorized overwrite' }), 'agent_write_not_selected'],
    [tool('run_command', { commandId: 'undeclared' }), 'agent_command_not_selected'],
    [tool('run_command', { commandId: 'summary_stats', command: 'untrusted' }), 'agent_tool_arguments_invalid'],
  ];
  for (const [selected, reason] of cases) {
    const { agent, args, projectDirectory } = await fixture(t, [calls(selected)]);
    const result = await agent.run(args);
    assert.equal(result.status, 'failed'); assert.equal(result.reason, reason); assert.equal(result.modelRequests, 1);
    await absent(join(projectDirectory, 'summary.md'));
    assert.equal(await readFile(join(projectDirectory, 'notes.txt'), 'utf8'), '周三提交文档，周五演示。\n');
  }
});

test('step and tool call caps stop repeated model requests on the original task', async t => {
  const read = tool('read_file', { path: 'notes.txt' });
  const first = await fixture(t, Array.from({ length: 3 }, () => calls(read)));
  const stepped = await first.agent.run({ ...first.args, maxSteps: 3 });
  assert.equal(stepped.status, 'failed'); assert.equal(stepped.reason, 'agent_step_limit');
  assert.equal(stepped.modelRequests, 3); assert.equal(stepped.trace.reads, 3);
  const second = await fixture(t, Array.from({ length: 4 }, () => calls(read, read, read, read)));
  const capped = await second.agent.run(second.args);
  assert.equal(capped.status, 'failed'); assert.equal(capped.reason, 'agent_tool_limit');
  assert.equal(capped.modelRequests, 4); assert.equal(capped.trace.reads, 12);
});

test('an unsupported model, truncated output or response without real tools cannot claim completion', async t => {
  for (const response of [final('我已保存文件。'), { ...calls(tool('read_file', { path: 'notes.txt' })), model: 'qwen3:8b-cloud' },
    { ...calls(tool('read_file', { path: 'notes.txt' })), cloud: true },
    { ...calls(tool('read_file', { path: 'notes.txt' })), details: { remote_host: 'remote.invalid' } },
    { ...calls(tool('read_file', { path: 'notes.txt' })), done_reason: 'length' },
    calls(...Array.from({ length: 5 }, () => tool('read_file', { path: 'notes.txt' })))]) {
    const { agent, args, projectDirectory } = await fixture(t, [response]);
    const result = await agent.run(args);
    assert.equal(result.status, 'failed'); assert.equal(result.candidateHash, null);
    assert.match(result.reason, /^agent_(?:no_tools_used|invalid_response|tool_calls_invalid)$/);
    await absent(join(projectDirectory, 'summary.md'));
  }
});

test('sensitive task text, files and model responses are rejected without inference or secret persistence', async t => {
  const syntheticCredential = 'sk-' + 'SYNTHETIC'.repeat(5);
  const { agent, args, requests, projectDirectory } = await fixture(t);
  await assert.rejects(agent.run({ ...args, task: syntheticCredential }), { message: 'agent_sensitive_input' });
  assert.equal(requests.length, 0);
  await writeFile(join(projectDirectory, 'notes.txt'), syntheticCredential);
  const file = await agent.run(args);
  assert.equal(file.status, 'failed'); assert.equal(file.reason, 'agent_sensitive_file'); assert.equal(file.modelRequests, 0);
  assert.equal((await readFile(join(file.evidenceDirectory, 'task.json'), 'utf8')).includes(syntheticCredential), false);
  const output = await fixture(t, [calls(tool('write_file', { path: 'summary.md', content: syntheticCredential }))]);
  const result = await output.agent.run(output.args);
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'agent_invalid_response');
  assert.equal((await readFile(join(result.evidenceDirectory, 'task.json'), 'utf8')).includes(syntheticCredential), false);
  await absent(join(output.projectDirectory, 'summary.md'));
});

test('code outputs and undeclared command paths are refused before any local model call', async t => {
  const { agent, args, requests, projectDirectory } = await fixture(t);
  const code = await agent.run({ ...args, writeFiles: ['new-script.mjs'], commands: [] });
  assert.equal(code.status, 'failed'); assert.equal(code.reason, 'agent_write_type_denied'); assert.equal(code.modelRequests, 0);
  await absent(join(projectDirectory, 'new-script.mjs'));
  await assert.rejects(agent.run({ ...args, commands: [{ id: 'check', kind: 'text_stats', path: 'unselected.txt' }] }), { message: 'agent_command_not_selected' });
  await assert.rejects(agent.run({ ...args, risk: 'high' }), { message: 'agent_high_risk_requires_gpt' });
  assert.equal(requests.length, 0);
});
