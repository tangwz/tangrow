import esbuild from 'esbuild';
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
  banner: { js: '/* Tangrow | MIT License | Copyright (c) 2026 Terence */' }
});
if (watch) await context.watch();
else { await context.rebuild(); await context.dispose(); }
