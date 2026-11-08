import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { baseDefinitions, setupReadme } from '../src/bases';
import type { ActionId, ComposerState, FocusSession, Locale, NoteKind, Settings, Snapshot } from '../src/types';
import type { MarkdownView as MockMarkdownView, MockApp, Plugin as MockPlugin, TFile as MockFile, TFolder as MockFolder, createMockApp as MockAppFactory } from './obsidian-mock';

interface TestPlugin extends MockPlugin {
  settings: Settings;
  focus: FocusSession | null;
  scratch: string;
  writes: Promise<unknown>;
  onload(): Promise<void>;
  setup(): Promise<void>;
  snapshot(): Snapshot;
  action(id: ActionId): Promise<void>;
  createNote(kind: NoteKind, title: string, projectFolder?: string): Promise<void>;
  setLanguage(language: Locale): Promise<void>;
  loadScratch(): string;
  saveScratch(value: string): void;
  loadComposer(): ComposerState;
  saveComposer(patch: Partial<ComposerState>): void;
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
  notices: string[];
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
  app.workspace.setMostRecentLeaf(null);
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
