import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AgentWorkspace, safeRelativePath, containsCredential, hashBytes } from '../src/agent-files.mjs';

const fixtureParent = path.dirname(fileURLToPath(import.meta.url));

async function fixture(action) {
  const root = await fs.mkdtemp(path.join(fixtureParent, 'agent-files-fixture-'));
  const projectDirectory = path.join(root, 'project');
  const stateDir = path.join(root, 'state');
  await fs.mkdir(projectDirectory);
  const write = async (name, content) => {
    const target = path.join(projectDirectory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  };
  const create = (overrides = {}) => AgentWorkspace.create({ projectDirectory, stateDir,
    taskId: randomUUID(), readFiles: [], writeFiles: [], ...overrides });
  try { await action({ root, projectDirectory, stateDir, write, create }); }
  finally {
    // Delete only the exact temporary directory minted in this project's test area.
    assert.equal(path.dirname(root), fixtureParent);
    assert.ok(path.basename(root).startsWith('agent-files-fixture-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('relative paths admit ordinary nested data names and reject escape or Windows aliases', () => {
  for (const value of ['notes.txt', 'reports/summary.md', '资料/销售.csv']) {
    assert.doesNotThrow(() => safeRelativePath(value));
  }
  for (const value of ['', '.', '..', '../out.txt', 'a/../../out.txt', '/outside.txt',
    'C:/outside.txt', 'C:relative.txt', '\\\\server\\share\\a.txt', '\\\\?\\C:\\a.txt',
    'a.txt:stream', 'nested/aux.txt', 'NUL.md', 'con.txt', 'lpt1.csv',
    'bad./report.txt', 'bad /report.txt', 'trailing.txt.', 'trailing.txt ', 'a\u0000.txt']) {
    assert.throws(() => safeRelativePath(value), `unsafe path should be rejected: ${JSON.stringify(value)}`);
  }
});

test('credential recognition uses synthetic fixtures and does not reject ordinary key discussion', () => {
  assert.equal(containsCredential('The API key is configured locally; do not print it.'), false);
  assert.equal(containsCredential('订单号：A001，金额：25'), false);
  // Synthetic, deliberately nonfunctional material; never load a user's credentials.
  assert.equal(containsCredential('sk-' + 'A'.repeat(40)), true);
  assert.equal(containsCredential('-----BEGIN PRIVATE KEY-----\nTEST ONLY\n-----END PRIVATE KEY-----'), true);
  assert.match(hashBytes(Buffer.from('abc')), /^[a-f0-9]{64}$/);
  assert.equal(hashBytes('abc'), hashBytes(Buffer.from('abc')));
  assert.notEqual(hashBytes('abc'), hashBytes('abcd'));
});

test('snapshot reads declared files while keeping the project unchanged until apply', async () => {
  await fixture(async ({ projectDirectory, write, create }) => {
    await write('input.txt', 'original\n');
    const workspace = await create({ readFiles: ['input.txt'], writeFiles: ['input.txt', 'result.md'] });
    assert.notEqual(path.resolve(workspace.directory), path.resolve(projectDirectory));
    assert.deepEqual(await workspace.read('input.txt'), { path: 'input.txt', content: 'original\n', bytes: 9 });
    await workspace.write('input.txt', 'revised\n');
    await workspace.write('result.md', '# Summary\n');
    assert.equal(await fs.readFile(path.join(projectDirectory, 'input.txt'), 'utf8'), 'original\n');
    await assert.rejects(fs.stat(path.join(projectDirectory, 'result.md')), { code: 'ENOENT' });
    const changes = await workspace.changes();
    assert.equal(changes.length, 2);
    const existing = changes.find(change => change.path === 'input.txt');
    const added = changes.find(change => change.path === 'result.md');
    assert.equal(existing.originalHash, hashBytes('original\n'));
    assert.equal(existing.hash, hashBytes('revised\n'));
    assert.equal(existing.bytes, Buffer.byteLength('revised\n'));
    assert.equal(added.originalHash, null);
    assert.equal(added.content, '# Summary\n');
    await assert.doesNotReject(() => workspace.verifyOriginals());
    await workspace.apply(changes);
    assert.equal(await fs.readFile(path.join(projectDirectory, 'input.txt'), 'utf8'), 'revised\n');
    assert.equal(await fs.readFile(path.join(projectDirectory, 'result.md'), 'utf8'), '# Summary\n');
  });
});

test('UTF-8 BOM is preserved by snapshot reads without creating an unintended file change', async () => {
  await fixture(async ({ projectDirectory, write, create }) => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('名称,金额\n甲,25\n')]);
    await write('input.csv', original);
    const workspace = await create({ readFiles: ['input.csv'], writeFiles: ['input.csv'] });
    const selected = await workspace.read('input.csv');
    assert.equal(selected.content.charCodeAt(0), 0xfeff);
    assert.equal(selected.content, '\ufeff名称,金额\n甲,25\n');
    assert.equal(selected.bytes, original.length);
    assert.equal(workspace.manifest.originals['input.csv'].bytes, original.length);
    assert.equal(workspace.manifest.originals['input.csv'].hash, hashBytes(original));
    assert.deepEqual(await fs.readFile(path.join(workspace.directory, 'input.csv')), original);
    // Merely granting write scope must not strip the BOM or manufacture a candidate diff.
    assert.deepEqual(await workspace.changes(), []);
    await workspace.apply([]);
    assert.deepEqual(await fs.readFile(path.join(projectDirectory, 'input.csv')), original);
    assert.equal(hashBytes(await fs.readFile(path.join(projectDirectory, 'input.csv'))), hashBytes(original));
  });
});

