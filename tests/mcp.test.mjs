import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('official MCP stdio initialization exposes bounded tools and rejects invalid requests before inference', async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], stderr: 'pipe' });
  const client = new Client({ name: 'local-ai-protocol-test', version: '0.1.0' });
  const parse = (response) => JSON.parse(response.content.find((item) => item.type === 'text').text);
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    assert.equal(tools.tools.some((tool) => /execute|delete|pull|cloud_submit/.test(tool.name)), false);
    const before = parse(await client.callTool({ name: 'local_ai_metrics', arguments: {} }));
    const bad = await client.callTool({ name: 'local_ai_task', arguments: {
      kind: 'summarize', text: 'synthetic test input', risk: 'low', endpoint: 'https://example.com',
    } });
    assert.equal(bad.isError, true);
    const unsupported = await client.callTool({ name: 'local_ai_task', arguments: {
      kind: 'execute_shell', text: 'synthetic test input', risk: 'low',
    } });
    assert.equal(unsupported.isError, true);
    const after = parse(await client.callTool({ name: 'local_ai_metrics', arguments: {} }));
    assert.equal(after.modelRequests, before.modelRequests);
    assert.equal(after.tasks, before.tasks);
  } finally { await client.close(); }
});

test('local agent MCP contract is bounded, selected-file only and requires destructive GPT acceptance', async () => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], stderr: 'pipe' });
  const client = new Client({ name: 'local-agent-protocol-test', version: '0.1.0' });
  const parse = response => JSON.parse(response.content.find(item => item.type === 'text').text);
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const run = tools.find(tool => tool.name === 'local_ai_agent_run');
    const task = tools.find(tool => tool.name === 'local_ai_agent_task');
    const accept = tools.find(tool => tool.name === 'local_ai_agent_accept');
    assert.deepEqual(run.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    assert.deepEqual(task.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    assert.deepEqual(accept.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    assert.equal(run.inputSchema.additionalProperties, false);
    assert.equal(run.inputSchema.properties.explicitLocalRequest.default, false);
    assert.equal(run.inputSchema.properties.maxSteps.default, 8);
    const status = parse(await client.callTool({ name: 'local_ai_status', arguments: {} }));
    assert.deepEqual(status.localAgent, { fileTools: true,
      commandKinds: ['text_stats', 'json_validate', 'csv_stats', 'javascript_check', 'node_version'],
      writes: 'snapshot-then-GPT-accept' });
    const base = { projectDirectory: fileURLToPath(new URL('../', import.meta.url)), task: '整理合成示例数据',
      readFiles: ['input.txt'], writeFiles: ['summary.md'], commands: [{ id: 'check', kind: 'text_stats', path: 'summary.md' }], risk: 'low' };
    const before = parse(await client.callTool({ name: 'local_ai_metrics', arguments: {} }));
    // Each request fails schema validation before GoFlow checks, model inference or file tools.
    const invalidRuns = [
      { ...base, endpoint: 'https://example.invalid' },
      { ...base, task: 'x'.repeat(2001) },
      { ...base, readFiles: Array(9).fill('input.txt') },
      { ...base, writeFiles: Array(9).fill('summary.md') },
      { ...base, commands: Array(9).fill(base.commands[0]) },
      { ...base, commands: [{ id: 'shell', kind: 'execute_shell', path: 'input.txt' }] },
      { ...base, commands: [{ ...base.commands[0], command: 'arbitrary program' }] },
      { ...base, commands: [{ ...base.commands[0], args: ['arbitrary'] }] },
      { ...base, maxSteps: 2 }, { ...base, maxSteps: 9 }, { ...base, maxSteps: 3.5 },
      { ...base, risk: 'unknown' }, { ...base, explicitLocalRequest: 'true' },
      { ...base, readFiles: undefined }, { ...base, writeFiles: undefined },
    ];
    for (const args of invalidRuns) {
      const response = await client.callTool({ name: 'local_ai_agent_run', arguments: args });
      assert.equal(response.isError, true);
    }
    const taskId = '3a219b1e-087b-4bb9-976f-93adb105962b';
    const review = { taskId, candidateHash: 'ab'.repeat(32), reviewer: 'GPT', decision: 'approve', feedback: '已逐项核对候选数据以及命令执行结果。' };
    for (const args of [{ taskId: 'not-a-uuid' }, { taskId, path: 'unselected.txt' }])
      assert.equal((await client.callTool({ name: 'local_ai_agent_task', arguments: args })).isError, true);
    for (const args of [{ ...review, reviewer: 'Qwen3' }, { ...review, reviewer: undefined },
      { ...review, candidateHash: 'wrong' }, { ...review, feedback: 'short' },
      { ...review, force: true }, { ...review, projectDirectory: base.projectDirectory }])
      assert.equal((await client.callTool({ name: 'local_ai_agent_accept', arguments: args })).isError, true);
    const after = parse(await client.callTool({ name: 'local_ai_metrics', arguments: {} }));
    assert.equal(after.modelRequests, before.modelRequests);
    assert.equal(after.tasks, before.tasks);
  } finally { await client.close(); }
});
