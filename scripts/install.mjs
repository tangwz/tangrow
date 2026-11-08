import { copyFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = { vault: null, enable: false, dryRun: false };
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--vault') options.vault = args[++index];
  else if (arg === '--enable') options.enable = true;
  else if (arg === '--dry-run') options.dryRun = true;
  else if (arg === '--help') {
    console.log('Usage: npm run install:vault -- --vault /absolute/path/to/vault [--enable] [--dry-run]');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${arg}`);
}
if (!options.vault || !path.isAbsolute(options.vault)) {
  throw new Error('Provide an absolute vault path with --vault.');
}

async function inspect(target, expected) {
  let stat;
  try { stat = await lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${target}`);
  if (expected === 'directory' && !stat.isDirectory()) throw new Error(`Expected a directory: ${target}`);
  if (expected === 'file' && !stat.isFile()) throw new Error(`Expected a regular file: ${target}`);
  return true;
}

async function resolveFuturePath(target) {
  const suffix = [];
  let ancestor = target;
  while (true) {
    try { return path.join(await realpath(ancestor), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function atomicWrite(target, content) {
  await inspect(target, 'file');
  const temporary = `${target}.tangrow-${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx' });
  await rename(temporary, target);
}

const vault = await realpath(options.vault);
const config = path.join(vault, '.obsidian');
if (!(await inspect(config, 'directory'))) throw new Error('The vault must already contain an .obsidian directory.');
const plugins = path.join(config, 'plugins');
const destination = path.join(plugins, 'tangrow');
await inspect(plugins, 'directory');
await inspect(destination, 'directory');
const files = ['manifest.json', 'main.js', 'styles.css'];
for (const name of files) {
  if (!(await inspect(path.join(root, name), 'file'))) throw new Error(`Build output missing: ${name}. Run npm run build first.`);
  await inspect(path.join(destination, name), 'file');
}
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.id !== 'tangrow') throw new Error('The source manifest must use the tangrow plugin ID.');

const communityPath = path.join(config, 'community-plugins.json');
let communityContent = null;
let communityNext = null;
if (options.enable) {
  if (await inspect(communityPath, 'file')) communityContent = await readFile(communityPath, 'utf8');
  const community = communityContent === null ? [] : JSON.parse(communityContent);
  if (!Array.isArray(community) || !community.every(value => typeof value === 'string')) {
    throw new Error('community-plugins.json must contain an array of plugin IDs. No changes were made.');
  }
  if (!community.includes('tangrow')) communityNext = `${JSON.stringify([...community, 'tangrow'], null, 2)}\n`;
}

const existing = [];
for (const name of files) {
  if (await inspect(path.join(destination, name), 'file')) existing.push(name);
}
if (communityNext !== null && communityContent !== null) existing.push('community-plugins.json');
const stateRoot = await resolveFuturePath(path.resolve(homedir(), '.local', 'state', 'tangrow', 'backups'));
if (stateRoot === vault || stateRoot.startsWith(`${vault}${path.sep}`)) {
  throw new Error('The backup directory must be outside the vault.');
}
const backup = path.join(stateRoot, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
console.log(JSON.stringify({ dryRun: options.dryRun, vault, destination, files, enable: options.enable, backup: existing.length ? backup : null }, null, 2));
if (!options.dryRun) {
  if (existing.length) {
    await mkdir(backup, { recursive: true });
    for (const name of existing) {
      const source = name === 'community-plugins.json' ? communityPath : path.join(destination, name);
      await copyFile(source, path.join(backup, name));
    }
    await writeFile(path.join(backup, 'restore.json'), `${JSON.stringify({ vault, destination, files: existing }, null, 2)}\n`, { flag: 'wx' });
  }
  await mkdir(destination, { recursive: true });
  for (const name of files) await atomicWrite(path.join(destination, name), await readFile(path.join(root, name)));
  let communityConflict = false;
  if (communityNext !== null) {
    const latestContent = await inspect(communityPath, 'file') ? await readFile(communityPath, 'utf8') : null;
    if (latestContent !== communityContent) {
      communityConflict = true;
      process.exitCode = 1;
      console.error('Tangrow plugin files were installed, but community-plugins.json changed during installation.');
      console.error('The enabled plugin list was not edited. Enable Tangrow in Obsidian, or rerun the installer with --enable.');
    } else await atomicWrite(communityPath, communityNext);
  }
  if (!communityConflict) {
    console.log('Installed Tangrow. Existing notes, folders, workspace state and plugin data were preserved.');
    console.log('Reload Obsidian or enable Tangrow in Community plugins, then run Tangrow: Set up companion Bases.');
  }
} else console.log('Dry run complete. No files were written.');