test('task IDs cannot escape the fixed task-state directory or create arbitrary paths', async () => {
  await fixture(async ({ projectDirectory, stateDir, write, create }) => {
    await write('notes.txt', 'fixture');
    for (const taskId of ['../escape', '../../outside', randomUUID() + '/../../escape',
      'C:/outside', '\\\\server\\share', '', null, 'not-a-uuid']) {
      await assert.rejects(() => create({ taskId, readFiles: ['notes.txt'] }));
    }
    await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(projectDirectory, 'notes.txt'), 'utf8'), 'fixture');
  });
});

test('undeclared files cannot be read or written even inside the selected project', async () => {
  await fixture(async ({ projectDirectory, write, create }) => {
    await write('selected.txt', 'selected');
    await write('unselected.txt', 'private project data');
    const workspace = await create({ readFiles: ['selected.txt'], writeFiles: ['result.txt'] });
    await assert.rejects(() => workspace.read('unselected.txt'));
    await assert.rejects(() => workspace.read('../project/unselected.txt'));
    await assert.rejects(() => workspace.write('unselected.txt', 'changed'));
    await assert.rejects(() => workspace.write('../outside.txt', 'changed'));
    assert.equal(await fs.readFile(path.join(projectDirectory, 'unselected.txt'), 'utf8'), 'private project data');
  });
});

test('existing writable files must also be explicit read inputs', async () => {
  await fixture(async ({ write, create }) => {
    await write('existing.md', 'keep');
    await assert.rejects(() => create({ readFiles: [], writeFiles: ['existing.md'] }));
    await assert.doesNotReject(() => create({ readFiles: ['existing.md'], writeFiles: ['existing.md'] }));
  });
});

test('data and document outputs are allowed but executable code is not writable', async () => {
  await fixture(async ({ write, create }) => {
    await write('source.mjs', 'export const value = 1;\n');
    const workspace = await create({ readFiles: ['source.mjs'], writeFiles: ['report.md'] });
    assert.match((await workspace.read('source.mjs')).content, /export const/);
    for (const extension of ['mjs', 'js', 'cjs', 'py', 'ps1', 'cmd', 'bat', 'exe', 'sh']) {
      await assert.rejects(() => create({ writeFiles: [`output.${extension}`] }));
    }
    for (const extension of ['txt', 'md', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'log', 'rst']) {
      await assert.doesNotReject(() => create({ writeFiles: [`output.${extension}`] }));
    }
  });
});

test('sensitive paths are rejected before either input copying or output creation', async () => {
  await fixture(async ({ write, create }) => {
    for (const name of ['.env', '.env.local', '.git/config', '.codex/config.toml', '.ssh/id_rsa',
      '.npmrc', '.docker/config.json', 'auth.json', 'credentials.json']) {
      await write(name, 'synthetic test data');
      await assert.rejects(() => create({ readFiles: [name] }), `sensitive input ${name}`);
      await assert.rejects(() => create({ readFiles: [name], writeFiles: [name] }), `sensitive output ${name}`);
    }
  });
});

