import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ComposerState, Settings, WritingDraft } from '../src/types';
import type { DraftSubmissions } from '../src/draft-submissions';
import type { MockApp, Plugin as MockPlugin, createMockApp as MockAppFactory } from './obsidian-mock';

interface TestPlugin extends MockPlugin {
  settings: Settings;
  writes: Promise<void>;
  onload(): Promise<void>;
  onunload(): void;
  loadComposer(): ComposerState;
  saveComposer(patch: Partial<ComposerState>): void;
  loadWritingDraft(): WritingDraft;
  updateWritingDraft(patch: Partial<Pick<WritingDraft, 'text' | 'title'>>, revision: number): boolean;
  submitCaptureDraft(): Promise<void>;
  submitWritingDraft(revision: number): Promise<void>;
  persist(): Promise<void>;
}
interface SavedState { version: number; composer: ComposerState; scratch: string; submissions: DraftSubmissions }
type Kind = 'capture' | 'draft';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  absWorkingDir: repository,
  stdin: { contents: "export { default as TangrowPlugin } from './src/main'; export * from './tests/obsidian-mock';", resolveDir: repository, loader: 'ts' },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-submission-recovery', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as { TangrowPlugin: new (app: MockApp) => TestPlugin; createMockApp: typeof MockAppFactory };

