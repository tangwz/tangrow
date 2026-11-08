import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { baseDefinitions, setupReadme } from '../src/bases';
import type { FocusSession, Locale, Settings } from '../src/types';
import type { MockApp, Plugin as MockPlugin, TFile as MockFile, TFolder as MockFolder, createMockApp as MockAppFactory } from './obsidian-mock';

interface TestPlugin extends MockPlugin {
  settings: Settings;
  focus: FocusSession | null;
  scratch: string;
  setup(): Promise<void>;
  setLanguage(language: Locale): Promise<void>;
  loadScratch(): string;
  startFocus(minutes: number): Promise<void>;
  pauseFocus(): Promise<void>;
  resumeFocus(): Promise<void>;
  cancelFocus(): Promise<void>;
  finishFocus(): Promise<void>;
  checkHabit(id: string): Promise<void>;
}
interface Harness {
  TangrowPlugin: new (app: MockApp) => TestPlugin;
  createMockApp: typeof MockAppFactory;
  TFile: typeof MockFile;
  TFolder: typeof MockFolder;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  absWorkingDir: repository,
  stdin: {
    contents: "export { default as TangrowPlugin } from './src/main'; export * from './tests/obsidian-mock';",
    resolveDir: repository,
    sourcefile: 'integration-entry.ts',
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
const harness = moduleObject.exports as Harness;

function createPlugin(): { plugin: TestPlugin; app: MockApp } {
  const app = harness.createMockApp();
  const plugin = new harness.TangrowPlugin(app);
  return { plugin, app };
}

function readFocus(plugin: TestPlugin): FocusSession | null {
  return structuredClone(plugin.focus);
}

function focusFiles(app: MockApp): MockFile[] {
  return app.vault.getMarkdownFiles().filter((file) => file.path.includes('/Records/Focus/'));
}

async function withClock(run: (advance: (minutes: number) => void) => Promise<void>): Promise<void> {
  const originalNow = Date.now;
  let now = Date.UTC(2026, 10, 8, 10, 0);
  Date.now = () => now;
  try { await run((minutes) => { now += minutes * 60_000; }); }
  finally { Date.now = originalNow; }
}

test('setup creates only missing companion files and is repeatable', async () => {
  const { plugin, app } = createPlugin();
  const note = app.vault.seedFile('20-Project/Existing project/Existing note.md', '# Existing note\n\nOriginal content.\n');
  const basePath = `${plugin.settings.supportFolder}/Tangrow Notes.base`;
  const customizedBase = app.vault.seedFile(basePath, 'views:\n  - type: table\n    name: My custom view\n');
  const originalNote = note.content;
  const originalBase = customizedBase.content;
  await plugin.setup();
  const created = [...app.vault.createdPaths];
  await plugin.setup();
  assert.deepEqual(app.vault.createdPaths, created);
  assert.equal(note.content, originalNote);
  assert.equal(customizedBase.content, originalBase);
  assert.equal(app.vault.getFiles().filter((file) => file.extension === 'base').length, 13);
  assert.ok(app.vault.getAbstractFileByPath(`${plugin.settings.supportFolder}/README.md`) instanceof harness.TFile);
  assert.equal(app.vault.getAbstractFileByPath(note.path), note);
});

test('failed focus state saves roll back start, pause, resume and discard', async () => {
  await withClock(async (advance) => {
    const { plugin } = createPlugin();
    plugin.saveFailures = 1;
    await assert.rejects(plugin.startFocus(25), /Simulated settings write failure/);
    assert.equal(plugin.focus, null);
    await plugin.startFocus(25);
    const running = readFocus(plugin);
    assert.ok(running);
    advance(5);
    plugin.saveFailures = 1;
    await assert.rejects(plugin.pauseFocus(), /Simulated settings write failure/);
    assert.deepEqual(plugin.focus, running);
    await plugin.pauseFocus();
    const paused = readFocus(plugin);
    assert.equal(paused?.endsAt, null);
    advance(10);
    plugin.saveFailures = 1;
    await assert.rejects(plugin.resumeFocus(), /Simulated settings write failure/);
    assert.deepEqual(plugin.focus, paused);
    await plugin.resumeFocus();
    const resumed = readFocus(plugin);
    assert.ok(resumed?.endsAt);
    plugin.saveFailures = 1;
    await assert.rejects(plugin.cancelFocus(), /Simulated settings write failure/);
    assert.deepEqual(plugin.focus, resumed);
    await plugin.cancelFocus();
    assert.equal(plugin.focus, null);
  });
});

test('concurrent and repeated focus finishes create exactly one completed record', async () => {
  await withClock(async (advance) => {
    const { plugin, app } = createPlugin();
    await plugin.startFocus(25);
    const sessionId = plugin.focus!.id;
    advance(5);
    await Promise.all([plugin.finishFocus(), plugin.finishFocus(), plugin.finishFocus()]);
    await plugin.finishFocus();
    assert.equal(focusFiles(app).length, 1);
    assert.equal(plugin.focus, null);
    const record = focusFiles(app)[0]!;
    assert.ok(record.path.endsWith(`/${sessionId}.md`));
    assert.equal(app.metadataCache.getFileCache(record).frontmatter?.tangrow_session_id, sessionId);
    assert.equal(app.metadataCache.getFileCache(record).frontmatter?.tangrow_minutes, 5);
  });
});

test('a saved focus record survives a failed session-clear save and retry does not duplicate it', async () => {
  await withClock(async (advance) => {
    const { plugin, app } = createPlugin();
    await plugin.startFocus(25);
    const session = readFocus(plugin);
    advance(3);
    plugin.saveFailures = 1;
    await assert.rejects(plugin.finishFocus(), /Simulated settings write failure/);
    assert.deepEqual(plugin.focus, session);
    assert.equal(focusFiles(app).length, 1);
    const originalContent = focusFiles(app)[0]!.content;
    advance(2);
    await plugin.finishFocus();
    assert.equal(plugin.focus, null);
    assert.equal(focusFiles(app).length, 1);
    assert.equal(focusFiles(app)[0]!.content, originalContent);
  });
});

test('occupied focus record paths are rejected without losing the active session', async () => {
  for (const occupiedBy of ['file', 'folder'] as const) {
    const { plugin, app } = createPlugin();
    await plugin.startFocus(25);
    const session = readFocus(plugin);
    const recordPath = `${plugin.settings.supportFolder}/Records/Focus/${session!.id}.md`;
    if (occupiedBy === 'file') app.vault.seedFile(recordPath, '# This file belongs to the user\n');
    else app.vault.seedFolder(recordPath);
    await assert.rejects(plugin.finishFocus(), /occupied|different|conflict|existing|record/i);
    assert.deepEqual(plugin.focus, session);
    if (occupiedBy === 'file') assert.equal((app.vault.getAbstractFileByPath(recordPath) as MockFile).content, '# This file belongs to the user\n');
    else assert.ok(app.vault.getAbstractFileByPath(recordPath) instanceof harness.TFolder);
  }
});

test('concurrent same-day habit check-ins create a single record', async () => {
  const { plugin, app } = createPlugin();
  const id = '123e4567-e89b-42d3-a456-426614174000';
  plugin.settings.habits = [{ id, name: 'Read a page' }];
  await Promise.all(Array.from({ length: 8 }, () => plugin.checkHabit(id)));
  await plugin.checkHabit(id);
  const records = app.vault.getMarkdownFiles().filter((file) => file.path.includes('/Records/Habits/'));
  assert.equal(records.length, 1);
  const properties = app.metadataCache.getFileCache(records[0]!).frontmatter;
  assert.equal(properties?.tangrow_habit_id, id);
  assert.equal(properties?.tangrow_kind, 'habit');
  assert.equal(properties?.tangrow_habit, 'Read a page');
});

function generatedFiles(settings: Settings): Map<string, string> {
  return new Map([
    ...baseDefinitions(settings).map((base) => [`${settings.supportFolder}/${base.filename}`, base.content] as const),
    [`${settings.supportFolder}/README.md`, setupReadme(settings)]
  ]);
}

function currentContents(app: MockApp): Map<string, string> {
  return new Map(app.vault.getFiles().map((file) => [file.path, file.content]));
}

test('language switches update exact generated presentation reversibly without changing file paths', async () => {
  const { plugin, app } = createPlugin();
  plugin.settings.language = 'en';
  await plugin.setup();
  const original = currentContents(app);
  const paths = [...app.vault.entries.keys()].sort();
  const created = [...app.vault.createdPaths];
  await plugin.setLanguage('zh-CN');
  assert.equal(plugin.settings.language, 'zh-CN');
  assert.deepEqual(currentContents(app), generatedFiles(plugin.settings));
  assert.notDeepEqual(currentContents(app), original);
  assert.equal(app.vault.processedPaths.length, 14);
  assert.deepEqual([...app.vault.entries.keys()].sort(), paths);
  assert.deepEqual(app.vault.createdPaths, created);
  const processed = [...app.vault.processedPaths];
  await plugin.setLanguage('zh-CN');
  assert.deepEqual(app.vault.processedPaths, processed);
  await plugin.setLanguage('en');
  assert.deepEqual(currentContents(app), original);
  assert.deepEqual([...app.vault.entries.keys()].sort(), paths);
  assert.deepEqual(app.vault.createdPaths, created);
});

test('language switches never process customized Bases, customized support instructions or user notes', async () => {
  const { plugin, app } = createPlugin();
  plugin.settings.language = 'en';
  const customBasePath = `${plugin.settings.supportFolder}/Tangrow Notes.base`;
  const customReadmePath = `${plugin.settings.supportFolder}/README.md`;
  const customBase = app.vault.seedFile(customBasePath, 'views:\n  - type: table\n    name: My handwritten view\n');
  const customReadme = app.vault.seedFile(customReadmePath, '# My companion instructions\n\nKeep my text exactly.\n');
  const note = app.vault.seedFile('20-Project/Existing project/User note.md', '# My own note\n\nKeep its wording and location.\n');
  await plugin.setup();
  const customContents = new Map([customBase, customReadme, note].map((file) => [file.path, file.content]));
  const customTimes = new Map([customBase, customReadme, note].map((file) => [file.path, file.stat.mtime]));
  const originalPaths = [...app.vault.entries.keys()].sort();
  await plugin.setLanguage('zh-CN');
  const expected = generatedFiles(plugin.settings);
  for (const file of app.vault.getFiles()) {
    assert.equal(file.content, customContents.get(file.path) ?? expected.get(file.path), file.path);
  }
  await plugin.setLanguage('en');
  for (const file of [customBase, customReadme, note]) {
    assert.equal(file.content, customContents.get(file.path), file.path);
    assert.equal(file.stat.mtime, customTimes.get(file.path), file.path);
    assert.ok(!app.vault.processedPaths.includes(file.path), file.path);
  }
  assert.equal(app.vault.processedPaths.length, 24);
  assert.deepEqual([...app.vault.entries.keys()].sort(), originalPaths);
});

test('failed language saves restore the locale before any generated file is processed', async () => {
  const { plugin, app } = createPlugin();
  plugin.settings.language = 'en';
  await plugin.setup();
  const original = currentContents(app);
  const modified = new Map(app.vault.getFiles().map((file) => [file.path, file.stat.mtime]));
  plugin.saveFailures = 1;
  await assert.rejects(plugin.setLanguage('zh-CN'), /Simulated settings write failure/);
  assert.equal(plugin.settings.language, 'en');
  assert.deepEqual(currentContents(app), original);
  assert.deepEqual(app.vault.processedPaths, []);
  assert.deepEqual(new Map(app.vault.getFiles().map((file) => [file.path, file.stat.mtime])), modified);
  await plugin.setLanguage('zh-CN');
  assert.deepEqual(currentContents(app), generatedFiles(plugin.settings));
});

test('language switches retain scratch text and a paused focus session in memory and persisted data', async () => {
  await withClock(async (advance) => {
    const { plugin } = createPlugin();
    plugin.settings.language = 'en';
    plugin.scratch = 'An unfinished thought with {literal} text.\nA second paragraph.';
    const scratch = plugin.loadScratch();
    await plugin.startFocus(25);
    advance(4);
    await plugin.pauseFocus();
    const paused = readFocus(plugin);
    assert.equal(paused?.remainingMs, 21 * 60_000);
    for (const language of ['zh-CN', 'en'] as const) {
      advance(2);
      await plugin.setLanguage(language);
      assert.equal(plugin.loadScratch(), scratch);
      assert.deepEqual(plugin.focus, paused);
      const saved = plugin.savedData as { settings: Settings; focus: FocusSession; scratch: string };
      assert.equal(saved.settings.language, language);
      assert.equal(saved.scratch, scratch);
      assert.deepEqual(saved.focus, paused);
    }
  });
});
