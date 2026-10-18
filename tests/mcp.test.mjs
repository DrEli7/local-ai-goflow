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
    assert.equal(tools.tools.length, 5);
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