test('recognized credential content is rejected on input and candidate writes', async () => {
  await fixture(async ({ write, create }) => {
    const synthetic = 'sk-' + 'B'.repeat(40);
    await write('notes.txt', synthetic);
    await assert.rejects(() => create({ readFiles: ['notes.txt'] }));
    const workspace = await create({ writeFiles: ['result.txt'] });
    await assert.rejects(() => workspace.write('result.txt', synthetic));
    assert.deepEqual(await workspace.changes(), []);
  });
});

test('read and write byte limits count UTF-8 and input totals are bounded', async () => {
  await fixture(async ({ write, create }) => {
    await write('large.txt', 'x'.repeat(16 * 1024 + 1));
    await assert.rejects(() => create({ readFiles: ['large.txt'] }));
    await write('unicode.txt', '你'.repeat(6000));
    await assert.rejects(() => create({ readFiles: ['unicode.txt'] }));
    const inputs = ['one.txt', 'two.txt', 'three.txt'];
    for (const name of inputs) await write(name, 'x'.repeat(12 * 1024));
    await assert.rejects(() => create({ readFiles: inputs }));
    const workspace = await create({ writeFiles: ['output.txt'] });
    await assert.rejects(() => workspace.write('output.txt', '你'.repeat(6000)));
    await workspace.write('output.txt', 'x'.repeat(16 * 1024));
    assert.equal((await workspace.changes())[0].bytes, 16 * 1024);
  });
});

test('file counts and path aliases cannot inflate the declared capability set', async () => {
  await fixture(async ({ write, create }) => {
    const files = Array.from({ length: 9 }, (_, index) => `input-${index}.txt`);
    for (const name of files) await write(name, 'fixture');
    await assert.rejects(() => create({ readFiles: files }));
    await assert.rejects(() => create({ writeFiles: files.map(name => `new-${name}`) }));
    await assert.rejects(() => create({ readFiles: ['input-0.txt', 'input-0.txt'] }));
    await assert.rejects(() => create({ writeFiles: ['same.txt', 'same.txt'] }));
    if (process.platform === 'win32') {
      await assert.rejects(() => create({ readFiles: ['input-0.txt', 'INPUT-0.TXT'] }));
      await assert.rejects(() => create({ writeFiles: ['same.txt', 'SAME.TXT'] }));
    }
  });
});

test('changed originals block the whole apply before any other output is created', async () => {
  await fixture(async ({ projectDirectory, write, create }) => {
    await write('original.txt', 'before');
    const workspace = await create({ readFiles: ['original.txt'], writeFiles: ['original.txt', 'new.txt'] });
    await workspace.write('original.txt', 'candidate');
    await workspace.write('new.txt', 'new candidate');
    const changes = await workspace.changes();
    await write('original.txt', 'external change');
    await assert.rejects(() => workspace.verifyOriginals());
    await assert.rejects(() => workspace.apply(changes));
    assert.equal(await fs.readFile(path.join(projectDirectory, 'original.txt'), 'utf8'), 'external change');
    await assert.rejects(fs.stat(path.join(projectDirectory, 'new.txt')), { code: 'ENOENT' });
  });
});

test('a newly existing output conflicts with the snapshot expectation of absence', async () => {
  await fixture(async ({ projectDirectory, write, create }) => {
    const workspace = await create({ writeFiles: ['result.md'] });
    await workspace.write('result.md', 'candidate');
    const changes = await workspace.changes();
    await write('result.md', 'created externally');
    await assert.rejects(() => workspace.apply(changes));
    assert.equal(await fs.readFile(path.join(projectDirectory, 'result.md'), 'utf8'), 'created externally');
  });
});

test('changed read-only inputs invalidate a derived output before it can be applied', async () => {
  await fixture(async ({ projectDirectory, write, create }) => {
    await write('source.csv', 'name,amount\nA,10\n');
    const workspace = await create({ readFiles: ['source.csv'], writeFiles: ['summary.md'] });
    await workspace.write('summary.md', 'Total: 10\n');
    const changes = await workspace.changes();
    await write('source.csv', 'name,amount\nA,99\n');
    await assert.rejects(() => workspace.verifyOriginals());
    await assert.rejects(() => workspace.apply(changes));
    await assert.rejects(fs.stat(path.join(projectDirectory, 'summary.md')), { code: 'ENOENT' });
  });
});

