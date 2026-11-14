import esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile(new URL('./manifest.json', import.meta.url), 'utf8'));
const watch = process.argv.includes('--watch');
const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian'],
  sourcemap: watch ? 'inline' : false,
  minify: false,
  banner: { js: `/* Tangrow ${version} | GPL-3.0-or-later | Copyright (c) 2026 Terence | See LICENSE and NOTICE; legacy MIT: LICENSE-MIT-LEGACY */` }
});
if (watch) await context.watch();
else { await context.rebuild(); await context.dispose(); }
