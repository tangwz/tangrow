import esbuild from 'esbuild';
import { buildOptions } from './scripts/plugin-build.mjs';

if (process.argv.includes('--watch')) {
  const context = await esbuild.context({ ...buildOptions, sourcemap: 'inline' });
  await context.watch();
} else {
  await esbuild.build(buildOptions);
}