async function withWindow(run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 1, clearTimeout: () => undefined, setInterval: () => 1 } });
  try { await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function createPlugin() {
  const app = harness.createMockApp();
  const plugin = new harness.TangrowPlugin(app);
  plugin.settings.language = 'en';
  return { app, plugin };
}
function edit(plugin: TestPlugin, kind: Kind, text: string): void {
  if (kind === 'capture') plugin.saveComposer({ capture: text });
  else plugin.updateWritingDraft({ text, title: 'Saved writing' }, plugin.loadWritingDraft().revision);
}
function text(plugin: TestPlugin, kind: Kind): string {
  return kind === 'capture' ? plugin.loadComposer().capture : plugin.loadWritingDraft().text;
}
function submit(plugin: TestPlugin, kind: Kind): Promise<void> {
  return kind === 'capture' ? plugin.submitCaptureDraft() : plugin.submitWritingDraft(plugin.loadWritingDraft().revision);
}
function records(app: MockApp, kind: Kind) {
  return app.vault.getMarkdownFiles().filter((file) => app.metadataCache.getFileCache(file).frontmatter?.tangrow_kind === kind);
}
function restart(plugin: TestPlugin, app: MockApp, moved = false) {
  // Use a fresh app and persisted bytes only, without unload flushing or in-memory guards.
  const next = createPlugin();
  next.plugin.savedData = structuredClone(plugin.savedData);
  for (const file of app.vault.getMarkdownFiles()) next.app.vault.seedFile(moved ? `Moved/${file.name}` : file.path, file.content);
  return next;
}

for (const kind of ['capture', 'draft'] as const) {
  test(`${kind}: a failed preparation cannot create Markdown or discard the draft`, async () => {
    await withWindow(async () => {
      const { app, plugin } = createPlugin();
      edit(plugin, kind, 'Keep the original text.');
      plugin.saveFailures = 1;
      await assert.rejects(submit(plugin, kind), /settings write failure/);
      assert.equal(records(app, kind).length, 0);
      assert.equal(text(plugin, kind), 'Keep the original text.');
      await submit(plugin, kind);
      assert.equal(records(app, kind).length, 1);
    });
  });

  for (const moved of [false, true]) {
    test(`${kind}: restart recovers a saved note with failed cleanup${moved ? ' after a rename' : ''}`, async () => {
      await withWindow(async () => {
        const { app, plugin } = createPlugin();
        edit(plugin, kind, 'Saved once before the crash.');
        const save = plugin.saveData.bind(plugin);
        plugin.saveData = async (data) => {
          if (records(app, kind).length) throw new Error('Crash before cleanup was persisted');
          await save(data);
        };
        await submit(plugin, kind);
        assert.equal(text(plugin, kind), '');
        const stale = plugin.savedData as SavedState;
        assert.equal(kind === 'capture' ? stale.composer.capture : stale.scratch, 'Saved once before the crash.');
        const originalContent = records(app, kind)[0]!.content;
        const next = restart(plugin, app, moved);
        // Startup must work even before Obsidian has populated its metadata index.
        next.app.metadataCache.getFileCache = () => ({ frontmatter: undefined, listItems: [] });
        await next.plugin.onload();
        assert.equal(text(next.plugin, kind), '');
        assert.equal(next.app.vault.getMarkdownFiles().length, 1);
        assert.equal(next.app.vault.getMarkdownFiles()[0]!.content, originalContent);
        await assert.rejects(submit(next.plugin, kind), /before saving/);
        assert.equal(next.app.vault.getMarkdownFiles().length, 1);
      });
    });
  }

  test(`${kind}: restart before file creation retries the same durable submission`, async () => {
    await withWindow(async () => {
      const { app, plugin } = createPlugin();
      edit(plugin, kind, 'Retain this prepared but unwritten draft.');
      app.vault.failCreates = 1;
      await assert.rejects(submit(plugin, kind), /vault write failure/);
      const receipt = (plugin.savedData as SavedState).submissions[kind === 'capture' ? 'capture' : 'writing'];
      assert.ok(receipt?.path);
      const next = restart(plugin, app);
      await next.plugin.onload();
      assert.equal(text(next.plugin, kind), 'Retain this prepared but unwritten draft.');
      await submit(next.plugin, kind);
      assert.equal(records(next.app, kind).length, 1);
      const file = records(next.app, kind)[0]!;
      assert.equal(file.path, receipt.path);
      assert.equal(next.app.metadataCache.getFileCache(file).frontmatter?.tangrow_submission_id, receipt.id);
    });
  });

  test(`${kind}: repeated crashes during recovery never submit the saved draft again`, async () => {
    await withWindow(async () => {
      const { app, plugin } = createPlugin();
      edit(plugin, kind, 'Keep the durable receipt until cleanup succeeds.');
      const save = plugin.saveData.bind(plugin);
      plugin.saveData = async (data) => {
        if (records(app, kind).length) throw new Error('Cleanup is unavailable');
        await save(data);
      };
      await submit(plugin, kind);
      const second = restart(plugin, app);
      second.plugin.saveFailures = 1;
      await second.plugin.onload();
      assert.equal(text(second.plugin, kind), '');
      const third = restart(second.plugin, second.app);
      await third.plugin.onload();
      assert.equal(text(third.plugin, kind), '');
      assert.equal(records(third.app, kind).length, 1);
      assert.equal((third.plugin.savedData as SavedState).submissions[kind === 'capture' ? 'capture' : 'writing'], null);
    });
  });

  test(`${kind}: a create error after writing is recognized as success`, async () => {
    await withWindow(async () => {
      const { app, plugin } = createPlugin();
      edit(plugin, kind, 'This note was written despite the error.');
      const create = app.vault.create.bind(app.vault);
      app.vault.create = async (filePath, content) => { await create(filePath, content); throw new Error('Failure after writing'); };
      await submit(plugin, kind);
      assert.equal(records(app, kind).length, 1);
      assert.equal(text(plugin, kind), '');
    });
  });

  test(`${kind}: newer edits survive restart even when reverted to the submitted text`, async () => {
    await withWindow(async () => {
      const { app, plugin } = createPlugin();
      edit(plugin, kind, 'Identical text is a distinct new draft.');
      let release!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const create = app.vault.create.bind(app.vault);
      app.vault.create = async (filePath, content) => { started(); await gate; return create(filePath, content); };
      const saving = submit(plugin, kind);
      await ready;
      edit(plugin, kind, 'An intermediate edit.');
      edit(plugin, kind, 'Identical text is a distinct new draft.');
      await plugin.persist();
      release();
      await saving;
      const next = restart(plugin, app);
      await next.plugin.onload();
      assert.equal(text(next.plugin, kind), 'Identical text is a distinct new draft.');
      await submit(next.plugin, kind);
      assert.equal(records(next.app, kind).length, 2);
      const ids = records(next.app, kind).map((file) => next.app.metadataCache.getFileCache(file).frontmatter?.tangrow_submission_id);
      assert.equal(new Set(ids).size, 2);
    });
  });

  test(`${kind}: occupied or unreadable recovery paths never cause overwrites or a second note`, async () => {
    await withWindow(async () => {
      const { app, plugin } = createPlugin();
      edit(plugin, kind, 'A pending save.');
      app.vault.failCreates = 1;
      await assert.rejects(submit(plugin, kind));
      const receipt = (plugin.savedData as SavedState).submissions[kind === 'capture' ? 'capture' : 'writing']!;
      const next = restart(plugin, app);
      const unrelated = next.app.vault.seedFile(receipt.path!, '# User content must remain unchanged.');
      await next.plugin.onload();
      await assert.rejects(submit(next.plugin, kind), /Occupied/);
      assert.equal(unrelated.content, '# User content must remain unchanged.');
      assert.equal(text(next.plugin, kind), 'A pending save.');
      next.app.vault.read = async () => { throw new Error('Unreadable note'); };
      await assert.rejects(submit(next.plugin, kind), /Unreadable/);
      assert.equal(next.app.vault.getMarkdownFiles().length, 1);
    });
  });
}

test('legacy data gains submission state without changing existing drafts or notes', async () => {
  await withWindow(async () => {
    const { app, plugin } = createPlugin();
    const note = app.vault.seedFile('00-Inbox/Legacy.md', '# Keep legacy content.\n');
    plugin.savedData = { version: 4, settings: plugin.settings, focus: null, scratch: 'Legacy writing.', composer: { capture: 'Legacy capture.', scratchTitle: 'Legacy title' }, recentOpened: [] };
    await plugin.onload();
    assert.equal(text(plugin, 'draft'), 'Legacy writing.');
    assert.equal(text(plugin, 'capture'), 'Legacy capture.');
    assert.equal(plugin.loadWritingDraft().title, 'Legacy title');
    assert.equal((plugin.savedData as SavedState).version, 5);
    assert.deepEqual((plugin.savedData as SavedState).submissions, { capture: null, writing: null });
    assert.equal(note.content, '# Keep legacy content.\n');
    assert.deepEqual(app.vault.createdPaths, []);
  });
});

test('malformed submission receipts cannot be dropped and persisted over during initialization', async () => {
  await withWindow(async () => {
    for (const submissions of [[], { capture: {} }, { writing: { id: crypto.randomUUID(), path: '../outside.md' } }]) {
      const { app, plugin } = createPlugin();
      const stored = { version: 5, settings: plugin.settings, scratch: 'Protected writing.', composer: { capture: 'Protected capture.', scratchTitle: 'Protected title' }, submissions };
      plugin.savedData = structuredClone(stored);
      await assert.rejects(plugin.onload());
      plugin.onunload();
      await plugin.writes;
      assert.deepEqual(plugin.savedData, stored);
      assert.deepEqual(app.vault.createdPaths, []);
    }
  });
});
