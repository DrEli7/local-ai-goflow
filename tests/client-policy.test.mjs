import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalClientPolicy, validateLocalPolicy } from '../src/client-policy.mjs';

const ID = 'local-ai-goflow@goflow-local';
const SERVER = 'local_ai_goflow';
const TOOL = 'local_ai_task';
const enabled = () => ({ plugins: { [ID]: { enabled: true } } });
const user = config => ({ kind: 'user', config });
const project = config => ({ kind: 'project', config });
const globalServer = policy => ({ mcp_servers: { [SERVER]: policy } });
const pluginServer = policy => ({ plugins: { [ID]: { enabled: true, mcp_servers: { [SERVER]: policy } } } });
const rejected = code => error => error.code === code && error.message === code;
const validate = (config, tool = TOOL) => validateLocalPolicy([user(enabled()), project(config)], tool);

test('user plugin enablement is required; project enablement alone cannot grant it', () => {
  assert.deepEqual(validateLocalPolicy([user(enabled())], TOOL), {});
  assert.throws(() => validateLocalPolicy([], TOOL), rejected('PLUGIN_NOT_ENABLED'));
  assert.throws(() => validateLocalPolicy([project(enabled())], TOOL), rejected('PLUGIN_NOT_ENABLED'));
  assert.throws(() => validateLocalPolicy([user({})], TOOL), rejected('PLUGIN_NOT_ENABLED'));
});

test('any applicable explicit plugin or direct/nested service disable wins', () => {
  const base = user(enabled());
  assert.throws(() => validateLocalPolicy([base, project({ plugins: { [ID]: { enabled: false } } })], TOOL), rejected('PLUGIN_DISABLED'));
  assert.throws(() => validateLocalPolicy([user({ plugins: { [ID]: { enabled: false } } }), base], TOOL), rejected('PLUGIN_DISABLED'));
  for (const config of [globalServer({ enabled: false }), pluginServer({ enabled: false })]) {
    assert.throws(() => validate(config), rejected('SERVICE_DISABLED'));
    assert.throws(() => validate(config, 'list'), rejected('SERVICE_DISABLED'));
  }
});

test('known tool names only; metadata listing requires enabled plugin', () => {
  assert.deepEqual(validateLocalPolicy([user(enabled())], 'list'), {});
  assert.throws(() => validateLocalPolicy([user(enabled())], 'arbitrary_tool'), rejected('TOOL_NOT_ALLOWED'));
  assert.throws(() => validateLocalPolicy([project(enabled())], 'list'), rejected('PLUGIN_NOT_ENABLED'));
});

test('both server namespaces apply allowlists and denylists', () => {
  for (const factory of [globalServer, pluginServer]) {
    assert.throws(() => validate(factory({ enabled_tools: [] })), rejected('TOOL_DISABLED'));
    assert.throws(() => validate(factory({ enabled_tools: ['local_ai_status'] })), rejected('TOOL_DISABLED'));
    assert.throws(() => validate(factory({ enabled_tools: [TOOL], disabled_tools: [TOOL] })), rejected('TOOL_DISABLED'));
    assert.deepEqual(validate(factory({ enabled_tools: [TOOL], disabled_tools: ['local_ai_status'] })), {});
  }
});

test('list metadata is available under tool filters and prompt defaults without executing tools', () => {
  assert.deepEqual(validate(globalServer({ enabled_tools: [], default_tools_approval_mode: 'prompt' }), 'list'), {});
});

test('prompt requires native approval for every selected tool; writes gates every writing tool', () => {
  for (const tool of ['local_ai_status', 'local_ai_task', 'local_ai_review', 'local_ai_metrics', 'local_ai_goflow_plan']) {
    assert.throws(() => validate(globalServer({ default_tools_approval_mode: 'prompt' }), tool), rejected('APPROVAL_REQUIRED'));
  }
  for (const tool of ['local_ai_task', 'local_ai_review', 'local_ai_goflow_plan']) {
    assert.throws(() => validate(pluginServer({ default_tools_approval_mode: 'writes' }), tool), rejected('APPROVAL_REQUIRED'));
  }
  for (const tool of ['local_ai_status', 'local_ai_metrics']) {
    assert.deepEqual(validate(globalServer({ default_tools_approval_mode: 'writes' }), tool), {});
  }
});

