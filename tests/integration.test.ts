import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { baseDefinitions, setupReadme } from '../src/bases';
import { aggregateReport } from '../src/report-data';
import type { ActionId, ComposerState, FocusSession, Locale, NoteKind, Settings, Snapshot } from '../src/types';
import type { FileView as MockFileView, ItemView as MockItemView, MarkdownView as MockMarkdownView, MockApp, Plugin as MockPlugin, TFile as MockFile, TFolder as MockFolder, createMockApp as MockAppFactory } from './obsidian-mock';

type FolderSettingKey = keyof Pick<Settings, 'supportFolder' | 'inboxFolder' | 'projectFolder' | 'areaFolder' | 'resourcesFolder' | 'archiveFolder' | 'journalFolder'>;

interface TestPlugin extends MockPlugin {
  settings: Settings;
  focus: FocusSession | null;
  scratch: string;
  writes: Promise<unknown>;
  onload(): Promise<void>;
  setup(): Promise<void>;
  openNote(path: string, line?: number): Promise<void>;
  openBase(id: 'captures'): Promise<void>;
  snapshot(): Snapshot;
  action(id: ActionId): Promise<void>;
  createNote(kind: NoteKind, title: string, projectFolder?: string): Promise<void>;
  updateFolderSetting(key: FolderSettingKey, path: string): Promise<void>;
  setLanguage(language: Locale): Promise<void>;
  loadScratch(): string;
  saveScratch(value: string): void;
  loadComposer(): ComposerState;
  saveComposer(patch: Partial<ComposerState>): void;
  subscribe(listener: () => void): () => void;
  subscribeComposer(listener: () => void): () => void;
  submitCaptureDraft(): Promise<void>;
  readCapture(path: string): Promise<string>;
  startFocus(minutes: number): Promise<void>;
  pauseFocus(): Promise<void>;
  resumeFocus(): Promise<void>;
  cancelFocus(): Promise<void>;
  finishFocus(): Promise<void>;
  addHabit(name: string): Promise<void>;
  archiveHabit(id: string): Promise<void>;
  checkHabit(id: string): Promise<void>;
}
interface Harness {
  TangrowPlugin: new (app: MockApp) => TestPlugin;
  createMockApp: typeof MockAppFactory;
  TFile: typeof MockFile;
  TFolder: typeof MockFolder;
  MarkdownView: typeof MockMarkdownView;
  FileView: typeof MockFileView;
  ItemView: typeof MockItemView;
  notices: string[];
  Platform: { isDesktopApp: boolean };
  openCaptureWindow(app: unknown, host: unknown): Promise<void>;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  absWorkingDir: repository,
  stdin: {
    contents: "export { default as TangrowPlugin } from './src/main'; export { openCaptureWindow } from './src/capture-window'; export * from './tests/obsidian-mock';",
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
    plugin.settings.language = 'en';
    await plugin.startFocus(25);
    const session = readFocus(plugin);
    advance(3);
    plugin.saveFailures = 1;
    await assert.rejects(plugin.finishFocus(), /Simulated settings write failure/);
    assert.equal(plugin.focus?.id, session?.id);
    assert.equal(plugin.focus?.endsAt, null);
    assert.equal(plugin.focus?.remainingMs, 22 * 60_000);
    assert.equal(focusFiles(app).length, 1);
    const originalContent = focusFiles(app)[0]!.content;
    advance(2);
    await plugin.finishFocus();
    assert.equal(plugin.focus, null);
    assert.equal(focusFiles(app).length, 1);
    assert.equal(focusFiles(app)[0]!.content, originalContent);
    assert.equal(harness.notices.at(-1), 'Focus saved: 3 minutes.');
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

interface TestTimers { flush(): void }

async function withWindow(run: (timers: TestTimers) => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let nextId = 1;
  const timeouts = new Map<number, () => void>();
  const fakeWindow = {
    setTimeout(callback: () => void): number { const id = nextId++; timeouts.set(id, callback); return id; },
    clearTimeout(id: number | undefined): void { if (id !== undefined) timeouts.delete(id); },
    setInterval(): number { return nextId++; },
    clearInterval(): void {}
  };
  Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });
  try {
    await run({ flush: () => {
      const callbacks = [...timeouts.values()];
      timeouts.clear();
      callbacks.forEach((callback) => callback());
    } });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('legacy composer defaults preserve scratch text and debounced patches recover after reload', async () => {
  await withWindow(async (timers) => {
    const { plugin } = createPlugin();
    plugin.savedData = { version: 1, settings: { ...plugin.settings, language: 'en' }, focus: null, scratch: 'The existing scratch body.' };
    await plugin.onload();
    assert.deepEqual(plugin.loadComposer(), { capture: '', scratchTitle: '' });
    assert.equal(plugin.loadScratch(), 'The existing scratch body.');
    const initialSaves = plugin.saveCalls;
    plugin.saveComposer({ capture: 'An unfinished capture.' });
    plugin.saveComposer({ scratchTitle: 'A working title' });
    plugin.saveComposer({ capture: 'The latest unfinished capture.' });
    plugin.saveScratch('A revised scratch body.');
    assert.equal(plugin.saveCalls, initialSaves);
    assert.deepEqual(plugin.loadComposer(), { capture: 'The latest unfinished capture.', scratchTitle: 'A working title' });
    const detached = plugin.loadComposer();
    detached.capture = 'An accidental caller mutation.';
    assert.equal(plugin.loadComposer().capture, 'The latest unfinished capture.');
    timers.flush();
    await plugin.writes;
    assert.equal(plugin.saveCalls, initialSaves + 1);
    const { plugin: reopened } = createPlugin();
    reopened.savedData = structuredClone(plugin.savedData);
    await reopened.onload();
    assert.deepEqual(reopened.loadComposer(), { capture: 'The latest unfinished capture.', scratchTitle: 'A working title' });
    assert.equal(reopened.loadScratch(), 'A revised scratch body.');
  });
});

test('failed habit creation and archival roll back so a retry can succeed', async () => {
  const { plugin } = createPlugin();
  plugin.saveFailures = 1;
  await assert.rejects(plugin.addHabit('Read a page'), /Simulated settings write failure/);
  assert.equal(plugin.settings.habits.length, 0);
  await plugin.addHabit('Read a page');
  assert.equal(plugin.settings.habits.length, 1);
  const habit = structuredClone(plugin.settings.habits[0]!);
  const saved = structuredClone(plugin.savedData);
  plugin.saveFailures = 1;
  await assert.rejects(plugin.archiveHabit(habit.id), /Simulated settings write failure/);
  assert.deepEqual(plugin.settings.habits, [habit]);
  assert.deepEqual(plugin.savedData, saved);
  await plugin.archiveHabit(habit.id);
  assert.deepEqual(plugin.settings.habits, []);
  assert.deepEqual((plugin.savedData as { settings: Settings }).settings.habits, []);
});

test('editor actions prefer the active split, then the recent editor, then the first matching editor', async () => {
  const { plugin, app } = createPlugin();
  const note = app.vault.seedFile('00-Inbox/Shared note.md', '# Shared note\n');
  const left = new harness.MarkdownView();
  const right = new harness.MarkdownView();
  left.file = note;
  right.file = note;
  app.workspace.rootLeaves.push({ view: left }, { view: right });
  app.workspace.setActiveView(left);
  app.workspace.setMostRecentLeaf({ view: right });
  await plugin.action('timestamp');
  assert.equal(left.inserted.length, 1);
  assert.equal(right.inserted.length, 0);
  app.workspace.setActiveView(null);
  app.workspace.setMostRecentLeaf({ view: right });
  await plugin.action('fold');
  assert.deepEqual(right.commands, ['foldAll']);
  assert.deepEqual(left.commands, []);
  const fileView = new harness.FileView();
  fileView.file = note;
  app.workspace.setMostRecentLeaf({ view: fileView });
  await plugin.action('unfold');
  assert.deepEqual(left.commands, ['unfoldAll']);
  assert.deepEqual(right.commands, ['foldAll']);
});

test('Base files retain file tools while Markdown edits explicitly reject the active Base', async () => {
  const { plugin, app } = createPlugin();
  plugin.settings.language = 'en';
  const note = app.vault.seedFile('00-Inbox/Previously active note.md', '# Keep me unchanged\n');
  const editor = new harness.MarkdownView();
  editor.file = note;
  app.workspace.rootLeaves.push({ view: editor });
  app.workspace.setMostRecentLeaf({ view: editor });
  const base = app.vault.seedFile('10-Life(Meta)/Tangrow/Tangrow Notes.base', 'views: []\n');
  app.workspace.setActiveFile(base);
  assert.equal(plugin.snapshot().active?.path, base.path);
  assert.equal(plugin.snapshot().widePage, false);
  for (const action of ['timestamp', 'title-date', 'fold', 'unfold', 'toggle-pin', 'cover', 'page-width'] as const) {
    await assert.rejects(plugin.action(action), /Markdown note|editor/);
  }
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const copied: string[] = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string): Promise<void> => { copied.push(text); } } } });
  try {
    await plugin.action('copy-path');
    await plugin.action('copy-link');
    await plugin.action('file-location');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
  assert.deepEqual(copied, [base.path, `[[${base.path}]]`]);
  assert.deepEqual(app.workspace.locatedFiles, [base.path]);
  assert.deepEqual(editor.inserted, []);
  assert.deepEqual(editor.commands, []);
  assert.equal(note.content, '# Keep me unchanged\n');
  assert.equal(base.content, 'views: []\n');
});

