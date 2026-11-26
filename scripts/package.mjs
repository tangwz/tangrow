import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { buildOptions, ownerBanner, root } from './plugin-build.mjs';

const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.id !== 'tangrow' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)) {
  throw new Error('Unexpected plugin identity or version.');
}
if (metadata.version !== manifest.version || metadata.license !== 'GPL-3.0-or-later') {
  throw new Error('Package version or GPL license metadata does not match the release.');
}
const files = ['manifest.json', 'main.js', 'styles.css', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md'];
for (const name of files) {
  const stat = await lstat(path.join(root, name));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular build file: ${name}`);
}
const banner = `/* Tangrow ${manifest.version} | GPL-3.0-or-later |`;
const bundle = await readFile(path.join(root, 'main.js'));
if (bundle.toString('utf8').startsWith(ownerBanner)) {
  throw new Error('main.js is an owner build without access checks and must not be released. Run npm run build before packaging.');
}
if (!bundle.toString('utf8').startsWith(banner)) {
  throw new Error('The production bundle has a stale version or license banner. Run npm run build before packaging.');
}
const client = JSON.parse(await readFile(path.join(root, 'src/license/client.json'), 'utf8'));
if (!client || Object.keys(client).some(name => name !== 'endpoint' && name !== 'keys')) {
  throw new Error('Only the public endpoint and verification keys belong in the client configuration.');
}
const url = new URL(client.endpoint);
const hostname = url.hostname.replace(/\.$/, '');
if (url.protocol !== 'https:' || client.endpoint !== url.origin || !hostname.includes('.') ||
    /(?:^|\.)(?:invalid|localhost|test|example)$/.test(hostname) ||
    /(?:^|\.)example\.(?:com|net|org)$/.test(hostname) || /^127\.\d+\.\d+\.\d+$/.test(hostname)) {
  throw new Error('Configure the production HTTPS license origin before packaging.');
}
const developmentKey = 'toLDfPrO8fWXuTTZlHlMvkN7bmE8ISLj0dwgpPq0FX4';
if (!client.keys || typeof client.keys !== 'object' || Array.isArray(client.keys) ||
    !Object.keys(client.keys).length || Object.entries(client.keys).some(([kid, key]) =>
      !/^[A-Za-z0-9_-]{1,64}$/.test(kid) || kid === 'dev-1' || key === developmentKey ||
      typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key) ||
      Buffer.from(key, 'base64url').toString('base64url') !== key)) {
  throw new Error('Configure production Ed25519 public keys before packaging.');
}
// Compare the exact artifact to catch a stale development build after configuration changes.
const rebuilt = await build({ ...buildOptions, write: false });
if (!bundle.equals(rebuilt.outputFiles[0].contents)) {
  throw new Error('Bundle differs from the configured release source. Run npm run build before packaging.');
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
  for (const name of files) {
    if (name === 'main.js') await writeFile(path.join(plugin, name), bundle);
    else await copyFile(path.join(root, name), path.join(plugin, name));
  }
  const archive = path.join(temporary, 'tangrow.zip');
  await promisify(execFile)('zip', ['-q', '-r', archive, 'tangrow'], { cwd: temporary });
  const output = path.join(dist, `tangrow-${manifest.version}.zip`);
  const pending = `${output}.${randomUUID()}.tmp`;
  await copyFile(archive, pending);
  await rename(pending, output);
  console.log(output);
} finally { await rm(temporary, { recursive: true, force: true }); }
