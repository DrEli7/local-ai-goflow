import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { assertLocalClientPolicy } from '../src/client-policy.mjs';

const allowed = new Set(['local_ai_status', 'local_ai_task', 'local_ai_review', 'local_ai_metrics', 'local_ai_goflow_plan']);
const operation = process.argv[2];
if (process.argv.length !== 3 || (operation !== 'list' && !allowed.has(operation))) {
  process.stderr.write('Usage: node scripts/client.mjs <list|allowed-local-ai-tool>; JSON arguments on stdin.\n');
  process.exit(2);
}
let raw = '';
for await (const chunk of process.stdin) {
  raw += chunk;
  if (Buffer.byteLength(raw) > 20000) { process.stderr.write('Input too large.\n'); process.exit(2); }
}
let args;
try { args = JSON.parse(raw.trim() || '{}'); }
catch { process.stderr.write('Invalid JSON input.\n'); process.exit(2); }
let policy;
try {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error();
  policy = await assertLocalClientPolicy(operation);
  if (args.projectDirectory !== undefined) {
    const projectPolicy = await assertLocalClientPolicy(operation, { cwd: args.projectDirectory });
    if (projectPolicy.outputByteLimit !== undefined) policy.outputByteLimit = Math.min(policy.outputByteLimit ?? Infinity, projectPolicy.outputByteLimit);
  }
} catch (error) {
  const code = /^[A-Z_]{1,60}$/.test(error.code ?? '') ? error.code : 'POLICY_CHECK_FAILED';
  process.stderr.write(code + ': Local plugin fallback refused; use native MCP when approval is required.\n');
  process.exit(3);
}
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
  stderr: 'pipe',
});
const client = new Client({ name: 'local-ai-goflow-cli', version: '0.2.0' });
try {
  await client.connect(transport);
  const result = operation === 'list' ? await client.listTools() : await client.callTool({ name: operation, arguments: args }, { timeout: 300000 });
  if (policy.outputByteLimit !== undefined && Buffer.byteLength(JSON.stringify(result), 'utf8') > policy.outputByteLimit) throw new Error('output_policy_limit');
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.isError) process.exitCode = 1;
} catch {
  process.stderr.write('local_mcp_call_failed\n');
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