test('cancelled application leaves both existing and new outputs unchanged', async () => {
  await fixture(async ({ projectDirectory, write, create }) => {
    await write('original.txt', 'before');
    const workspace = await create({ readFiles: ['original.txt'], writeFiles: ['original.txt', 'result.txt'] });
    await workspace.write('original.txt', 'after');
    await workspace.write('result.txt', 'new');
    const controller = new AbortController();
    controller.abort();
    const changes = await workspace.changes();
    await assert.rejects(() => workspace.apply(changes, { signal: controller.signal }));
    assert.equal(await fs.readFile(path.join(projectDirectory, 'original.txt'), 'utf8'), 'before');
    await assert.rejects(fs.stat(path.join(projectDirectory, 'result.txt')), { code: 'ENOENT' });
  });
});

test('apply rejects a modified candidate payload rather than trusting caller-provided metadata', async () => {
  await fixture(async ({ projectDirectory, create }) => {
    const workspace = await create({ writeFiles: ['result.txt'] });
    await workspace.write('result.txt', 'reviewed candidate');
    const changes = await workspace.changes();
    const tampered = changes.map(change => ({ ...change, content: 'unreviewed replacement' }));
    await assert.rejects(() => workspace.apply(tampered));
    await assert.rejects(fs.stat(path.join(projectDirectory, 'result.txt')), { code: 'ENOENT' });
  });
});

test('new nested document parents are created only when the candidate is applied', async () => {
  await fixture(async ({ projectDirectory, create }) => {
    const workspace = await create({ writeFiles: ['reports/summary.md'] });
    await workspace.write('reports/summary.md', '# Reviewed summary\n');
    await assert.rejects(fs.stat(path.join(projectDirectory, 'reports')), { code: 'ENOENT' });
    await workspace.apply(await workspace.changes());
    assert.equal(await fs.readFile(path.join(projectDirectory, 'reports/summary.md'), 'utf8'), '# Reviewed summary\n');
  });
});

test('hard-linked inputs cannot introduce undeclared alias writes', async t => {
  await fixture(async ({ projectDirectory, write, create }) => {
    await write('original.txt', 'linked fixture');
    try { await fs.link(path.join(projectDirectory, 'original.txt'), path.join(projectDirectory, 'alias.txt')); }
    catch (error) { if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) { t.skip('filesystem disallows hard links'); return; } throw error; }
    await assert.rejects(() => create({ readFiles: ['alias.txt'], writeFiles: ['alias.txt'] }));
    assert.equal(await fs.readFile(path.join(projectDirectory, 'original.txt'), 'utf8'), 'linked fixture');
  });
});

test('symbolic-link inputs and linked parent directories are rejected', async t => {
  await fixture(async ({ root, projectDirectory, create }) => {
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'notes.txt'), 'outside selected project');
    try {
      await fs.symlink(path.join(outside, 'notes.txt'), path.join(projectDirectory, 'link.txt'), 'file');
      await fs.symlink(outside, path.join(projectDirectory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) { if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) { t.skip('filesystem disallows symbolic links'); return; } throw error; }
    await assert.rejects(() => create({ readFiles: ['link.txt'] }));
    await assert.rejects(() => create({ readFiles: ['linked/notes.txt'] }));
    await assert.rejects(() => create({ writeFiles: ['linked/new.txt'] }));
    await assert.rejects(fs.stat(path.join(outside, 'new.txt')), { code: 'ENOENT' });
  });
});

test('a candidate replaced by a symbolic link cannot be read back or applied', async t => {
  await fixture(async ({ root, projectDirectory, create }) => {
    const workspace = await create({ writeFiles: ['result.txt'] });
    await workspace.write('result.txt', 'candidate');
    const target = path.join(workspace.directory, 'result.txt');
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(outside, 'outside workspace');
    // target is an exact declared file in the task's own temporary snapshot.
    await fs.unlink(target);
    try { await fs.symlink(outside, target, 'file'); }
    catch (error) { if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) { t.skip('filesystem disallows symbolic links'); return; } throw error; }
    await assert.rejects(() => workspace.changes());
    await assert.rejects(fs.stat(path.join(projectDirectory, 'result.txt')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(outside, 'utf8'), 'outside workspace');
  });
});
