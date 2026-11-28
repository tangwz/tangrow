import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { FocusSession, Settings, Snapshot } from '../src/types';
import type { VaultStructurePatch, VaultStructureValues } from '../src/settings/vault-structure-data';
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
  updateVaultStructure(patch: VaultStructurePatch): Promise<void>;
  requireAccess(): boolean;
  onboardingVaultStructure(): VaultStructureValues;
  setupOnboardingVault(patch: VaultStructurePatch, createBases: boolean): Promise<void>;
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

test('a vault-structure change validates the whole set of paths and persists the candidate once', async () => {
  const { app, plugin } = fixture();
  app.vault.seedFolder('99-Tangrow/Projects');
  app.vault.seedFolder('System/New companion');
  const note = app.vault.seedFile('Work/Tasks.md', '# Existing Tasks query\n');
  await plugin.updateVaultStructure({ projectFolder: '99-Tangrow/Projects', supportFolder: 'System/New companion', taskOverviewPath: note.path });
  assert.equal(plugin.saveCalls, 1);
  assert.equal((plugin.savedData as { settings: Settings }).settings.projectFolder, '99-Tangrow/Projects');
  assert.equal((plugin.savedData as { settings: Settings }).settings.supportFolder, 'System/New companion');
  assert.equal((plugin.savedData as { settings: Settings }).settings.taskOverviewPath, note.path);
  assert.equal(note.content, '# Existing Tasks query\n');
  assert.deepEqual(app.vault.createdPaths, []);
  assert.deepEqual(app.vault.processedPaths, []);
});

test('failed vault-structure drafts neither persist invalid paths nor leave partially applied settings', async () => {
  const { app, plugin } = fixture();
  app.vault.seedFolder('Work/Projects');
  app.vault.seedFolder('System/Cards');
  const previous = structuredClone(plugin.settings);
  await assert.rejects(plugin.updateVaultStructure({ projectFolder: 'Work/Projects', taskOverviewPath: 'Work/Missing.md' }), /existing Tasks note/);
  assert.equal(plugin.saveCalls, 0);
  assert.deepEqual(plugin.settings, previous);

  const patch = { projectFolder: 'Work/Projects', cardFolder: 'System/Cards' };
  plugin.saveFailures = 1;
  await assert.rejects(plugin.updateVaultStructure(patch), /settings write failure/);
  assert.deepEqual(plugin.settings, previous);
  assert.equal(plugin.savedData, null);
  await plugin.updateVaultStructure(patch);
  assert.equal(plugin.settings.projectFolder, patch.projectFolder);
  assert.equal(plugin.settings.cardFolder, patch.cardFolder);
  assert.deepEqual(app.vault.createdPaths, []);
});

test('onboarding applies detected paths and adds missing Bases without touching existing vault content', async () => {
  const { app, plugin } = fixture();
  plugin.requireAccess = () => true;
  const note = app.vault.seedFile('1. 项目/Existing.md', '# User project\n');
  const tasks = app.vault.seedFile(plugin.settings.taskOverviewPath, '# User Tasks\n');
  const base = app.vault.seedFile('99-Tangrow/Tangrow Notes.base', '# Customized Base\n');
  const readme = app.vault.seedFile('99-Tangrow/README.md', '# Customized README\n');
  const mapped = plugin.onboardingVaultStructure();
  assert.equal(mapped.projectFolder, '1. 项目');

  await plugin.setupOnboardingVault(mapped, true);
  const created = [...app.vault.createdPaths];
  assert.ok(created.includes('00-Inbox'));
  assert.ok(created.includes('50-Zettel'));
  assert.ok(created.some((path) => path.endsWith('.base')));
  assert.ok(!created.includes('20-Project'));
  assert.equal(plugin.saveCalls, 1);
  assert.equal((plugin.savedData as { settings: Settings }).settings.projectFolder, '1. 项目');
  assert.equal(plugin.snapshot().supportReady, true);
  await plugin.setupOnboardingVault(mapped, true);
  assert.deepEqual(app.vault.createdPaths, created);
  assert.equal(plugin.saveCalls, 1);
  assert.equal(note.content, '# User project\n');
  assert.equal(tasks.content, '# User Tasks\n');
  assert.equal(base.content, '# Customized Base\n');
  assert.equal(readme.content, '# Customized README\n');
  assert.deepEqual(app.vault.processedPaths, []);
});

test('onboarding validates access, unchanged folder paths, and the optional companion folder before writes', async () => {
  const { app, plugin } = fixture();
  plugin.requireAccess = () => false;
  await assert.rejects(plugin.setupOnboardingVault({}, true), /Activate Tangrow/);
  plugin.requireAccess = () => true;
  const blocked = app.vault.seedFile('Blocked', 'User file');
  plugin.settings.cardFolder = 'Blocked/Cards';
  await assert.rejects(plugin.setupOnboardingVault({}, false), /blocks this folder path/);
  plugin.settings.cardFolder = '50-Zettel';
  plugin.settings.supportFolder = 'Blocked/Companion';
  await assert.rejects(plugin.setupOnboardingVault({}, true), /blocks this folder path/);
  assert.deepEqual(app.vault.createdPaths, []);
  assert.equal(plugin.saveCalls, 0);
  assert.equal(blocked.content, 'User file');
});

test('onboarding retries partial directory creation and failed mapping writes without recreating folders', async () => {
  const { app, plugin } = fixture();
  plugin.requireAccess = () => true;
  const createFolder = app.vault.createFolder.bind(app.vault);
  const patch = { projectFolder: 'Work/Projects' };
  app.vault.createFolder = async (path) => {
    if (path === 'Work/Projects') throw new Error('Folder write failed');
    await createFolder(path);
  };
  await assert.rejects(plugin.setupOnboardingVault(patch, false), /Folder write failed/);
  assert.deepEqual(app.vault.createdPaths, ['00-Inbox', 'Work']);
  assert.equal(plugin.settings.projectFolder, '20-Project');
  app.vault.createFolder = createFolder;
  plugin.saveFailures = 1;
  await assert.rejects(plugin.setupOnboardingVault(patch, false), /settings write failure/);
  assert.equal(plugin.settings.projectFolder, '20-Project');
  const created = [...app.vault.createdPaths];

  await plugin.setupOnboardingVault(patch, false);
  assert.deepEqual(app.vault.createdPaths, created);
  assert.equal(plugin.settings.projectFolder, patch.projectFolder);
  assert.equal(app.vault.getAbstractFileByPath(plugin.settings.supportFolder), null);
  assert.equal(app.vault.getAbstractFileByPath(plugin.settings.taskOverviewPath), null);
});

test('onboarding retains the saved mapping if optional Base creation needs a retry', async () => {
  const { app, plugin } = fixture();
  plugin.requireAccess = () => true;
  const patch = { projectFolder: 'Work/Projects' };
  app.vault.failCreates = 1;
  await assert.rejects(plugin.setupOnboardingVault(patch, true), /vault write failure/);
  assert.equal(plugin.settings.projectFolder, patch.projectFolder);
  assert.equal(plugin.saveCalls, 1);
  await plugin.setupOnboardingVault(patch, true);
  assert.equal(plugin.saveCalls, 1);
  assert.equal(plugin.snapshot().supportReady, true);
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