test('support readiness requires every Base and the support instructions', async () => {
  const { plugin, app } = createPlugin();
  const definitions = baseDefinitions(plugin.settings);
  for (const base of definitions.slice(0, -1)) app.vault.seedFile(`${plugin.settings.supportFolder}/${base.filename}`, base.content);
  assert.equal(plugin.snapshot().supportReady, false);
  await plugin.setup();
  assert.equal(plugin.snapshot().supportReady, true);
  const readme = `${plugin.settings.supportFolder}/README.md`;
  app.vault.entries.delete(readme);
  await plugin.setLanguage('en');
  assert.equal(plugin.snapshot().supportReady, false);
  await plugin.setup();
  assert.equal(plugin.snapshot().supportReady, true);
});

test('new project notes use project subfolders and existing destinations stay within the project tree', async () => {
  const { plugin, app } = createPlugin();
  app.vault.seedFolder('20-Project/Existing project');
  app.vault.seedFolder('20-Project/Existing project/Research');
  app.vault.seedFolder('20-Project-Other/Unrelated');
  app.vault.seedFolder('40-Resources/Outside');
  const original = app.vault.seedFile('20-Project/Existing project/Overview.md', '# Keep this project\n');
  assert.deepEqual(plugin.snapshot().projectFolders, ['20-Project/Existing project', '20-Project/Existing project/Research']);
  const originalCreated = [...app.vault.createdPaths];
  await assert.rejects(plugin.createNote('project', 'Existing project'));
  assert.deepEqual(app.vault.createdPaths, originalCreated);
  await plugin.createNote('project', 'New project');
  assert.ok(app.vault.getAbstractFileByPath('20-Project/New project/New project.md') instanceof harness.TFile);
  assert.equal(app.vault.getAbstractFileByPath('20-Project/New project.md'), null);
  await plugin.createNote('project', 'Research note', '20-Project/Existing project');
  assert.ok(app.vault.getAbstractFileByPath('20-Project/Existing project/Research note.md') instanceof harness.TFile);
  const created = [...app.vault.createdPaths];
  for (const destination of ['20-Project', '20-Project/Missing project', '40-Resources/Outside', '20-Project-Other/Unrelated', '../Outside']) {
    await assert.rejects(plugin.createNote('project', 'Must not be created', destination));
  }
  assert.deepEqual(app.vault.createdPaths, created);
  assert.equal(original.content, '# Keep this project\n');
});

