import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { baseDefinitions, setupReadme } from '../src/bases';
import { readSettings } from '../src/model';
import type { Settings } from '../src/types';
import type { MockApp, TFile as MockFile, createMockApp as MockAppFactory } from './obsidian-mock';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  absWorkingDir: repository,
  stdin: {
    contents: "export { moveSupportFolder } from './src/support-migration'; export * from './tests/obsidian-mock';",
    resolveDir: repository,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  plugins: [{ name: 'mock-obsidian', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundled.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as {
  createMockApp: typeof MockAppFactory;
  moveSupportFolder(app: MockApp, settings: Settings, destination: string, persist: () => Promise<void>): Promise<{ moved: boolean; preservedFiles: string[] }>;
};
const previousFolder = '10-Life(Meta)/Tangrow';
const targetFolder = '99-Tangrow';

function fixture(): { app: MockApp; settings: Settings } {
  const app = harness.createMockApp();
  const settings = readSettings({ supportFolder: previousFolder });
  for (const definition of baseDefinitions(settings)) app.vault.seedFile(`${previousFolder}/${definition.filename}`, definition.content);
  app.vault.seedFile(`${previousFolder}/README.md`, setupReadme(settings));
  return { app, settings };
}

function contents(app: MockApp): Map<string, string> {
  return new Map(app.vault.getFiles().map((file) => [file.path, file.content]));
}

test('migration moves records and refreshes generated files without touching other notes', async () => {
  const { app, settings } = fixture();
  const record = app.vault.seedFile(`${previousFolder}/Records/Focus/session.md`, '# Focus record\n');
  const outside = app.vault.seedFile('20-Project/Existing.md', '# Existing note\n');
  let saved: Settings | undefined;
  const result = await harness.moveSupportFolder(app, settings, targetFolder, async () => { saved = structuredClone(settings); });
  assert.deepEqual(result, { moved: true, preservedFiles: [] });
  assert.equal(saved?.supportFolder, targetFolder);
  assert.equal(app.vault.getAbstractFileByPath(previousFolder), null);
  assert.equal(record.path, `${targetFolder}/Records/Focus/session.md`);
  assert.equal(record.content, '# Focus record\n');
  assert.equal(outside.content, '# Existing note\n');
  for (const definition of baseDefinitions(settings)) {
    assert.equal((app.vault.getAbstractFileByPath(`${targetFolder}/${definition.filename}`) as MockFile).content, definition.content);
  }
  assert.equal((app.vault.getAbstractFileByPath(`${targetFolder}/README.md`) as MockFile).content, setupReadme(settings));
});

test('migration preserves customized Bases and reports them for manual review', async () => {
  const { app, settings } = fixture();
  const file = app.vault.getAbstractFileByPath(`${previousFolder}/Tangrow Notes.base`) as MockFile;
  file.content += '# Custom query note\n';
  const custom = file.content;
  const result = await harness.moveSupportFolder(app, settings, targetFolder, async () => {});
  assert.deepEqual(result.preservedFiles, ['Tangrow Notes.base']);
  assert.equal(file.path, `${targetFolder}/Tangrow Notes.base`);
  assert.equal(file.content, custom);
});

test('migration refuses occupied targets, overlapping paths, and unsafe source settings before writes', async () => {
  for (const occupied of ['file', 'folder']) {
    const { app, settings } = fixture();
    if (occupied === 'file') app.vault.seedFile(targetFolder, 'User data');
    else app.vault.seedFolder(targetFolder);
    const before = contents(app);
    await assert.rejects(harness.moveSupportFolder(app, settings, targetFolder, async () => assert.fail('Unexpected save')), /already exists/);
    assert.deepEqual(contents(app), before);
    assert.equal(settings.supportFolder, previousFolder);
  }
  const { app, settings } = fixture();
  await assert.rejects(harness.moveSupportFolder(app, settings, `${previousFolder}/Nested`, async () => {}), /inside the current/);
  settings.supportFolder = settings.projectFolder;
  await assert.rejects(harness.moveSupportFolder(app, settings, targetFolder, async () => {}), /must not equal or contain/);
  assert.equal(app.vault.getAbstractFileByPath(targetFolder), null);
});

test('a persistence failure rolls back folder paths, generated content, and persisted settings', async () => {
  const { app, settings } = fixture();
  const before = contents(app);
  let persisted = structuredClone(settings);
  let writes = 0;
  await assert.rejects(harness.moveSupportFolder(app, settings, targetFolder, async () => {
    persisted = structuredClone(settings);
    if (++writes === 1) throw new Error('Simulated settings failure after writing');
  }), /Simulated settings failure/);
  assert.equal(settings.supportFolder, previousFolder);
  assert.equal(persisted.supportFolder, previousFolder);
  assert.deepEqual(contents(app), before);
  assert.equal(app.vault.getAbstractFileByPath(targetFolder), null);
});

test('a generated-file write failure rolls back earlier file changes and the folder move', async () => {
  const { app, settings } = fixture();
  const before = contents(app);
  const process = app.vault.process.bind(app.vault);
  let writes = 0;
  app.vault.process = async (file, transform) => {
    if (++writes === 2) throw new Error('Simulated generated-file failure');
    return process(file, transform);
  };
  await assert.rejects(harness.moveSupportFolder(app, settings, targetFolder, async () => {}), /generated-file failure/);
  assert.deepEqual(contents(app), before);
  assert.equal(settings.supportFolder, previousFolder);
});

test('rollback preserves user edits made after generated content was updated', async () => {
  const { app, settings } = fixture();
  let writes = 0;
  const file = app.vault.getAbstractFileByPath(`${previousFolder}/Tangrow Notes.base`) as MockFile;
  await assert.rejects(harness.moveSupportFolder(app, settings, targetFolder, async () => {
    if (++writes === 1) {
      file.content = '# User edit during migration\n';
      throw new Error('Simulated settings failure');
    }
  }), /settings failure/);
  assert.equal(file.path, `${previousFolder}/Tangrow Notes.base`);
  assert.equal(file.content, '# User edit during migration\n');
});

test('an uninitialized old path updates settings without creating or merging folders', async () => {
  const app = harness.createMockApp();
  const settings = readSettings({ supportFolder: previousFolder });
  let writes = 0;
  assert.deepEqual(await harness.moveSupportFolder(app, settings, targetFolder, async () => { writes++; }), { moved: false, preservedFiles: [] });
  assert.equal(settings.supportFolder, targetFolder);
  assert.equal(app.vault.getFiles().length, 0);
  assert.equal(writes, 1);
  await harness.moveSupportFolder(app, settings, targetFolder, async () => { writes++; });
  assert.equal(writes, 1);
});

test('a forward rename that moves the folder before rejecting is fully rolled back', async () => {
  const { app, settings } = fixture();
  app.vault.seedFile(`${previousFolder}/Records/Focus/session.md`, '# Keep this session\n');
  const before = contents(app);
  const rename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (file, destination) => {
    await rename(file, destination);
    if (destination === targetFolder) throw new Error('Simulated link update failure after moving');
  };
  let persisted = structuredClone(settings);
  await assert.rejects(harness.moveSupportFolder(app, settings, targetFolder, async () => {
    persisted = structuredClone(settings);
  }), /Simulated link update failure/);
  assert.equal(settings.supportFolder, previousFolder);
  assert.equal(persisted.supportFolder, previousFolder);
  assert.deepEqual(contents(app), before);
  assert.equal(app.vault.getAbstractFileByPath(targetFolder), null);
});

test('a failed rollback keeps generated content and persisted settings at the actual new path', async () => {
  const { app, settings } = fixture();
  const record = app.vault.seedFile(`${previousFolder}/Records/Focus/session.md`, '# Keep this session\n');
  const rename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (file, destination) => {
    if (destination === previousFolder) throw new Error('Simulated rollback rename failure');
    await rename(file, destination);
  };
  let persisted = structuredClone(settings);
  let writes = 0;
  await assert.rejects(harness.moveSupportFolder(app, settings, targetFolder, async () => {
    persisted = structuredClone(settings);
    if (++writes === 1) throw new Error('Simulated settings failure after writing');
  }), /could not be fully rolled back/);
  assert.equal(settings.supportFolder, targetFolder);
  assert.equal(persisted.supportFolder, targetFolder);
  assert.equal(app.vault.getAbstractFileByPath(previousFolder), null);
  assert.equal(record.path, `${targetFolder}/Records/Focus/session.md`);
  assert.equal(record.content, '# Keep this session\n');
  for (const definition of baseDefinitions(settings)) {
    assert.equal((app.vault.getAbstractFileByPath(`${targetFolder}/${definition.filename}`) as MockFile).content, definition.content);
  }
  assert.equal((app.vault.getAbstractFileByPath(`${targetFolder}/README.md`) as MockFile).content, setupReadme(settings));
});

test('rollback never overwrites a user file created at the original folder path', async () => {
  const { app, settings } = fixture();
  const record = app.vault.seedFile(`${previousFolder}/Records/Focus/session.md`, '# Keep this session\n');
  let occupant: MockFile | undefined;
  let persisted = structuredClone(settings);
  let writes = 0;
  await assert.rejects(harness.moveSupportFolder(app, settings, targetFolder, async () => {
    persisted = structuredClone(settings);
    if (++writes === 1) {
      occupant = app.vault.seedFile(previousFolder, '# New unrelated user file\n');
      throw new Error('Simulated settings failure');
    }
  }), /could not be fully rolled back/);
  assert.ok(occupant);
  assert.equal(app.vault.getAbstractFileByPath(previousFolder), occupant);
  assert.equal(occupant.content, '# New unrelated user file\n');
  assert.equal(record.path, `${targetFolder}/Records/Focus/session.md`);
  assert.equal(record.content, '# Keep this session\n');
  assert.equal(settings.supportFolder, targetFolder);
  assert.equal(persisted.supportFolder, targetFolder);
  for (const definition of baseDefinitions(settings)) {
    assert.equal((app.vault.getAbstractFileByPath(`${targetFolder}/${definition.filename}`) as MockFile).content, definition.content);
  }
});

test('a rollback rename that moves before rejecting keeps old settings and generated content', async () => {
  const { app, settings } = fixture();
  const before = contents(app);
  const rename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (file, destination) => {
    await rename(file, destination);
    if (destination === previousFolder) throw new Error('Simulated rollback link update failure after moving');
  };
  let persisted = structuredClone(settings);
  let writes = 0;
  await assert.rejects(harness.moveSupportFolder(app, settings, targetFolder, async () => {
    persisted = structuredClone(settings);
    if (++writes === 1) throw new Error('Simulated settings failure after writing');
  }));
  assert.equal(settings.supportFolder, previousFolder);
  assert.equal(persisted.supportFolder, previousFolder);
  assert.deepEqual(contents(app), before);
  assert.equal(app.vault.getAbstractFileByPath(targetFolder), null);
});

test('host link rewrites are preserved while generated storage paths follow the moved folder', async () => {
  const { app, settings } = fixture();
  const rename = app.fileManager.renameFile;
  const shortLink = '[[Tangrow Notes.base|';
  const movedLink = `[[${targetFolder}/Tangrow Notes.base|`;
  app.fileManager.renameFile = async (file, destination) => {
    await rename(file, destination);
    if (destination === targetFolder) {
      const readme = app.vault.getAbstractFileByPath(`${targetFolder}/README.md`) as MockFile;
      readme.content = readme.content.replace(shortLink, movedLink);
    }
  };
  const result = await harness.moveSupportFolder(app, settings, targetFolder, async () => {});
  const readme = app.vault.getAbstractFileByPath(`${targetFolder}/README.md`) as MockFile;
  assert.deepEqual(result, { moved: true, preservedFiles: [] });
  assert.equal(readme.content, setupReadme(settings).replace(shortLink, movedLink));
  assert.equal(readme.content.includes(previousFolder), false);
});