test('auto and approve are allowed; an explicit tool mode overrides its own server default', () => {
  for (const mode of ['auto', 'approve']) {
    assert.deepEqual(validate(globalServer({ default_tools_approval_mode: mode })), {});
    assert.deepEqual(validate(globalServer({ default_tools_approval_mode: 'prompt', tools: { [TOOL]: { approval_mode: mode } } })), {});
  }
});

test('project policy cannot relax native approval required by another applicable record', () => {
  const guardedUser = enabled();
  guardedUser.mcp_servers = { [SERVER]: { tools: { [TOOL]: { approval_mode: 'prompt' } } } };
  assert.throws(() => validateLocalPolicy([user(guardedUser), project(globalServer({ tools: { [TOOL]: { approval_mode: 'auto' } } }))], TOOL), rejected('APPROVAL_REQUIRED'));
});

test('strictest output_token_limit becomes a conservative byte cap across namespaces and ancestors', () => {
  const config = pluginServer({ tools: { [TOOL]: { output_token_limit: 1600 } } });
  config.mcp_servers = { [SERVER]: { tools: { [TOOL]: { output_token_limit: 1200 } } } };
  const result = validateLocalPolicy([user(enabled()), project(config), project(globalServer({ tools: { [TOOL]: { output_token_limit: 800 } } }))], TOOL);
  assert.deepEqual(result, { outputByteLimit: 800 });
  assert.deepEqual(validate(config, 'local_ai_status'), {});
});

test('malformed relevant records, flags, filters, approval modes and token limits fail closed', () => {
  const malformed = [
    { plugins: [] }, { plugins: { [ID]: false } }, { plugins: { [ID]: { enabled: 'true' } } },
    { plugins: { [ID]: { mcp_servers: [] } } }, { mcp_servers: null }, { mcp_servers: { [SERVER]: false } },
    globalServer({ enabled: 'false' }), globalServer({ enabled_tools: 'local_ai_task' }),
    globalServer({ disabled_tools: [7] }), globalServer({ default_tools_approval_mode: 'unknown' }),
    globalServer({ tools: [] }), globalServer({ tools: { [TOOL]: null } }),
    globalServer({ tools: { [TOOL]: { approval_mode: 7 } } }),
    globalServer({ tools: { local_ai_status: { output_token_limit: 0 } } }),
    ...[0, -1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1].map(limit => globalServer({ tools: { [TOOL]: { output_token_limit: limit } } })),
  ];
  for (const config of malformed) assert.throws(() => validate(config), rejected('CONFIG_FORMAT'));
  for (const input of [null, {}, [null], [{ kind: 'other', config: {} }], [{ kind: 'user', config: [] }]])
    assert.throws(() => validateLocalPolicy(input, TOOL), rejected('CONFIG_FORMAT'));
});

test('unrelated provider/plugin values are not treated as this plugin policy', () => {
  assert.deepEqual(validate({ plugins: { other: false }, mcp_servers: { unrelated: null }, provider: { secret: 'test-only-value' } }), {});
});

test('project transport overrides are refused in both server namespaces, including empty values', () => {
  for (const factory of [globalServer, pluginServer]) {
    for (const name of ['command', 'args', 'env', 'env_vars', 'url', 'cwd', 'http_headers', 'env_http_headers', 'bearer_token_env_var']) {
      assert.throws(() => validate(factory({ [name]: '' })), rejected('PROJECT_OVERRIDE_UNSUPPORTED'));
    }
  }
});

