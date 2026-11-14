import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.id !== 'tangrow' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)) {
  throw new Error('Unexpected plugin identity or version.');
}
if (metadata.version !== manifest.version || metadata.license !== 'GPL-3.0-or-later') {
  throw new Error('Package version or GPL license metadata does not match the release.');
}
const files = ['manifest.json', 'main.js', 'styles.css', 'LICENSE', 'NOTICE', 'LICENSE-MIT-LEGACY', 'THIRD_PARTY_NOTICES.md'];
for (const name of files) {
  const stat = await lstat(path.join(root, name));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular build file: ${name}`);
}
const banner = `/* Tangrow ${manifest.version} | GPL-3.0-or-later |`;
if (!(await readFile(path.join(root, 'main.js'), 'utf8')).startsWith(banner)) {
  throw new Error('The production bundle has a stale version or license banner. Run npm run build before packaging.');
}
const dist = path.join(root, 'dist');
try {
  const stat = await lstat(dist);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dist must be a regular directory.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dist, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), 'tangrow-package-'));
try {
  const plugin = path.join(temporary, 'tangrow');
  await mkdir(plugin);
  for (const name of files) await copyFile(path.join(root, name), path.join(plugin, name));
  const archive = path.join(temporary, 'tangrow.zip');
  await promisify(execFile)('zip', ['-q', '-r', archive, 'tangrow'], { cwd: temporary });
  const output = path.join(dist, `tangrow-${manifest.version}.zip`);
  const pending = `${output}.${randomUUID()}.tmp`;
  await copyFile(archive, pending);
  await rename(pending, output);
  console.log(output);
} finally { await rm(temporary, { recursive: true, force: true }); }