test('unfinished task summaries include in-progress checkboxes and exclude completed or cancelled ones', async () => {
  const { plugin, app } = createPlugin();
  const note = app.vault.seedFile('00-Inbox/Task sources.md', '# Task sources\n\n- [ ] Todo item\n- [/] Working item\n- [x] Completed item\n- [-] Cancelled item\n');
  const state = plugin.snapshot();
  assert.equal(state.counts.tasks, 2);
  assert.deepEqual(state.tasks.map(({ path, line, done }) => ({ path, line, done })), [
    { path: note.path, line: 2, done: false },
    { path: note.path, line: 3, done: false }
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(plugin.snapshot().tasks.map((task) => task.text), ['Todo item', 'Working item']);
});

test('invalid persisted focus minutes do not clear the active session or overwrite the conflicting record', async () => {
  for (const minutes of [-1, '3', null, 26]) {
    const { plugin, app } = createPlugin();
    await plugin.startFocus(25);
    const session = readFocus(plugin)!;
    const content = `---\ntangrow_kind: "focus"\ntangrow_session_id: "${session.id}"\ntangrow_day: "2026-11-08"\ntangrow_minutes: ${JSON.stringify(minutes)}\n---\n`;
    const existing = app.vault.seedFile(`${plugin.settings.supportFolder}/Records/Focus/${session.id}.md`, content);
    await assert.rejects(plugin.finishFocus());
    assert.deepEqual(plugin.focus, session);
    assert.equal(existing.content, content);
  }
});

test('task overview opens only the existing configured note and never creates a parallel task system', async () => {
  const { plugin, app } = createPlugin();
  const originalCreated = [...app.vault.createdPaths];
  await assert.rejects(plugin.action('task-overview'));
  assert.deepEqual(app.vault.createdPaths, originalCreated);
  const note = app.vault.seedFile(plugin.settings.taskOverviewPath, '# My existing task system\n');
  await plugin.action('task-overview');
  assert.equal(app.workspace.getActiveFile(), note);
  assert.equal(note.content, '# My existing task system\n');
  assert.deepEqual(app.vault.createdPaths, originalCreated);
});

test('heading dates use the live editor buffer, preserve selections and leave the backing path unchanged', async () => {
  await withClock(async () => {
    const { plugin, app } = createPlugin();
    const note = app.vault.seedFile('00-Inbox/Working draft.md', '# Previously saved title\n\nPreviously saved paragraph.\n');
    const view = new harness.MarkdownView();
    view.file = note;
    view.editor.setValue('# Working title\n\nAn unsaved paragraph.\n');
    const selections = [
      { anchor: { line: 2, ch: 3 }, head: { line: 2, ch: 10 } },
      { anchor: { line: 2, ch: 13 }, head: { line: 2, ch: 13 } }
    ];
    view.editor.setSelections(selections);
    app.workspace.rootLeaves.push({ view });
    app.workspace.setActiveView(view);
    await plugin.action('title-date');
    assert.equal(view.editor.getValue(), '# Working title · 2026-11-08\n\nAn unsaved paragraph.\n');
    assert.deepEqual(view.editor.listSelections(), selections);
    assert.equal(view.editor.replacements.length, 1);
    assert.ok(!view.editor.replacements[0]!.text.includes('An unsaved paragraph.'));
    assert.equal(note.path, '00-Inbox/Working draft.md');
    assert.equal(note.content, '# Previously saved title\n\nPreviously saved paragraph.\n');
    assert.deepEqual(app.vault.processedPaths, []);
    await plugin.action('title-date');
    assert.equal(view.editor.replacements.length, 1);
  });
});

test('heading dates fall back to atomic vault processing when no live Markdown editor exists', async () => {
  await withClock(async () => {
    const { plugin, app } = createPlugin();
    const note = app.vault.seedFile('00-Inbox/Reading note.md', '# Reading note\n\nKeep this paragraph.\n');
    app.workspace.setActiveFile(note);
    await plugin.action('title-date');
    assert.equal(note.content, '# Reading note · 2026-11-08\n\nKeep this paragraph.\n');
    assert.equal(note.path, '00-Inbox/Reading note.md');
    assert.deepEqual(app.vault.processedPaths, [note.path]);
  });
});

test('occupied habit check-in paths are rejected without rewriting unrelated data', async () => {
  const id = '123e4567-e89b-42d3-a456-426614174000';
  for (const occupiedBy of ['file', 'folder', 'wrong-record'] as const) {
    const { plugin, app } = createPlugin();
    plugin.settings.habits = [{ id, name: 'Read a page' }];
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const recordPath = `${plugin.settings.supportFolder}/Records/Habits/${today}-${id}.md`;
    const content = occupiedBy === 'wrong-record'
      ? `---\ntangrow_kind: "habit"\ntangrow_habit_id: "another-id"\ntangrow_day: "${today}"\n---\n`
      : '# This file belongs to the user\n';
    if (occupiedBy === 'folder') app.vault.seedFolder(recordPath);
    else app.vault.seedFile(recordPath, content);
    await assert.rejects(plugin.checkHabit(id));
    assert.deepEqual(plugin.settings.habits, [{ id, name: 'Read a page' }]);
    if (occupiedBy === 'folder') assert.ok(app.vault.getAbstractFileByPath(recordPath) instanceof harness.TFolder);
    else assert.equal((app.vault.getAbstractFileByPath(recordPath) as MockFile).content, content);
    assert.deepEqual(app.vault.createdPaths, []);
  }
});

test('a completed focus record blocks resume and reload recovers the stopped session without losing composers', async () => {
  await withWindow(async () => {
    await withClock(async (advance) => {
      const { plugin, app } = createPlugin();
      plugin.settings.language = 'en';
      plugin.scratch = 'Keep this unfinished body across recovery.';
      plugin.saveComposer({ capture: 'Keep this unfinished capture.', scratchTitle: 'Keep this working title' });
      await plugin.startFocus(25);
      const persistedRunning = structuredClone(plugin.savedData);
      const running = readFocus(plugin)!;
      assert.ok(running.endsAt);
      advance(3);
      plugin.saveFailures = 1;
      await assert.rejects(plugin.finishFocus(), /Simulated settings write failure/);
      const stopped = readFocus(plugin)!;
      assert.equal(stopped.id, running.id);
      assert.equal(stopped.endsAt, null);
      assert.equal(stopped.remainingMs, 22 * 60_000);
      const record = focusFiles(app)[0]!;
      const recordedContent = record.content;
      await assert.rejects(plugin.resumeFocus(), /already been recorded/);
      assert.deepEqual(plugin.focus, stopped);
      advance(10);
      const reloaded = new harness.TangrowPlugin(app);
      reloaded.savedData = persistedRunning;
      await reloaded.onload();
      assert.deepEqual(reloaded.focus, stopped);
      assert.equal(reloaded.loadScratch(), 'Keep this unfinished body across recovery.');
      assert.deepEqual(reloaded.loadComposer(), { capture: 'Keep this unfinished capture.', scratchTitle: 'Keep this working title' });
      const recoveredData = reloaded.savedData as { focus: FocusSession; scratch: string; composer: ComposerState };
      assert.deepEqual(recoveredData.focus, stopped);
      assert.equal(recoveredData.scratch, reloaded.loadScratch());
      assert.deepEqual(recoveredData.composer, reloaded.loadComposer());
      await assert.rejects(reloaded.resumeFocus(), /already been recorded/);
      assert.deepEqual(reloaded.focus, stopped);
      await reloaded.finishFocus();
      assert.equal(reloaded.focus, null);
      assert.equal((reloaded.savedData as { focus: FocusSession | null }).focus, null);
      assert.equal(focusFiles(app).length, 1);
      assert.equal(record.content, recordedContent);
      assert.equal(harness.notices.at(-1), 'Focus saved: 3 minutes.');
    });
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function captureFiles(app: MockApp): MockFile[] {
  return app.vault.getMarkdownFiles().filter((file) => app.metadataCache.getFileCache(file).frontmatter?.tangrow_kind === 'capture');
}

test('shared composers notify each subscriber synchronously without refreshing vault snapshots', async () => {
  await withWindow(async () => {
    const { plugin, app } = createPlugin();
    plugin.snapshot();
    const scans = app.vault.getMarkdownFilesCalls;
    let fullUpdates = 0;
    const first: ComposerState[] = [];
    const second: ComposerState[] = [];
    const stopFull = plugin.subscribe(() => { fullUpdates++; });
    const stopFirst = plugin.subscribeComposer(() => first.push(plugin.loadComposer()));
    const stopSecond = plugin.subscribeComposer(() => second.push(plugin.loadComposer()));
    plugin.saveComposer({ capture: 'The shared capture.' });
    assert.deepEqual(first, [{ capture: 'The shared capture.', scratchTitle: '' }]);
    assert.deepEqual(second, first);
    plugin.saveComposer({ scratchTitle: 'The shared title' });
    assert.deepEqual(first.at(-1), { capture: 'The shared capture.', scratchTitle: 'The shared title' });
    assert.deepEqual(second, first);
    stopFirst();
    plugin.saveComposer({ capture: 'A newer shared capture.' });
    assert.equal(first.length, 2);
    assert.equal(second.length, 3);
    assert.equal(second.at(-1)?.capture, 'A newer shared capture.');
    assert.equal(fullUpdates, 0);
    assert.equal(app.vault.getMarkdownFilesCalls, scans);
    stopSecond();
    stopFull();
  });
});

test('concurrent submissions of the same shared capture create one record and clear every client view', async () => {
  await withWindow(async () => {
    const { plugin, app } = createPlugin();
    const firstClient: string[] = [];
    const secondClient: string[] = [];
    plugin.subscribeComposer(() => firstClient.push(plugin.loadComposer().capture));
    plugin.subscribeComposer(() => secondClient.push(plugin.loadComposer().capture));
    plugin.saveComposer({ capture: 'Save this thought exactly once.' });
    const first = plugin.submitCaptureDraft();
    const second = plugin.submitCaptureDraft();
    const third = plugin.submitCaptureDraft();
    assert.equal(second, first);
    assert.equal(third, first);
    await Promise.all([first, second, third]);
    const records = captureFiles(app);
    assert.equal(records.length, 1);
    assert.ok(records[0]!.content.includes('Save this thought exactly once.'));
    assert.equal(plugin.loadComposer().capture, '');
    assert.equal(firstClient.at(-1), '');
    assert.deepEqual(secondClient, firstClient);
  });
});

test('text entered while a shared capture is being saved remains available for the next submission', async () => {
  await withWindow(async () => {
    const { plugin, app } = createPlugin();
    plugin.saveComposer({ capture: 'The thought already being saved.' });
    const entered = deferred();
    const release = deferred();
    const originalCreate = app.vault.create.bind(app.vault);
    app.vault.create = async (path, content) => {
      entered.resolve();
      await release.promise;
      return originalCreate(path, content);
    };
    const saving = plugin.submitCaptureDraft();
    await entered.promise;
    plugin.saveComposer({ capture: 'The newer thought typed during the save.' });
    release.resolve();
    await saving;
    assert.equal(plugin.loadComposer().capture, 'The newer thought typed during the save.');
    assert.equal(captureFiles(app).length, 1);
    assert.ok(captureFiles(app)[0]!.content.includes('The thought already being saved.'));
    await plugin.submitCaptureDraft();
    assert.equal(captureFiles(app).length, 2);
    assert.equal(plugin.loadComposer().capture, '');
    assert.ok(captureFiles(app).some((file) => file.content.includes('The newer thought typed during the save.')));
  });
});

test('failed shared capture submissions retain the draft and release the submission guard for retry', async () => {
  await withWindow(async () => {
    const { plugin, app } = createPlugin();
    plugin.saveComposer({ capture: 'Keep this thought when writing fails.' });
    app.vault.failCreates = 1;
    await assert.rejects(plugin.submitCaptureDraft(), /Simulated vault write failure/);
    assert.equal(plugin.loadComposer().capture, 'Keep this thought when writing fails.');
    assert.equal(captureFiles(app).length, 0);
    await plugin.submitCaptureDraft();
    assert.equal(captureFiles(app).length, 1);
    assert.equal(plugin.loadComposer().capture, '');
  });
});

test('capture history exposes every record with its creation timestamp and lazy content reads', async () => {
  const { plugin, app } = createPlugin();
  const expected = new Map<string, number>();
  for (let index = 0; index < 20; index++) {
    const timestamp = Date.UTC(2026, 10, 1) + index * 60_000;
    const file = app.vault.seedFile(`00-Inbox/Capture ${index}.md`, `---\ntangrow_kind: "capture"\ncreated: "${new Date(timestamp).toISOString()}"\n---\n\n# Capture ${index}\n\nSaved thought ${index}.\n`);
    file.stat.mtime = Date.UTC(2026, 10, 2) - index * 60_000;
    expected.set(file.path, timestamp);
  }
  const history = plugin.snapshot().captures;
  assert.equal(history.length, 20);
  assert.equal(plugin.snapshot().counts.captures, 20);
  for (const capture of history) assert.equal(capture.created, expected.get(capture.path));
  const content = await plugin.readCapture('00-Inbox/Capture 0.md');
  assert.ok(content.includes('Saved thought 0.'));
  assert.equal(app.vault.createdPaths.length, 0);
});

test('recently opened notes seed from native history and file opens are distinct from modifications', async () => {
  await withWindow(async (timers) => {
    const { plugin, app } = createPlugin();
    const first = app.vault.seedFile('00-Inbox/First note.md', '# First note\n');
    const second = app.vault.seedFile('00-Inbox/Second note.md', '# Second note\n');
    const modifiedOnly = app.vault.seedFile('00-Inbox/Modified only.md', '# Modified only\n');
    app.workspace.lastOpenFiles.push(second.path, first.path, second.path, '00-Inbox/Missing note.md');
    plugin.savedData = { version: 2, settings: { ...plugin.settings, language: 'en' }, focus: null, scratch: '', composer: { capture: '', scratchTitle: '' } };
    await plugin.onload();
    app.workspace.emitLayoutReady();
    assert.deepEqual(plugin.snapshot().recentOpened.map((note) => note.path), [second.path, first.path]);
    modifiedOnly.stat.mtime += 1000;
    app.vault.trigger('modify', modifiedOnly);
    app.metadataCache.trigger('changed', modifiedOnly);
    timers.flush();
    await plugin.writes;
    assert.deepEqual(plugin.snapshot().recentOpened.map((note) => note.path), [second.path, first.path]);
    app.workspace.setActiveFile(first);
    app.workspace.trigger('file-open', first);
    timers.flush();
    await plugin.writes;
    assert.deepEqual(plugin.snapshot().recentOpened.map((note) => note.path), [first.path, second.path]);
    app.workspace.trigger('file-open', first);
    app.workspace.trigger('file-open', null);
    timers.flush();
    await plugin.writes;
    assert.deepEqual(plugin.snapshot().recentOpened.map((note) => note.path), [first.path, second.path]);
  });
});

test('recently opened notes track renames and deletions and remain bounded after persistence reload', async () => {
  await withWindow(async (timers) => {
    const { plugin, app } = createPlugin();
    plugin.savedData = { version: 3, settings: { ...plugin.settings, language: 'en' }, focus: null, scratch: 'Keep scratch.', composer: { capture: 'Keep capture.', scratchTitle: 'Keep title.' }, recentOpened: [] };
    await plugin.onload();
    const notes = Array.from({ length: 55 }, (_, index) => app.vault.seedFile(`00-Inbox/History/Note ${index}.md`, `# Note ${index}\n`));
    for (const note of notes) app.workspace.trigger('file-open', note);
    timers.flush();
    await plugin.writes;
    assert.equal(plugin.snapshot().recentOpened.length, 50);
    assert.deepEqual(plugin.snapshot().recentOpened.map((note) => note.path), notes.slice(5).reverse().map((note) => note.path));
    const newest = notes.at(-1)!;
    await app.vault.rename(newest, '00-Inbox/History/Renamed note.md');
    timers.flush();
    await plugin.writes;
    assert.equal(plugin.snapshot().recentOpened[0]?.path, newest.path);
    const historyFolder = app.vault.getAbstractFileByPath('00-Inbox/History') as MockFolder;
    await app.vault.rename(historyFolder, '00-Inbox/Renamed history');
    timers.flush();
    await plugin.writes;
    assert.ok(plugin.snapshot().recentOpened.every((note) => note.path.startsWith('00-Inbox/Renamed history/')));
    await app.vault.delete(newest);
    timers.flush();
    await plugin.writes;
    assert.equal(plugin.snapshot().recentOpened.length, 49);
    const expected = plugin.snapshot().recentOpened.map((note) => note.path);
    const persisted = structuredClone(plugin.savedData) as { version: number; recentOpened: string[] };
    assert.equal(persisted.version, 3);
    assert.deepEqual(persisted.recentOpened, expected);
    const reloadedApp = harness.createMockApp();
    for (const file of app.vault.getFiles()) reloadedApp.vault.seedFile(file.path, file.content);
    const reloaded = new harness.TangrowPlugin(reloadedApp);
    reloaded.savedData = persisted;
    await reloaded.onload();
    reloadedApp.workspace.emitLayoutReady();
    assert.deepEqual(reloaded.snapshot().recentOpened.map((note) => note.path), expected);
    assert.equal(reloaded.loadScratch(), 'Keep scratch.');
    assert.deepEqual(reloaded.loadComposer(), { capture: 'Keep capture.', scratchTitle: 'Keep title.' });
    const renamedFolder = app.vault.getAbstractFileByPath('00-Inbox/Renamed history') as MockFolder;
    await app.vault.delete(renamedFolder);
    timers.flush();
    await plugin.writes;
    assert.deepEqual(plugin.snapshot().recentOpened, []);
  });
});

interface CaptureContainer { win: { focus: () => void } }
interface CaptureLeaf {
  viewType: string;
  container: CaptureContainer;
  stateChanges: number;
  setViewState(state: { type: string }): Promise<void>;
  getContainer(): CaptureContainer;
  detach(): void;
}

function createCaptureWorkspace() {
  let focusCalls = 0;
  let detached = 0;
  let failNextViewState = false;
  const leaves: CaptureLeaf[] = [];
  const rootSplit: CaptureContainer = { win: { focus: () => { focusCalls++; } } };
  const popout: CaptureContainer = { win: { focus: () => { focusCalls++; } } };
  const calls = { popout: [] as unknown[], tabs: [] as unknown[], moved: [] as unknown[], revealed: [] as CaptureLeaf[] };
  const createLeaf = (container: CaptureContainer): CaptureLeaf => {
    const leaf: CaptureLeaf = {
      viewType: '', container, stateChanges: 0,
      async setViewState(state): Promise<void> {
        this.stateChanges++;
        if (failNextViewState) { failNextViewState = false; throw new Error('Simulated view activation failure'); }
        this.viewType = state.type;
      },
      getContainer(): CaptureContainer { return this.container; },
      detach(): void { detached++; const index = leaves.indexOf(this); if (index >= 0) leaves.splice(index, 1); }
    };
    leaves.push(leaf);
    return leaf;
  };
  const workspace = {
    rootSplit,
    getLeavesOfType: (type: string): CaptureLeaf[] => leaves.filter((leaf) => leaf.viewType === type),
    openPopoutLeaf: (options: unknown): CaptureLeaf => { calls.popout.push(options); return createLeaf(popout); },
    getLeaf: (mode: unknown): CaptureLeaf => { calls.tabs.push(mode); return createLeaf(rootSplit); },
    moveLeafToPopout: (leaf: CaptureLeaf, options: unknown): void => { calls.moved.push(options); leaf.container = popout; },
    revealLeaf: async (leaf: CaptureLeaf): Promise<void> => { calls.revealed.push(leaf); }
  };
  return { workspace, leaves, calls, createLeaf, failActivation: () => { failNextViewState = true; }, focusCalls: () => focusCalls, detached: () => detached };
}

test('concurrent desktop capture-window opens share one activation and later opens reuse its leaf', async () => {
  const { plugin } = createPlugin();
  const state = createCaptureWorkspace();
  const app = { workspace: state.workspace };
  const previous = harness.Platform.isDesktopApp;
  harness.Platform.isDesktopApp = true;
  try {
    const first = harness.openCaptureWindow(app, plugin);
    const second = harness.openCaptureWindow(app, plugin);
    assert.equal(first, second);
    await Promise.all([first, second]);
    assert.equal(state.calls.popout.length, 1);
    assert.equal(state.calls.tabs.length, 0);
    assert.equal(state.leaves.length, 1);
    assert.equal(state.leaves[0]?.stateChanges, 1);
    assert.equal(state.leaves[0]?.viewType, 'tangrow-capture');
    assert.equal(state.focusCalls(), 1);
    const options = state.calls.popout[0] as { size: { width: number; height: number } };
    assert.ok(options.size.width > 0 && options.size.height > 0);
    await harness.openCaptureWindow(app, plugin);
    assert.equal(state.calls.popout.length, 1);
    assert.equal(state.leaves[0]?.stateChanges, 1);
    assert.equal(state.focusCalls(), 2);
  } finally { harness.Platform.isDesktopApp = previous; }
});

test('capture-window opening uses a root tab on mobile and promotes an existing desktop root leaf', async () => {
  const { plugin } = createPlugin();
  const previous = harness.Platform.isDesktopApp;
  try {
    harness.Platform.isDesktopApp = false;
    const mobile = createCaptureWorkspace();
    await harness.openCaptureWindow({ workspace: mobile.workspace }, plugin);
    assert.deepEqual(mobile.calls.tabs, ['tab']);
    assert.deepEqual(mobile.calls.popout, []);
    assert.equal(mobile.leaves[0]?.container, mobile.workspace.rootSplit);
    harness.Platform.isDesktopApp = true;
    const desktop = createCaptureWorkspace();
    const existing = desktop.createLeaf(desktop.workspace.rootSplit);
    existing.viewType = 'tangrow-capture';
    await harness.openCaptureWindow({ workspace: desktop.workspace }, plugin);
    assert.equal(desktop.calls.moved.length, 1);
    assert.deepEqual(desktop.calls.popout, []);
    assert.equal(desktop.leaves[0], existing);
    assert.notEqual(existing.container, desktop.workspace.rootSplit);
    assert.equal(desktop.focusCalls(), 1);
  } finally { harness.Platform.isDesktopApp = previous; }
});

test('failed capture-window activation detaches the new leaf and allows a clean retry', async () => {
  const { plugin } = createPlugin();
  const state = createCaptureWorkspace();
  const app = { workspace: state.workspace };
  state.failActivation();
  await assert.rejects(harness.openCaptureWindow(app, plugin), /Simulated view activation failure/);
  assert.equal(state.detached(), 1);
  assert.equal(state.leaves.length, 0);
  await harness.openCaptureWindow(app, plugin);
  assert.equal(state.leaves.length, 1);
  assert.equal(state.leaves[0]?.viewType, 'tangrow-capture');
  assert.equal(state.focusCalls(), 1);
});

test('capture state-save failures retry only the cleared draft state without duplicating the saved note', async () => {
  await withWindow(async (timers) => {
    const { plugin, app } = createPlugin();
    plugin.settings.language = 'en';
    plugin.saveComposer({ capture: 'A thought already saved as a note.' });
    timers.flush();
    await plugin.writes;
    assert.equal((plugin.savedData as { composer: ComposerState }).composer.capture, 'A thought already saved as a note.');
    plugin.saveFailures = 1;
    const first = plugin.submitCaptureDraft();
    const concurrent = plugin.submitCaptureDraft();
    assert.equal(concurrent, first);
    await Promise.all([first, concurrent]);
    const records = captureFiles(app);
    assert.equal(records.length, 1);
    const savedContent = records[0]!.content;
    assert.equal(plugin.loadComposer().capture, '');
    assert.equal((plugin.savedData as { composer: ComposerState }).composer.capture, 'A thought already saved as a note.');
    assert.equal(harness.notices.at(-1), 'Capture saved, but draft state could not be saved. It will be retried.');
    timers.flush();
    await plugin.writes;
    assert.equal((plugin.savedData as { composer: ComposerState }).composer.capture, '');
    assert.equal(captureFiles(app).length, 1);
    assert.equal(records[0]!.content, savedContent);
    const reloaded = new harness.TangrowPlugin(app);
    reloaded.savedData = structuredClone(plugin.savedData);
    await reloaded.onload();
    assert.equal(reloaded.loadComposer().capture, '');
    assert.equal(captureFiles(app).length, 1);
    assert.equal(records[0]!.content, savedContent);
  });
});

test('opening capture sources and Bases preserves the capture popout and its shared draft', async () => {
  await withWindow(async () => {
    const { plugin, app } = createPlugin();
    const note = app.vault.seedFile('00-Inbox/Capture source.md', '# Capture source\n\nSaved content.\n');
    const replacedCaptureFiles: string[] = [];
    let captureMounted = true;
    app.workspace.setNavigationLeaf({
      view: { getViewType: () => 'tangrow-capture' },
      openFile: async (file) => { captureMounted = false; replacedCaptureFiles.push(file.path); }
    });
    plugin.saveComposer({ capture: 'Keep this unfinished thought in the popout.' });
    await plugin.openNote(note.path, 2);
    assert.deepEqual(app.workspace.navigationRequests, [false, 'tab']);
    assert.deepEqual(app.workspace.rootOpenedFiles, [note.path]);
    assert.equal(captureMounted, true);
    assert.deepEqual(replacedCaptureFiles, []);
    assert.equal(plugin.loadComposer().capture, 'Keep this unfinished thought in the popout.');
    await plugin.openBase('captures');
    assert.equal(app.workspace.navigationRequests.at(-1), 'tab');
    assert.equal(app.workspace.rootOpenedFiles.at(-1), `${plugin.settings.supportFolder}/Tangrow Captures.base`);
    assert.equal(captureMounted, true);
    assert.deepEqual(replacedCaptureFiles, []);
    assert.equal(plugin.loadComposer().capture, 'Keep this unfinished thought in the popout.');

    const navigatedFiles: string[] = [];
    app.workspace.setNavigationLeaf({
      view: { getViewType: () => 'markdown' },
      openFile: async (file) => { navigatedFiles.push(file.path); }
    });
    const requests = app.workspace.navigationRequests.length;
    await plugin.openNote(note.path);
    assert.deepEqual(app.workspace.navigationRequests.slice(requests), [false]);
    assert.deepEqual(navigatedFiles, [note.path]);
  });
});

test('non-file root views never expose or mutate a background Markdown note', async () => {
  for (const type of ['tangrow-report', 'tangrow-capture', 'graph']) {
    const { plugin, app } = createPlugin();
    const note = app.vault.seedFile('00-Inbox/Background note.md', '# Background note\n\nKeep this content.\n');
    const markdown = new harness.MarkdownView();
    markdown.file = note;
    app.workspace.rootLeaves.push({ view: markdown });
    app.workspace.setActiveView(markdown);
    app.workspace.setActiveView(null);
    const current = new harness.ItemView();
    current.getViewType = () => type;
    app.workspace.setMostRecentLeaf({ view: current });
    assert.equal(app.workspace.getActiveFile(), note);
    assert.equal(plugin.snapshot().active, null, type);
    assert.equal(plugin.snapshot().activePinned, false, type);
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const copied: string[] = [];
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string): Promise<void> => { copied.push(text); } } } });
    try {
      for (const action of ['fold', 'unfold', 'cover', 'title-date', 'timestamp', 'toggle-pin', 'page-width'] as const) {
        await assert.rejects(plugin.action(action), /^Error: Open a Markdown note first\.$/, `${type}: ${action}`);
      }
      for (const action of ['copy-link', 'copy-path', 'file-location'] as const) {
        await assert.rejects(plugin.action(action), /^Error: Open a file first\.$/, `${type}: ${action}`);
      }
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
    await plugin.startFocus(25);
    assert.equal(plugin.focus?.filePath, null, type);
    assert.equal(note.content, '# Background note\n\nKeep this content.\n');
    assert.deepEqual(markdown.inserted, []);
    assert.deepEqual(markdown.commands, []);
    assert.deepEqual(copied, []);
    assert.deepEqual(app.vault.processedPaths, []);
    assert.deepEqual(app.workspace.locatedFiles, []);
  }
});

test('focusing the sidebar keeps the most recent real Markdown view as the file context', async () => {
  const { plugin, app } = createPlugin();
  const note = app.vault.seedFile('00-Inbox/Current note.md', '# Current note\n');
  const markdown = new harness.MarkdownView();
  markdown.file = note;
  app.workspace.rootLeaves.push({ view: markdown });
  app.workspace.setActiveView(markdown);
  app.workspace.setActiveView(null);
  assert.equal(plugin.snapshot().active?.path, note.path);
  await plugin.action('timestamp');
  assert.equal(markdown.inserted.length, 1);
  await plugin.startFocus(25);
  assert.equal(plugin.focus?.filePath, note.path);
});

test('explicitly pinned Markdown files remain available across support and archive folders', () => {
  const { plugin, app } = createPlugin();
  const ordinary = app.vault.seedFile('00-Inbox/Ordinary pin.md', '---\ntangrow_pin: true\n---\n\n# Ordinary pin\n');
  const support = app.vault.seedFile(`${plugin.settings.supportFolder}/README.md`, '---\ntangrow_pin: true\n---\n\n# Support instructions\n');
  const archived = app.vault.seedFile('90-Archive/Archived pin.md', '---\ntangrow_pin: true\n---\n\n# Archived pin\n');
  const unpinned = app.vault.seedFile('00-Inbox/Unpinned note.md', '# Not pinned\n');
  ordinary.stat.mtime = 1;
  support.stat.mtime = 3;
  archived.stat.mtime = 2;
  unpinned.stat.mtime = 4;
  const before = currentContents(app);
  assert.deepEqual(plugin.snapshot().pins.map((note) => note.path), [support.path, archived.path, ordinary.path]);
  assert.deepEqual(currentContents(app), before);
  assert.deepEqual(app.vault.processedPaths, []);
});

test('folder setting validation and persistence failures preserve paths, files and existing Base filters', async () => {
  const { plugin, app } = createPlugin();
  await plugin.setup();
  app.vault.seedFile('00-Inbox/Existing note.md', '# Existing note\n\nKeep this location and body.\n');
  app.vault.seedFolder('20-Project/Alternative root');
  const originalContents = currentContents(app);
  const originalEntries = [...app.vault.entries.keys()].sort();
  const originalCreated = [...app.vault.createdPaths];
  const originalSettings = structuredClone(plugin.settings);
  plugin.savedData = { version: 3, settings: structuredClone(plugin.settings), focus: null, scratch: '', composer: { capture: '', scratchTitle: '' }, recentOpened: [] };
  const originalSaved = structuredClone(plugin.savedData);
  const saves = plugin.saveCalls;
  for (const path of ['../outside', '/absolute/folder', '.obsidian/plugins', 'folder/../outside']) {
    await assert.rejects(plugin.updateFolderSetting('supportFolder', path));
  }
  assert.deepEqual(plugin.settings, originalSettings);
  assert.equal(plugin.saveCalls, saves);
  plugin.saveFailures = 1;
  await assert.rejects(plugin.updateFolderSetting('projectFolder', '20-Project/Alternative root'), /Simulated settings write failure/);
  assert.deepEqual(plugin.settings, originalSettings);
  assert.deepEqual(plugin.savedData, originalSaved);
  await plugin.updateFolderSetting('projectFolder', '20-Project/Alternative root');
  assert.equal(plugin.settings.projectFolder, '20-Project/Alternative root');
  assert.equal((plugin.savedData as { settings: Settings }).settings.projectFolder, '20-Project/Alternative root');
  assert.deepEqual(currentContents(app), originalContents);
  assert.deepEqual([...app.vault.entries.keys()].sort(), originalEntries);
  assert.deepEqual(app.vault.createdPaths, originalCreated);
  assert.deepEqual(app.vault.processedPaths, []);
});

test('stacked-tab commands activate the most recent root leaf before dispatch', async () => {
  const { plugin, app } = createPlugin();
  const note = app.vault.seedFile('00-Inbox/Root note.md', '# Root note\n');
  const markdown = new harness.MarkdownView();
  markdown.file = note;
  const rootLeaf = { view: markdown };
  app.workspace.setMostRecentRootLeaf(rootLeaf);
  const capture = new harness.ItemView();
  capture.getViewType = () => 'tangrow-capture';
  app.workspace.setMostRecentLeaf({ view: capture });
  let commands = 0;
  Object.assign(app, {
    commands: {
      commands: { 'workspace:toggle-stacked-tabs': {} },
      executeCommandById: (id: string): boolean => {
        commands++;
        assert.equal(id, 'workspace:toggle-stacked-tabs');
        assert.equal(app.workspace.activationRequests.at(-1)?.leaf, rootLeaf);
        assert.deepEqual(app.workspace.activationRequests.at(-1)?.options, { focus: false });
        return true;
      }
    }
  });
  await plugin.action('stack-tabs');
  assert.equal(commands, 1);
  assert.ok(app.workspace.requestedRoots.includes(app.workspace.rootSplit));
  assert.equal(app.workspace.activationRequests.at(-1)?.leaf, rootLeaf);
});

test('sidebar focus totals match report validation, stable session deduplication and decimal precision', () => {
  const { plugin, app } = createPlugin();
  const fixtures = [
    { filename: 'Invalid numeric string', id: 'session-b', minutes: '20' },
    { filename: 'Invalid negative', id: 'session-b', minutes: -1 },
    { filename: 'Original session', id: 'session-a', minutes: 1.255 },
    { filename: 'Duplicate session', id: 'session-a', minutes: 50 },
    { filename: 'Another session', id: 'session-b', minutes: 0.994 },
    { filename: 'Anonymous session', id: '', minutes: 0.5 },
    { filename: 'Whitespace identifier', id: '   ', minutes: 0.5 }
  ];
  for (const fixture of fixtures) {
    app.vault.seedFile(`${plugin.settings.supportFolder}/Records/Focus/${fixture.filename}.md`, `---\ntangrow_kind: "focus"\ntangrow_session_id: ${JSON.stringify(fixture.id)}\ntangrow_minutes: ${JSON.stringify(fixture.minutes)}\n---\n\n# Focus record\n`);
  }
  const before = currentContents(app);
  const report = aggregateReport(app.vault.getMarkdownFiles().map((file) => ({
    path: file.path,
    name: file.basename,
    created: file.stat.ctime,
    modified: file.stat.mtime,
    frontmatter: app.metadataCache.getFileCache(file).frontmatter
  })), plugin.settings);
  assert.equal(report.counts.focusMinutes, 3.25);
  assert.equal(plugin.snapshot().counts.focusMinutes, report.counts.focusMinutes);
  assert.equal(plugin.snapshot().counts.focusMinutes, 3.25);
  assert.deepEqual(currentContents(app), before);
  assert.deepEqual(app.vault.processedPaths, []);
});