async function fixture(action) {
  const fixtureParent = path.dirname(fileURLToPath(import.meta.url));
  // Ancestor discovery must not read a real user/project configuration during a unit test.
  let ancestor = fixtureParent;
  while (true) {
    let present = false;
    try { await fs.lstat(path.join(ancestor, '.codex', 'config.toml')); present = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.equal(present, false, 'Fixture ancestors must not contain a real Codex config.');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const root = await fs.mkdtemp(path.join(fixtureParent, 'client-policy-fixture-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const cwd = path.join(workspace, 'nested');
  const saved = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  const write = async (base, toml) => {
    await fs.mkdir(path.join(base, '.codex'), { recursive: true });
    const filename = path.join(base, '.codex', 'config.toml');
    await fs.writeFile(filename, toml);
    return filename;
  };
  try {
    await fs.mkdir(cwd, { recursive: true });
    await write(home, `[plugins."${ID}"]\nenabled = true\n`);
    await action({ root, home, workspace, cwd, write, check: tool => assertLocalClientPolicy(tool ?? TOOL, { home, cwd }) });
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    // Delete only the exact directory minted by mkdtemp in this project's test area.
    assert.equal(path.dirname(root), fixtureParent);
    assert.ok(path.basename(root).startsWith('client-policy-fixture-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('filesystem discovery permits installed user plugin and enforces all project ancestors', async () => {
  await fixture(async ({ workspace, cwd, write, check }) => {
    assert.deepEqual(await check(), {});
    await write(workspace, `[mcp_servers.${SERVER}.tools.${TOOL}]\noutput_token_limit = 900\n`);
    await write(cwd, `[plugins."${ID}".mcp_servers.${SERVER}.tools.${TOOL}]\noutput_token_limit = 1200\n`);
    assert.deepEqual(await check(), { outputByteLimit: 900 });
    await write(workspace, `[plugins."${ID}"]\nenabled = false\n`);
    await assert.rejects(check(), rejected('PLUGIN_DISABLED'));
  });
});

test('TOML inline and dotted tables use the real parser and enforce tool policy', async () => {
  await fixture(async ({ home, cwd, write, check }) => {
    await write(home, `plugins."${ID}" = { enabled = true }\n`);
    await write(cwd, `mcp_servers.${SERVER} = { tools = { ${TOOL} = { approval_mode = "prompt" } } }\n`);
    await assert.rejects(check(), rejected('APPROVAL_REQUIRED'));
  });
});

test('malformed TOML fails closed with a fixed error, never the parser excerpt', async () => {
  await fixture(async ({ cwd, write, check }) => {
    await write(cwd, 'test_only_secret = "never-return-this-value\n');
    await assert.rejects(check(), rejected('CONFIG_FORMAT'));
  });
});

test('oversized and hard-linked user or project config files are refused', async () => {
  await fixture(async ({ home, cwd, write, check }) => {
    await write(cwd, '#'.repeat(1024 * 1024 + 1));
    await assert.rejects(check(), rejected('CONFIG_PATH_UNSAFE'));
    const projectFile = await write(cwd, '# safe config\n');
    await fs.link(projectFile, path.join(cwd, 'config-hardlink'));
    await assert.rejects(check(), rejected('CONFIG_PATH_UNSAFE'));
    await fs.unlink(projectFile);
    const userFile = path.join(home, '.codex', 'config.toml');
    await fs.link(userFile, path.join(home, 'config-hardlink'));
    await assert.rejects(check(), rejected('CONFIG_PATH_UNSAFE'));
  });
});

test('project and user junction/symlink directories are refused', async () => {
  await fixture(async ({ root, home, cwd, check }) => {
    const target = path.join(root, 'linked-target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'config.toml'), '# linked config\n');
    await fs.symlink(target, path.join(cwd, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(check(), rejected('CONFIG_PATH_UNSAFE'));
    await fs.unlink(path.join(cwd, '.codex'));
    await fs.rename(path.join(home, '.codex'), path.join(home, '.codex-original'));
    await fs.symlink(path.join(home, '.codex-original'), path.join(home, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(check(), rejected('CONFIG_PATH_UNSAFE'));
  });
});

test('custom CODEX_HOME is refused; the default directory is allowed', async () => {
  await fixture(async ({ home, root, check }) => {
    process.env.CODEX_HOME = path.join(root, 'alternate');
    await assert.rejects(check(), rejected('CONFIG_HOME_UNSUPPORTED'));
    process.env.CODEX_HOME = path.join(home, '.codex');
    assert.deepEqual(await check(), {});
  });
});

test('missing user enablement and non-directory config containers fail safely', async () => {
  await fixture(async ({ home, cwd, check }) => {
    await fs.unlink(path.join(home, '.codex', 'config.toml'));
    await assert.rejects(check(), rejected('PLUGIN_NOT_ENABLED'));
    await fs.writeFile(path.join(cwd, '.codex'), 'not-a-directory');
    await assert.rejects(check(), rejected('CONFIG_PATH_UNSAFE'));
  });
});
