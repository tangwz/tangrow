import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

export const buildOptions = {
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian'],
  minify: false,
  banner: { js: `/* Tangrow ${version} | GPL-3.0-or-later | Copyright (c) 2026 Terence | See LICENSE and NOTICE; legacy MIT: LICENSE-MIT-LEGACY */` }
};
