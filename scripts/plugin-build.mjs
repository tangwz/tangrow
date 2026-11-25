import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const notice = 'GPL-3.0-or-later | Copyright (c) 2026 Terence | See LICENSE and NOTICE; legacy MIT: LICENSE-MIT-LEGACY';

export const buildOptions = {
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian'],
  minify: false,
  define: { __TANGROW_OWNER_BUILD__: 'false' },
  banner: { js: `/* Tangrow ${version} | ${notice} */` }
};

export const ownerBanner = `/* Tangrow ${version} owner build, no access checks |`;

/** For the maintainer's own vaults: access is never restricted and no license requests are made. Never packaged. */
export const ownerBuildOptions = {
  ...buildOptions,
  define: { __TANGROW_OWNER_BUILD__: 'true' },
  banner: { js: `${ownerBanner} ${notice} */` }
};
