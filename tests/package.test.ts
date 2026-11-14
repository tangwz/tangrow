import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const packager = fileURLToPath(new URL('../scripts/package.mjs', import.meta.url));
const files = ['manifest.json', 'main.js', 'styles.css', 'LICENSE', 'NOTICE', 'LICENSE-MIT-LEGACY', 'THIRD_PARTY_NOTICES.md'];

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'tangrow-package-test-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'package.mjs');
  await copyFile(packager, script);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '0.4.0', license: 'GPL-3.0-or-later' }));
  for (const name of files) {
    const content = name === 'manifest.json' ? JSON.stringify({ id: 'tangrow', version: '0.4.0' })
      : name === 'main.js' ? '/* Tangrow 0.4.0 | GPL-3.0-or-later | See LICENSE and NOTICE */\n'
        : `Original ${name}\n`;
    await writeFile(path.join(root, name), content);
  }
  return { root, script, archive: path.join(root, 'dist', 'tangrow-0.4.0.zip') };
}

test('the release archive includes GPL, additional permissions, legacy MIT and third-party notices unchanged', async context => {
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

for (const missing of ['LICENSE', 'NOTICE', 'LICENSE-MIT-LEGACY', 'THIRD_PARTY_NOTICES.md']) {
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

test('version and license metadata must agree before packaging', async context => {
  const target = await fixture(context);
  for (const metadata of [{ version: '0.3.0', license: 'GPL-3.0-or-later' }, { version: '0.4.0', license: 'MIT' }, { version: '0.4.0', license: 'SEE LICENSE IN LICENSE' }]) {
    await writeFile(path.join(target.root, 'package.json'), JSON.stringify(metadata));
    await assert.rejects(execute(process.execPath, [target.script]), /metadata does not match/);
  }
  await assert.rejects(readFile(target.archive), { code: 'ENOENT' });
});
