import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { FocusSession, Settings, Snapshot } from '../src/types';
import type { MockApp, Plugin as MockPlugin, createMockApp as MockAppFactory } from './obsidian-mock';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  absWorkingDir: repository,
  stdin: { contents: "export { default as TangrowPlugin } from './src/main'; export * from './tests/obsidian-mock';", resolveDir: repository, loader: 'ts' },
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
interface TestPlugin extends MockPlugin {
  settings: Settings;
  focus: FocusSession | null;
  snapshot(): Snapshot;
  setup(): Promise<void>;
  updateFolderSetting(key: 'supportFolder' | 'projectFolder', value: string): Promise<void>;
  migrateCompanionFolder(): Promise<void>;
  startFocus(minutes: number): Promise<void>;
  finishFocus(): Promise<void>;
  checkHabit(id: string): Promise<void>;
}
const harness = moduleObject.exports as { TangrowPlugin: new (app: MockApp) => TestPlugin; createMockApp: typeof MockAppFactory };

function fixture(): { app: MockApp; plugin: TestPlugin } {
  const app = harness.createMockApp();
  const plugin = new harness.TangrowPlugin(app);
  return { app, plugin };
}

test('both companion and content folder changes reject collisions without saving', async () => {
  const { plugin } = fixture();
  const before = structuredClone(plugin.settings);
  await assert.rejects(plugin.updateFolderSetting('supportFolder', '20-Project'), /must not equal or contain/);
  await assert.rejects(plugin.updateFolderSetting('projectFolder', '99-Tangrow/Projects'), /must not equal or contain/);
  assert.deepEqual(plugin.settings, before);
  assert.equal(plugin.savedData, null);
});

test('serialized folder changes validate against the latest settings', async () => {
  const { plugin } = fixture();
  const results = await Promise.allSettled([
    plugin.updateFolderSetting('supportFolder', 'Companion'),
    plugin.updateFolderSetting('projectFolder', 'Companion/Projects')
  ]);
  assert.equal(results[0]?.status, 'fulfilled');
  assert.equal(results[1]?.status, 'rejected');
  assert.equal(plugin.settings.supportFolder, 'Companion');
  assert.equal(plugin.settings.projectFolder, '20-Project');
});

test('legacy conflicting settings keep user notes visible and block companion file writes', async () => {
  const { app, plugin } = fixture();
  app.vault.seedFile('20-Project/Existing.md', '# Existing\n\n- [ ] Keep this task\n');
  plugin.settings.supportFolder = plugin.settings.projectFolder;
  const snapshot = plugin.snapshot();
  assert.equal(snapshot.counts.notes, 1);
  assert.equal(snapshot.counts.projects, 1);
  assert.equal(snapshot.counts.tasks, 1);
  assert.equal(snapshot.supportReady, false);
  await assert.rejects(plugin.setup(), /must not equal or contain/);
  await assert.rejects(plugin.startFocus(25), /must not equal or contain/);
  await assert.rejects(plugin.checkHabit('read'), /must not equal or contain/);
  assert.deepEqual(app.vault.createdPaths, []);
  assert.equal(plugin.settings.supportFolder, '20-Project');
});

test('a conflicting setting cannot write or clear an existing focus session', async () => {
  const { app, plugin } = fixture();
  await plugin.startFocus(25);
  const session = structuredClone(plugin.focus);
  plugin.settings.supportFolder = plugin.settings.projectFolder;
  await assert.rejects(plugin.finishFocus(), /must not equal or contain/);
  assert.deepEqual(plugin.focus, session);
  assert.deepEqual(app.vault.createdPaths, []);
});

test('folder persistence failures preserve the previous path and can be retried', async () => {
  const { plugin } = fixture();
  plugin.saveFailures = 1;
  await assert.rejects(plugin.updateFolderSetting('supportFolder', 'Dedicated/Tangrow'), /settings write failure/);
  assert.equal(plugin.settings.supportFolder, '99-Tangrow');
  await plugin.updateFolderSetting('supportFolder', 'Dedicated/Tangrow');
  assert.equal(plugin.settings.supportFolder, 'Dedicated/Tangrow');
});

test('the migration entry preserves active-session references and generated view readiness', async () => {
  const { app, plugin } = fixture();
  plugin.settings.supportFolder = '10-Life(Meta)/Tangrow';
  await plugin.setup();
  const source = app.vault.seedFile('10-Life(Meta)/Tangrow/Custom.md', '# Existing companion note\n');
  app.workspace.setActiveFile(source);
  await plugin.startFocus(25);
  await plugin.migrateCompanionFolder();
  assert.equal(plugin.settings.supportFolder, '99-Tangrow');
  assert.equal(plugin.focus?.filePath, '99-Tangrow/Custom.md');
  assert.equal(plugin.snapshot().supportReady, true);
  assert.equal(app.vault.getAbstractFileByPath('10-Life(Meta)/Tangrow'), null);
});
