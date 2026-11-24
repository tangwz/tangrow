import esbuild from 'esbuild';
import { buildOptions, ownerBuildOptions } from './scripts/plugin-build.mjs';

const options = process.argv.includes('--owner') ? ownerBuildOptions : buildOptions;
if (process.argv.includes('--watch')) {
  const context = await esbuild.context({ ...options, sourcemap: 'inline' });
  await context.watch();
} else {
  await esbuild.build(options);
}
