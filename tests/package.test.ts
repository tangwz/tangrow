import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const packager = fileURLToPath(new URL('../scripts/package.mjs', import.meta.url));
const files = ['manifest.json', 'main.js', 'styles.css', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'];

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'tangrow-package-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'package.mjs');
  await copyFile(packager, script);
  await copyFile(path.join(path.dirname(packager), 'plugin-build.mjs'), path.join(root, 'scripts/plugin-build.mjs'));
  await copyFile(new URL('../esbuild.config.mjs', import.meta.url), path.join(root, 'esbuild.config.mjs'));
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(root, 'node_modules'), 'dir');
  await mkdir(path.join(root, 'src/license'), { recursive: true });
  const config = path.join(root, 'src/license/client.json');
  const publicClient = { endpoint: 'https://licensing.tangrow.org', keys: { release: Buffer.alloc(32, 5).toString('base64url') } };
  await writeFile(config, JSON.stringify(publicClient));
  await writeFile(path.join(root, 'src/main.ts'), "import client from './license/client.json'; export default client;");
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.0', license: 'GPL-3.0-or-later' }));
  for (const name of files) {
    const content = name === 'manifest.json' ? JSON.stringify({ id: 'tangrow', version: '0.4.0' })
      : `Original ${name}\n`;
    await writeFile(path.join(root, name), content);
  }
  await execute(process.execPath, [path.join(root, 'esbuild.config.mjs')]);
  return { root, script, config, publicClient, archive: path.join(root, 'dist', 'tangrow-0.4.0.zip') };
}

test('the release archive includes GPL, additional permissions and third-party notices unchanged', async context => {
  const target = await fixture(context);
  await execute(process.execPath, [target.script]);
  const { stdout } = await execute('unzip', ['-Z1', target.archive]);
  const entries = stdout.trim().split('\n').filter(entry => !entry.endsWith('/'));
  assert.deepEqual(entries.sort(), files.map(name => `tangrow/${name}`).sort());
  for (const name of files) {
    const archived = await execute('unzip', ['-p', target.archive, `tangrow/${name}`]);
    assert.equal(archived.stdout, await readFile(path.join(target.root, name), 'utf8'));
  }
});

for (const missing of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
  test(`packaging requires ${missing} before replacing an existing archive`, async context => {
    const target = await fixture(context);
    await mkdir(path.dirname(target.archive));
    await writeFile(target.archive, 'Previous archive');
    await rm(path.join(target.root, missing));
    await assert.rejects(execute(process.execPath, [target.script]), /ENOENT/);
    assert.equal(await readFile(target.archive, 'utf8'), 'Previous archive');
  });
}

test('a stale MIT, proprietary or previous-version bundle cannot be packaged as the GPL release', async context => {
  const target = await fixture(context);
  for (const banner of ['/* Tangrow | MIT License */', '/* Tangrow 0.4.0 | Tangrow Commercial License 1.0 | */', '/* Tangrow 0.3.0 | GPL-3.0-or-later | */']) {
    await writeFile(path.join(target.root, 'main.js'), banner);
    await assert.rejects(execute(process.execPath, [target.script]), /stale version or license banner/);
  }
  await assert.rejects(readFile(target.archive), { code: 'ENOENT' });
});

test('an owner build cannot be packaged as a release', async context => {
  const target = await fixture(context);
  await execute(process.execPath, [path.join(target.root, 'esbuild.config.mjs'), '--owner']);
  assert.match(await readFile(path.join(target.root, 'main.js'), 'utf8'), /^\/\* Tangrow 0\.4\.0 owner build, no access checks \|/);
  await assert.rejects(execute(process.execPath, [target.script]), /owner build without access checks/);
  await assert.rejects(readFile(target.archive), { code: 'ENOENT' });
});

test('version and license metadata must agree before packaging', async context => {
  const target = await fixture(context);
  for (const metadata of [{ version: '0.3.0', license: 'GPL-3.0-or-later' }, { version: '0.4.0', license: 'MIT' }, { version: '0.4.0', license: 'SEE LICENSE IN LICENSE' }]) {
    await writeFile(path.join(target.root, 'package.json'), JSON.stringify(metadata));
    await assert.rejects(execute(process.execPath, [target.script]), /metadata does not match/);
  }
  await assert.rejects(readFile(target.archive), { code: 'ENOENT' });
});

test('release packaging rejects development configuration and stale configured bundles', async context => {
  const target = await fixture(context);
  const { keys, endpoint } = target.publicClient;
  const devKey = 'toLDfPrO8fWXuTTZlHlMvkN7bmE8ISLj0dwgpPq0FX4';
  for (const client of [
    { keys, endpoint: 'https://license.tangrow.invalid' },
    { keys, endpoint: 'http://licensing.tangrow.org' },
    { endpoint, keys: { 'dev-1': keys.release } },
    { endpoint, keys: { release: devKey } },
    { endpoint, keys: {} },
    { endpoint, keys: { release: 'malformed' } },
  ]) {
    await writeFile(target.config, JSON.stringify(client));
    await assert.rejects(execute(process.execPath, [target.script]), /before packaging/);
  }
  await writeFile(target.config, JSON.stringify({ keys, endpoint: 'https://another.tangrow.org' }));
  await assert.rejects(execute(process.execPath, [target.script]), /differs from the configured release source/);
  await assert.rejects(readFile(target.archive), { code: 'ENOENT' });
});
