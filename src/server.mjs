import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { LocalWorker } from './core.mjs';
import { LocalAgent } from './local-agent.mjs';
import { inspectGoflow, planGoflow } from './goflow-bridge.mjs';
import { STATE_DIR, startService } from './runtime.mjs';
import { runCoordinatedLocal } from './coordination.mjs';

const worker = new LocalWorker({ stateDir: STATE_DIR, startService });
const agent = new LocalAgent({ stateDir: STATE_DIR, startService });
const commandKinds = ['text_stats', 'json_validate', 'csv_stats', 'javascript_check', 'node_version'];
const server = new McpServer({ name: 'local-ai-goflow', version: '0.5.0' }, {
  instructions: 'Delegate short low-risk text tasks to local Qwen3. For simple project text/data tasks, the local agent reads only selected files, creates snapshot candidates and runs fixed trusted checks; GPT reviews actual candidates and command evidence before accepting writes. Ordinary coding still uses guarded GoFlow. No arbitrary shell, file access, cloud inference or model self-approval.',
});
const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const guarded = (handler) => async (args, context) => {
  try { return textResult(await handler(args, context)); }
  catch { return { isError: true, content: [{ type: 'text', text: 'local_plugin_operation_failed' }] }; }
};
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

server.registerTool('local_ai_status', {
  description: 'Check local Ollama/model availability and the guarded GoFlow mode/quota state. Does not start Ollama or call a model. Use an actual project directory when requesting GoFlow status.',
  inputSchema: z.object({ projectDirectory: z.string().min(1).max(1024).optional() }).strict(),
  annotations: readOnly,
}, guarded(async ({ projectDirectory }) => ({
  local: await worker.status(),
  localAgent: { fileTools: true, commandKinds: [...commandKinds], writes: 'snapshot-then-GPT-accept' },
  ...(projectDirectory ? { goflow: await inspectGoflow(projectDirectory) } : {}),
  billing: 'Local GPU inference only; main GPT coordination still uses the current ChatGPT/Codex session. No savings percentage is claimed.',
})));

server.registerTool('local_ai_task', {
  description: 'Run a short low-risk summary, rewrite, translation, classification, extraction, explanation or draft on local qwen3:8b. Requires installed loopback Ollama. No shell, file access or cloud fallback. Returns exact outputMetrics character counts including whitespace and punctuation; use these for length constraints rather than estimating. Read the output and record candidate-hash review before use.',
  inputSchema: z.object({
    projectDirectory: z.string().min(1).max(1024),
    explicitLocalRequest: z.boolean().default(false).describe('Set true only when the human explicitly requested local-model execution for this task; this overrides saved routing preference, never plugin disable or tool approval.'),
    kind: z.enum(['summarize', 'rewrite', 'translate', 'classify', 'extract_json', 'code_explain', 'code_draft']),
    text: z.string().min(1).max(2400),
    instruction: z.string().max(400).optional(),
    language: z.string().max(40).optional(),
    labels: z.array(z.string().min(1).max(40)).max(12).optional(),
    fields: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/), type: z.enum(['string', 'number', 'boolean']) }).strict()).max(12).optional(),
    risk: z.enum(['low', 'high']),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, guarded((args) => runCoordinatedLocal(worker, args, inspectGoflow)));

server.registerTool('local_ai_agent_run', {
  description: 'Let local Qwen3 perform a simple low-risk project task using explicitly selected relative files and fixed trusted command kinds. Reads only readFiles, prepares writeFiles in an isolated snapshot and runs declared checks without arbitrary shell. Ordinary coding belongs to GoFlow. Nothing is applied until GPT reads actual candidate files and exit codes and calls local_ai_agent_accept with the exact candidate hash. Preserves saved routing preferences, plugin disable and native tool approval.',
  inputSchema: z.object({
    projectDirectory: z.string().min(1).max(1024),
    task: z.string().min(1).max(2000),
    readFiles: z.array(z.string().min(1).max(240)).max(8),
    writeFiles: z.array(z.string().min(1).max(240)).max(8),
    commands: z.array(z.object({ id: z.string().min(1).max(64), kind: z.enum(commandKinds),
      path: z.string().min(1).max(240).optional() }).strict()).max(8),
    risk: z.enum(['low', 'high']),
    explicitLocalRequest: z.boolean().default(false).describe('True only when the human explicitly requested local execution of this task; overrides saved routing preference, never plugin disable, tool approval or project validation.'),
    maxSteps: z.number().int().min(3).max(8).default(8),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, guarded((args, context) => runCoordinatedLocal({
  run: task => agent.run({ projectDirectory: args.projectDirectory, ...task }, { signal: context?.mcpReq?.signal }),
}, args, inspectGoflow)));

server.registerTool('local_ai_agent_task', {
  description: 'Read the existing local agent task, actual candidate files, declared command results and candidate hash for GPT review. No inference, commands or file application.',
  inputSchema: z.object({ taskId: z.string().uuid() }).strict(),
  annotations: readOnly,
}, guarded(({ taskId }) => agent.task(taskId)));

server.registerTool('local_ai_agent_accept', {
  description: 'Record GPT review of an exact local agent candidate after reading its files and command exit codes. approve applies only declared snapshot writes after original file hash checks; reject preserves evidence without application. Cannot bypass native approval. Local Qwen3 cannot approve its own work.',
  inputSchema: z.object({ taskId: z.string().uuid(), candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewer: z.literal('GPT'), decision: z.enum(['approve', 'reject']), feedback: z.string().min(12).max(2000) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
}, guarded((args, context) => agent.review(args, { signal: context?.mcpReq?.signal })));

server.registerTool('local_ai_review', {
  description: 'Record GPT review of an exact local task/candidate hash after reading the output. For length requirements cite deterministic outputMetrics counts, never a mental estimate. Does not apply files, execute code or submit to Go. Rejection preserves evidence.',
  inputSchema: z.object({
    taskId: z.string().min(1).max(100), candidateHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(['approve', 'reject']), feedback: z.string().min(12).max(600),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, guarded((args) => worker.review(args)));

server.registerTool('local_ai_metrics', {
  description: 'Read metadata-only local inference, failure and review counts. Provider tokens are observations, not invoices or proven subscription savings.',
  inputSchema: z.object({}).strict(), annotations: readOnly,
}, guarded(() => worker.metrics()));

server.registerTool('local_ai_goflow_plan', {
  description: 'Check the original GoFlow service and route a bounded handoff plan using the actual project directory. This only calls the existing restricted status/route tools; it never submits, resumes, approves or makes a cloud model request. Use a nonprivate task summary.',
  inputSchema: z.object({ projectDirectory: z.string().min(1).max(1024), summary: z.string().min(1).max(200),
    risk: z.enum(['low', 'high']), complexity: z.enum(['simple', 'moderate', 'high']), }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, guarded((args) => planGoflow(args)));

await server.connect(new StdioServerTransport());
