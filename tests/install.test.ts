import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const installFiles = ['manifest.json', 'main.js', 'styles.css', 'LICENSE', 'NOTICE', 'LICENSE-MIT-LEGACY', 'THIRD_PARTY_NOTICES.md'];

async function fixture(context: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'tangrow-installer-test-')));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source');
  const vault = path.join(directory, 'vault');
  const home = path.join(directory, 'test-home');
  const destination = path.join(vault, '.obsidian', 'plugins', 'tangrow');
  const script = path.join(source, 'scripts', 'install.mjs');
  const preload = path.join(directory, 'preload.mjs');
  const community = path.join(vault, '.obsidian', 'community-plugins.json');
  await mkdir(path.dirname(script), { recursive: true });
  await mkdir(destination, { recursive: true });
  await mkdir(home);
  await copyFile(installer, script);
  for (const name of installFiles) {
    await writeFile(path.join(source, name), name === 'manifest.json' ? '{"id":"tangrow"}\n' : `New ${name}\n`);
  }
  await writeFile(community, '["other-plugin"]\n');
  await writeFile(preload, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => ${JSON.stringify(home)};
syncBuiltinESMExports();
`);
  return { directory, source, vault, home, destination, script, preload, community };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function install(target: Fixture, ...args: string[]) {
  return execute(process.execPath, ['--import', target.preload, target.script, '--vault', target.vault, ...args], { encoding: 'utf8' });
}

function plan(stdout: string): { files: string[]; backup: string | null; dryRun: boolean } {
  return JSON.parse(stdout.slice(0, stdout.indexOf('\n}') + 2));
}

async function seedExistingFiles(target: Fixture) {
  for (const name of installFiles) await writeFile(path.join(target.destination, name), `Previous ${name}\n`);
  await writeFile(path.join(target.destination, 'data.json'), '{"scratch":"Keep this draft"}\n');
}

test('installation deploys GPL, additional permissions, legacy MIT and third-party notices without changing plugin data', async context => {
  const target = await fixture(context);
  const data = '{"scratch":"Keep this draft"}\n';
  await writeFile(path.join(target.destination, 'data.json'), data);
  const { stdout } = await install(target, '--enable');
  assert.deepEqual(plan(stdout).files, installFiles);
  for (const name of installFiles) {
    assert.equal(await readFile(path.join(target.destination, name), 'utf8'), await readFile(path.join(target.source, name), 'utf8'));
  }
  assert.equal(await readFile(path.join(target.destination, 'data.json'), 'utf8'), data);
  assert.deepEqual(JSON.parse(await readFile(target.community, 'utf8')), ['other-plugin', 'tangrow']);
});

test('replacement backs up existing notices and lists them in the restore manifest', async context => {
  const target = await fixture(context);
  await seedExistingFiles(target);
  const { stdout } = await install(target, '--enable');
  const backup = plan(stdout).backup;
  assert.ok(backup);
  for (const name of installFiles) {
    assert.equal(await readFile(path.join(backup, name), 'utf8'), `Previous ${name}\n`);
  }
  assert.equal(await readFile(path.join(backup, 'community-plugins.json'), 'utf8'), '["other-plugin"]\n');
  const restore = JSON.parse(await readFile(path.join(backup, 'restore.json'), 'utf8'));
  assert.equal(restore.vault, target.vault);
  assert.equal(restore.destination, target.destination);
  assert.deepEqual(restore.files, [...installFiles, 'community-plugins.json']);
  assert.equal(await readFile(path.join(target.destination, 'data.json'), 'utf8'), '{"scratch":"Keep this draft"}\n');
});

for (const missing of ['LICENSE', 'NOTICE', 'LICENSE-MIT-LEGACY', 'THIRD_PARTY_NOTICES.md']) {
  test(`missing ${missing} fails before changing the vault or creating backups`, async context => {
    const target = await fixture(context);
    await seedExistingFiles(target);
    await rm(path.join(target.source, missing));
    await assert.rejects(install(target, '--enable'), new RegExp(`Installation file missing: ${missing.replaceAll('.', '\\.')}`));
    for (const name of installFiles) {
      assert.equal(await readFile(path.join(target.destination, name), 'utf8'), `Previous ${name}\n`);
    }
    assert.equal(await readFile(target.community, 'utf8'), '["other-plugin"]\n');
    assert.deepEqual(await readdir(target.home), []);
  });
}

test('dry run includes all license notices without changing installed files or creating backups', async context => {
  const target = await fixture(context);
  await seedExistingFiles(target);
  const { stdout } = await install(target, '--enable', '--dry-run');
  const details = plan(stdout);
  assert.equal(details.dryRun, true);
  assert.deepEqual(details.files, installFiles);
  assert.ok(details.backup);
  for (const name of installFiles) {
    assert.equal(await readFile(path.join(target.destination, name), 'utf8'), `Previous ${name}\n`);
  }
  assert.equal(await readFile(target.community, 'utf8'), '["other-plugin"]\n');
  assert.equal(await readFile(path.join(target.destination, 'data.json'), 'utf8'), '{"scratch":"Keep this draft"}\n');
  assert.deepEqual(await readdir(target.home), []);
});

test('a symbolic link at a notice destination is rejected before deployment', async context => {
  const target = await fixture(context);
  await seedExistingFiles(target);
  const notice = path.join(target.destination, 'THIRD_PARTY_NOTICES.md');
  const external = path.join(target.directory, 'external-notice.md');
  await writeFile(external, 'Keep external content\n');
  await rm(notice);
  await symlink(external, notice);
  await assert.rejects(install(target, '--enable'), /Refusing symbolic link/);
  assert.equal(await readFile(external, 'utf8'), 'Keep external content\n');
  assert.equal(await readFile(path.join(target.destination, 'main.js'), 'utf8'), 'Previous main.js\n');
  assert.deepEqual(await readdir(target.home), []);
});

test('a concurrent enabled-plugin update is retained after deploying all seven files', async context => {
  const target = await fixture(context);
  const concurrent = '["other-plugin","new-plugin"]\n';
  await appendFile(target.preload, `import fs from 'node:fs/promises';
const rename = fs.rename;
fs.rename = async (source, destination) => {
  await rename(source, destination);
  if (destination === ${JSON.stringify(path.join(target.destination, 'main.js'))}) {
    await fs.writeFile(${JSON.stringify(target.community)}, ${JSON.stringify(concurrent)});
  }
};
syncBuiltinESMExports();
`);
  await assert.rejects(install(target, '--enable'), /community-plugins.json changed during installation/);
  assert.equal(await readFile(target.community, 'utf8'), concurrent);
  for (const name of installFiles) {
    assert.equal(await readFile(path.join(target.destination, name), 'utf8'), await readFile(path.join(target.source, name), 'utf8'));
  }
});
