import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Settings, Snapshot } from '../src/types';
import type { MockApp, Plugin as MockPlugin, createMockApp as MockAppFactory } from './obsidian-mock';

interface FolderLifecyclePlugin extends MockPlugin {
  settings: Settings;
  onload(): Promise<void>;
  setup(): Promise<void>;
  snapshot(): Snapshot;
  setLanguage(language: 'en' | 'zh-CN'): Promise<void>;
  updateFolderSetting(key: 'supportFolder', folder: string): Promise<void>;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await build({
  absWorkingDir: repository,
  stdin: {
    contents: "export { default as TangrowPlugin } from './src/main'; export * from './tests/obsidian-mock';",
    resolveDir: repository,
    loader: 'ts'
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  plugins: [{ name: 'mock-obsidian-lifecycle', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', output.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as {
  TangrowPlugin: new (app: MockApp) => FolderLifecyclePlugin;
  createMockApp: typeof MockAppFactory;
};

async function withLifecycleWindow(run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let nextId = 1;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout: () => nextId++, clearTimeout: () => {}, setInterval: () => nextId++, clearInterval: () => {} }
  });
  try { await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function fileContents(app: MockApp): Map<string, string> {
  return new Map(app.vault.getFiles().map((file) => [file.path, file.content]));
}

function persistedSettings(plugin: FolderLifecyclePlugin, supportFolder: string, language: 'en' | undefined = 'en'): unknown {
  const settings: Partial<Settings> = { ...plugin.settings, supportFolder };
  if (language === undefined) delete settings.language;
  else settings.language = language;
  return { version: 3, settings, focus: null, scratch: 'An existing unfinished draft.', composer: { capture: 'An existing capture.', scratchTitle: 'An existing title.' }, recentOpened: [] };
}

test('loading legacy companion folders preserves every original path and never invokes a folder move', async () => {
  await withLifecycleWindow(async () => {
    for (const language of ['en', undefined] as const) {
      const app = harness.createMockApp();
      const plugin = new harness.TangrowPlugin(app);
      const legacy = '10-Life(Meta)/Tangrow';
      app.vault.seedFile('20-Project/Existing project/Original note.md', '# Original note\n\nKeep this location and text.\n');
      app.vault.seedFile(`${legacy}/README.md`, '# Customized companion instructions\n');
      app.vault.seedFile(`${legacy}/Custom reference.md`, '# A user-owned reference\n');
      const before = fileContents(app);
      const paths = [...app.vault.entries.keys()].sort();
      let moves = 0;
      const rename = app.fileManager.renameFile;
      app.fileManager.renameFile = async (file, destination) => { moves++; await rename(file, destination); };
      plugin.savedData = persistedSettings(plugin, legacy, language);
      await plugin.onload();
      assert.equal(plugin.settings.supportFolder, legacy);
      assert.equal(app.vault.getAbstractFileByPath('99-Tangrow'), null);
      assert.deepEqual(fileContents(app), before);
      assert.deepEqual([...app.vault.entries.keys()].sort(), paths);
      assert.equal(moves, 0);
      assert.deepEqual(app.vault.createdPaths, []);
      assert.deepEqual(app.vault.processedPaths, []);
    }
  });
});

test('legacy folder conflicts remain visible and setup or language refresh cannot overwrite original notes', async () => {
  await withLifecycleWindow(async () => {
    const app = harness.createMockApp();
    const plugin = new harness.TangrowPlugin(app);
    app.vault.seedFile('20-Project/Original note.md', '# Project note\n');
    app.vault.seedFile('20-Project/README.md', '# Original project instructions\n');
    app.vault.seedFile('20-Project/Tangrow Notes.base', '# This Base belongs to the user\n');
    const before = fileContents(app);
    const paths = [...app.vault.entries.keys()].sort();
    plugin.savedData = persistedSettings(plugin, '20-Project');
    await plugin.onload();
    assert.equal(plugin.settings.supportFolder, '20-Project');
    assert.equal(plugin.snapshot().counts.notes, 2);
    assert.equal(plugin.snapshot().counts.projects, 2);
    assert.equal(plugin.snapshot().supportReady, false);
    await assert.rejects(plugin.setup(), /must not equal or contain/);
    await plugin.setLanguage('zh-CN');
    assert.deepEqual(fileContents(app), before);
    assert.deepEqual([...app.vault.entries.keys()].sort(), paths);
    assert.deepEqual(app.vault.createdPaths, []);
    assert.deepEqual(app.vault.processedPaths, []);
  });
});

test('legacy case-only companion aliases preserve content and reject setup before any writes', async () => {
  await withLifecycleWindow(async () => {
    for (const supportFolder of ['20-project', '20-PROJECT']) {
      const app = harness.createMockApp();
      const plugin = new harness.TangrowPlugin(app);
      app.vault.seedFile('20-Project/Original note.md', '# Original project note\n');
      app.vault.seedFile('20-Project/README.md', '# Original project instructions\n');
      const before = fileContents(app);
      const paths = [...app.vault.entries.keys()].sort();
      plugin.savedData = persistedSettings(plugin, supportFolder);
      await plugin.onload();
      assert.equal(plugin.settings.supportFolder, supportFolder);
      assert.equal(plugin.snapshot().counts.notes, 2);
      assert.equal(plugin.snapshot().counts.projects, 2);
      assert.equal(plugin.snapshot().supportReady, false);
      await assert.rejects(plugin.setup(), /must not equal or contain/);
      await plugin.setLanguage('zh-CN');
      assert.deepEqual(fileContents(app), before);
      assert.deepEqual([...app.vault.entries.keys()].sort(), paths);
      assert.deepEqual(app.vault.createdPaths, []);
      assert.deepEqual(app.vault.processedPaths, []);
    }
  });
});

test('case-only folder changes are rejected before their original spelling can be persisted', async () => {
  await withLifecycleWindow(async () => {
    const app = harness.createMockApp();
    const plugin = new harness.TangrowPlugin(app);
    const before = structuredClone(plugin.settings);
    await assert.rejects(plugin.updateFolderSetting('supportFolder', '20-project'), /must not equal or contain/);
    assert.deepEqual(plugin.settings, before);
    assert.equal(plugin.savedData, null);
    assert.deepEqual(app.vault.createdPaths, []);
    assert.deepEqual(app.vault.processedPaths, []);
  });
});

test('changing a legacy companion path only changes the setting and leaves the existing folder untouched', async () => {
  await withLifecycleWindow(async () => {
    const app = harness.createMockApp();
    const plugin = new harness.TangrowPlugin(app);
    const legacy = '10-Life(Meta)/Tangrow';
    app.vault.seedFile(`${legacy}/Tangrow Notes.base`, 'filters:\n  and:\n    - file.ext == "md"\n');
    app.vault.seedFile(`${legacy}/Original note.md`, '# Keep this original note in place\n');
    const before = fileContents(app);
    const paths = [...app.vault.entries.keys()].sort();
    let moves = 0;
    const rename = app.fileManager.renameFile;
    app.fileManager.renameFile = async (file, destination) => { moves++; await rename(file, destination); };
    plugin.savedData = persistedSettings(plugin, legacy);
    await plugin.onload();
    await plugin.updateFolderSetting('supportFolder', '99-Tangrow');
    assert.equal(plugin.settings.supportFolder, '99-Tangrow');
    assert.equal((plugin.savedData as { settings: Settings }).settings.supportFolder, '99-Tangrow');
    assert.equal(app.vault.getAbstractFileByPath('99-Tangrow'), null);
    assert.deepEqual(fileContents(app), before);
    assert.deepEqual([...app.vault.entries.keys()].sort(), paths);
    assert.equal(moves, 0);
    assert.deepEqual(app.vault.createdPaths, []);
    assert.deepEqual(app.vault.processedPaths, []);
  });
});
