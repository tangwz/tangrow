import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ComposerState, Locale, Settings, WritingDraft } from '../src/types';
import type { MockApp, Plugin as MockPlugin, createMockApp as MockAppFactory } from './obsidian-mock';

interface TestPlugin extends MockPlugin {
  settings: Settings;
  writes: Promise<unknown>;
  onload(): Promise<void>;
  onunload(): void;
  loadWritingDraft(): WritingDraft;
  updateWritingDraft(patch: Partial<Pick<WritingDraft, 'text' | 'title'>>, revision: number): boolean;
  submitWritingDraft(revision: number): Promise<void>;
  setLanguage(language: Locale): Promise<void>;
  loadComposer(): ComposerState;
  saveComposer(patch: Partial<ComposerState>): void;
  submitCaptureDraft(): Promise<void>;
  persist(): Promise<void>;
  updateFolderSetting(key: 'projectFolder', folder: string): Promise<void>;
  updateReportSettings(patch: { activityGoalMinutes: number }): Promise<void>;
}
interface Harness {
  TangrowPlugin: new (app: MockApp) => TestPlugin;
  createMockApp: typeof MockAppFactory;
}
interface PersistedDraft {
  scratch: string;
  composer: ComposerState;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  absWorkingDir: repository,
  stdin: {
    contents: "export { default as TangrowPlugin } from './src/main'; export * from './tests/obsidian-mock';",
    resolveDir: repository,
    sourcefile: 'writing-lifecycle-entry.ts',
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
function evaluateHarness(): Harness {
  const moduleObject: { exports: unknown } = { exports: {} };
  new Function('module', 'exports', 'require', bundled.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
  return moduleObject.exports as Harness;
}
const harness = evaluateHarness();

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function withWindow(run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let nextTimer = 0;
  const timers = new Map<number, () => void>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: (callback: () => void): number => { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout: (id: number): void => { timers.delete(id); },
      setInterval: (): number => ++nextTimer,
      clearInterval: (): void => undefined
    }
  });
  try { await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('an unloaded instance cannot clear a newer instance draft when its delayed submission finishes', async () => {
  await withWindow(async () => {
    const app = harness.createMockApp();
    const originalNote = app.vault.seedFile('20-Project/Existing note.md', '# Existing note\n\nKeep this content.\n');
    const originalContent = originalNote.content;
    let sharedData: unknown = null;
    const createPlugin = (): TestPlugin => {
      const plugin = new harness.TangrowPlugin(app);
      plugin.loadData = async () => structuredClone(sharedData);
      plugin.saveData = async (data: unknown) => { sharedData = structuredClone(data); };
      return plugin;
    };
    const first = createPlugin();
    await first.onload();
    assert.equal(first.updateWritingDraft({ text: 'The body already being submitted.', title: 'The earlier title' }, first.loadWritingDraft().revision), true);
    const started = deferred();
    const release = deferred();
    const originalCreate = app.vault.create.bind(app.vault);
    app.vault.create = async (filePath, content) => {
      started.resolve();
      await release.promise;
      return originalCreate(filePath, content);
    };
    const saving = first.submitWritingDraft(first.loadWritingDraft().revision);
    await started.promise;
    first.onunload();
    await first.writes;
    const second = createPlugin();
    await second.onload();
    const newText = 'The new body entered after re-enabling the plugin.';
    const newTitle = 'The new title after re-enabling';
    assert.equal(second.updateWritingDraft({ text: newText, title: newTitle }, second.loadWritingDraft().revision), true);
    await second.setLanguage(second.settings.language === 'en' ? 'zh-CN' : 'en');
    assert.equal((sharedData as PersistedDraft).scratch, newText);
    assert.equal((sharedData as PersistedDraft).composer.scratchTitle, newTitle);
    release.resolve();
    await saving;
    assert.equal(second.loadWritingDraft().text, newText);
    assert.equal(second.loadWritingDraft().title, newTitle);
    assert.equal((sharedData as PersistedDraft).scratch, newText);
    assert.equal((sharedData as PersistedDraft).composer.scratchTitle, newTitle);
    assert.equal(originalNote.content, originalContent);
    assert.equal(app.vault.getAbstractFileByPath(originalNote.path), originalNote);
    const savedNotes = app.vault.getMarkdownFiles().filter((file) => app.metadataCache.getFileCache(file).frontmatter?.tangrow_kind === 'draft');
    assert.equal(savedNotes.length, 1);
    assert.ok(savedNotes[0]!.content.includes('The body already being submitted.'));
  });
});

test('an old capture finishing after reload cannot clear or persist over the newer capture draft', async () => {
  await withWindow(async () => {
    const app = harness.createMockApp();
    let sharedData: unknown = null;
    const createPlugin = (): TestPlugin => {
      const plugin = new harness.TangrowPlugin(app);
      plugin.loadData = async () => structuredClone(sharedData);
      plugin.saveData = async (data) => { sharedData = structuredClone(data); };
      return plugin;
    };
    const old = createPlugin();
    await old.onload();
    old.saveComposer({ capture: 'The older capture being saved.' });
    const started = deferred();
    const release = deferred();
    const originalCreate = app.vault.create.bind(app.vault);
    app.vault.create = async (filePath, content) => {
      started.resolve();
      await release.promise;
      return originalCreate(filePath, content);
    };
    const saving = old.submitCaptureDraft();
    await started.promise;
    old.onunload();
    await old.writes;
    const latest = createPlugin();
    await latest.onload();
    latest.saveComposer({ capture: 'The newer capture entered after reload.', scratchTitle: 'The new working title' });
    await latest.persist();
    const savedLatest = structuredClone(sharedData);
    release.resolve();
    await saving;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(sharedData, savedLatest);
    assert.deepEqual(latest.loadComposer(), { capture: 'The newer capture entered after reload.', scratchTitle: 'The new working title' });
    const captures = app.vault.getMarkdownFiles().filter((file) => app.metadataCache.getFileCache(file).frontmatter?.tangrow_kind === 'capture');
    assert.equal(captures.length, 1);
    assert.ok(captures[0]!.content.includes('The older capture being saved.'));
    assert.deepEqual(app.workspace.navigationRequests, []);
  });
});

test('separate module reloads wait for in-flight writes and the queued final draft flush before reading', { timeout: 5000 }, async () => {
  await withWindow(async () => {
    for (const failOldWrite of [false, true]) {
      const firstModule = evaluateHarness();
      const secondModule = evaluateHarness();
      assert.notEqual(firstModule.TangrowPlugin, secondModule.TangrowPlugin);
      const app = firstModule.createMockApp();
      const first = new firstModule.TangrowPlugin(app);
      let sharedData: unknown = {
        version: 5, settings: { ...first.settings, language: 'en' }, focus: null,
        scratch: 'The persisted starting body.', composer: { capture: 'Keep the capture.', scratchTitle: 'The persisted starting title' }, recentOpened: []
      };
      const started = deferred();
      const release = deferred();
      const events: string[] = [];
      const oldWrites: PersistedDraft[] = [];
      const unhandled: unknown[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      let secondReads = 0;
      let handledErrors = 0;
      const onUnhandled = (error: unknown): void => { unhandled.push(error); };
      process.on('unhandledRejection', onUnhandled);
      try {
        first.loadData = async () => structuredClone(sharedData);
        first.saveData = async (data) => {
          const index = oldWrites.push(structuredClone(data) as PersistedDraft);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          events.push(`old-save-${index}-start`);
          try {
            if (index === 1) {
              started.resolve();
              await release.promise;
              if (failOldWrite) throw new Error('Simulated delayed old write failure');
            }
            sharedData = structuredClone(data);
          } finally {
            events.push(`old-save-${index}-end`);
            inFlight--;
          }
        };
        await first.onload();
        assert.equal(first.updateWritingDraft({ text: 'The earlier queued body.', title: 'The earlier queued title' }, first.loadWritingDraft().revision), true);
        const delayedWrite = first.persist().catch((error: unknown) => {
          handledErrors++;
          assert.match(String(error), /Simulated delayed old write failure/);
        });
        await started.promise;
        assert.equal(first.updateWritingDraft({ text: 'The latest body at unload.', title: 'The latest title at unload' }, first.loadWritingDraft().revision), true);
        first.onunload();
        const finalFlush = first.writes;
        const second = new secondModule.TangrowPlugin(app);
        second.loadData = async () => {
          secondReads++;
          events.push('new-load');
          assert.equal(inFlight, 0);
          return structuredClone(sharedData);
        };
        second.saveData = async (data) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          try { sharedData = structuredClone(data); }
          finally { inFlight--; }
        };
        const loading = second.onload();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(secondReads, 0);
        assert.equal(oldWrites.length, 1);
        assert.equal(inFlight, 1);
        release.resolve();
        await Promise.all([delayedWrite, finalFlush, loading]);
        assert.equal(secondReads, 1);
        assert.equal(maxInFlight, 1);
        assert.equal(handledErrors, failOldWrite ? 1 : 0);
        assert.equal(oldWrites.length, 2);
        assert.equal(oldWrites[0]!.scratch, 'The earlier queued body.');
        assert.equal(oldWrites[0]!.composer.scratchTitle, 'The earlier queued title');
        assert.equal(oldWrites[1]!.scratch, 'The latest body at unload.');
        assert.equal(oldWrites[1]!.composer.scratchTitle, 'The latest title at unload');
        assert.ok(events.indexOf('new-load') > events.indexOf('old-save-2-end'));
        assert.equal(second.loadWritingDraft().text, 'The latest body at unload.');
        assert.equal(second.loadWritingDraft().title, 'The latest title at unload');
        assert.equal(second.loadComposer().capture, 'Keep the capture.');
        assert.equal(second.updateWritingDraft({ text: 'The new module owns subsequent changes.' }, second.loadWritingDraft().revision), true);
        await second.persist();
        const newerData = structuredClone(sharedData);
        await first.persist();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(sharedData, newerData);
        assert.equal(oldWrites.length, 2);
        assert.deepEqual(unhandled, []);
      } finally {
        release.resolve();
        process.off('unhandledRejection', onUnhandled);
      }
    }
  });
});

test('queued draft writes use rolled-back settings when a preceding settings transaction fails', { timeout: 5000 }, async () => {
  await withWindow(async () => {
    for (const transaction of ['folder', 'report'] as const) {
      const app = harness.createMockApp();
      const originalNote = app.vault.seedFile('20-Project/Original note.md', '# Original note\n\nKeep this content and path.\n');
      const originalContent = originalNote.content;
      const originalPaths = [...app.vault.entries.keys()].sort();
      const plugin = new harness.TangrowPlugin(app);
      let sharedData: unknown = {
        version: 5, settings: { ...plugin.settings, language: 'en' }, focus: null,
        scratch: 'The starting draft body.', composer: { capture: 'Keep this capture.', scratchTitle: 'The starting title' }, recentOpened: []
      };
      plugin.loadData = async () => structuredClone(sharedData);
      plugin.saveData = async (data) => { sharedData = structuredClone(data); };
      await plugin.onload();
      const previousSettings = structuredClone(plugin.settings);
      const started = deferred();
      const release = deferred();
      const payloads: (PersistedDraft & { settings: Settings })[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      plugin.saveData = async (data) => {
        const index = payloads.push(structuredClone(data) as PersistedDraft & { settings: Settings });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (index === 1) {
            started.resolve();
            await release.promise;
            throw new Error('Simulated transaction save failure');
          }
          sharedData = structuredClone(data);
        } finally { inFlight--; }
      };
      const transactionPromise = transaction === 'folder'
        ? plugin.updateFolderSetting('projectFolder', '20-Project/Alternative project root')
        : plugin.updateReportSettings({ activityGoalMinutes: 61 });
      const rejectedTransaction = assert.rejects(transactionPromise, /Simulated transaction save failure/);
      try {
        await started.promise;
        if (transaction === 'folder') assert.equal(plugin.settings.projectFolder, '20-Project/Alternative project root');
        else assert.equal(plugin.settings.activityGoalMinutes, 61);
        const text = `The newer ${transaction} draft body entered during the pending write.`;
        const title = `The newer ${transaction} draft title`;
        assert.equal(plugin.updateWritingDraft({ text, title }, plugin.loadWritingDraft().revision), true);
        const queuedDraftWrite = plugin.persist();
        assert.equal(payloads.length, 1);
        release.resolve();
        await Promise.all([rejectedTransaction, queuedDraftWrite]);
        assert.equal(maxInFlight, 1);
        assert.equal(payloads.length, 2);
        if (transaction === 'folder') assert.equal(payloads[0]!.settings.projectFolder, '20-Project/Alternative project root');
        else assert.equal(payloads[0]!.settings.activityGoalMinutes, 61);
        assert.deepEqual(payloads[1]!.settings, previousSettings);
        assert.equal(payloads[1]!.scratch, text);
        assert.equal(payloads[1]!.composer.scratchTitle, title);
        assert.deepEqual(plugin.settings, previousSettings);
        const saved = sharedData as PersistedDraft & { settings: Settings };
        assert.deepEqual(saved.settings, previousSettings);
        assert.equal(saved.scratch, text);
        assert.equal(saved.composer.scratchTitle, title);
        assert.equal(saved.composer.capture, 'Keep this capture.');
        const reloaded = new harness.TangrowPlugin(app);
        reloaded.loadData = async () => structuredClone(sharedData);
        reloaded.saveData = async (data) => { sharedData = structuredClone(data); };
        await reloaded.onload();
        assert.deepEqual(reloaded.settings, previousSettings);
        assert.equal(reloaded.loadWritingDraft().text, text);
        assert.equal(reloaded.loadWritingDraft().title, title);
        assert.equal(originalNote.content, originalContent);
        assert.deepEqual([...app.vault.entries.keys()].sort(), originalPaths);
        assert.deepEqual(app.vault.createdPaths, []);
        assert.deepEqual(app.vault.processedPaths, []);
      } finally { release.resolve(); }
    }
  });
});

function storedDraft(plugin: TestPlugin, text: string, title: string): unknown {
  return {
    version: 5, settings: { ...plugin.settings, language: 'en' }, focus: null,
    scratch: text, composer: { capture: 'Keep the stored capture.', scratchTitle: title }, recentOpened: []
  };
}

function coordinatorFor(app: MockApp): { owner?: symbol; tail: Promise<void> } {
  return (app as unknown as Record<symbol, { owner?: symbol; tail: Promise<void> }>)[Symbol.for('tangrow.persistence-coordinator')]!;
}

test('cancelling initialization behind an older final flush cannot claim ownership or write default data', { timeout: 5000 }, async () => {
  await withWindow(async () => {
    const app = harness.createMockApp();
    const old = new harness.TangrowPlugin(app);
    let sharedData = storedDraft(old, 'The original stored body.', 'The original stored title');
    old.loadData = async () => structuredClone(sharedData);
    old.saveData = async (data) => { sharedData = structuredClone(data); };
    await old.onload();
    const entered = deferred();
    const release = deferred();
    let oldSaves = 0;
    old.saveData = async (data) => {
      oldSaves++;
      if (oldSaves === 1) { entered.resolve(); await release.promise; }
      sharedData = structuredClone(data);
    };
    old.updateWritingDraft({ text: 'The older in-flight body.', title: 'The older in-flight title' }, old.loadWritingDraft().revision);
    const oldWrite = old.persist();
    await entered.promise;
    old.updateWritingDraft({ text: 'The latest old body at unload.', title: 'The latest old title at unload' }, old.loadWritingDraft().revision);
    old.onunload();
    const finalFlush = old.writes;
    const coordinator = coordinatorFor(app);
    const owner = coordinator.owner;
    const tail = coordinator.tail;
    const cancelled = new harness.TangrowPlugin(app);
    let reads = 0;
    let saves = 0;
    let registrations = 0;
    cancelled.loadData = async () => { reads++; return structuredClone(sharedData); };
    cancelled.saveData = async (data) => { saves++; sharedData = structuredClone(data); };
    cancelled.registerView = () => { registrations++; };
    cancelled.addCommand = () => { registrations++; };
    const loading = cancelled.onload();
    cancelled.onunload();
    assert.equal(coordinator.owner, owner);
    assert.equal(coordinator.tail, tail);
    assert.equal(reads, 0);
    assert.equal(saves, 0);
    try {
      release.resolve();
      await Promise.all([oldWrite, finalFlush, loading]);
      assert.equal(reads, 0);
      assert.equal(saves, 0);
      assert.equal(registrations, 0);
      assert.equal(coordinator.owner, owner);
      assert.equal(oldSaves, 2);
      assert.equal((sharedData as PersistedDraft).scratch, 'The latest old body at unload.');
      assert.equal((sharedData as PersistedDraft).composer.scratchTitle, 'The latest old title at unload');
      const fresh = new harness.TangrowPlugin(app);
      fresh.loadData = async () => structuredClone(sharedData);
      fresh.saveData = async (data) => { sharedData = structuredClone(data); };
      await fresh.onload();
      assert.equal(fresh.loadWritingDraft().text, 'The latest old body at unload.');
      assert.equal(fresh.loadWritingDraft().title, 'The latest old title at unload');
      assert.equal(fresh.loadComposer().capture, 'Keep the stored capture.');
      assert.deepEqual(app.vault.createdPaths, []);
    } finally { release.resolve(); }
  });
});

test('cancelling initialization during loadData leaves stored JSON and registration state untouched', { timeout: 5000 }, async () => {
  await withWindow(async () => {
    const app = harness.createMockApp();
    const cancelled = new harness.TangrowPlugin(app);
    let sharedData = storedDraft(cancelled, 'The body awaiting initialization.', 'The title awaiting initialization');
    const original = JSON.stringify(sharedData);
    const entered = deferred();
    const release = deferred();
    let reads = 0;
    let saves = 0;
    let registrations = 0;
    cancelled.loadData = async () => { reads++; entered.resolve(); await release.promise; return structuredClone(sharedData); };
    cancelled.saveData = async (data) => { saves++; sharedData = structuredClone(data); };
    cancelled.registerView = () => { registrations++; };
    cancelled.addCommand = () => { registrations++; };
    const loading = cancelled.onload();
    await entered.promise;
    const coordinator = coordinatorFor(app);
    const tail = coordinator.tail;
    assert.equal(coordinator.owner, undefined);
    cancelled.onunload();
    assert.equal(coordinator.tail, tail);
    assert.equal(saves, 0);
    try {
      release.resolve();
      await loading;
      assert.equal(reads, 1);
      assert.equal(saves, 0);
      assert.equal(registrations, 0);
      assert.equal(coordinator.owner, undefined);
      assert.equal(JSON.stringify(sharedData), original);
      const fresh = new harness.TangrowPlugin(app);
      fresh.loadData = async () => structuredClone(sharedData);
      fresh.saveData = async (data) => { sharedData = structuredClone(data); };
      await fresh.onload();
      assert.equal(fresh.loadWritingDraft().text, 'The body awaiting initialization.');
      assert.equal(fresh.loadWritingDraft().title, 'The title awaiting initialization');
      assert.equal(JSON.stringify(sharedData), original);
    } finally { release.resolve(); }
  });
});

test('loadData rejection followed by unload never replaces stored JSON with constructor defaults', async () => {
  await withWindow(async () => {
    const app = harness.createMockApp();
    const failed = new harness.TangrowPlugin(app);
    let storedJSON = JSON.stringify(storedDraft(failed, 'The protected body after a read error.', 'The protected title after a read error'));
    const original = storedJSON;
    let saves = 0;
    let registrations = 0;
    failed.loadData = async () => { throw new Error('Simulated data read failure'); };
    failed.saveData = async (data) => { saves++; storedJSON = JSON.stringify(data); };
    failed.registerView = () => { registrations++; };
    failed.addCommand = () => { registrations++; };
    await assert.rejects(failed.onload(), /Simulated data read failure/);
    failed.onunload();
    await failed.writes;
    assert.equal(saves, 0);
    assert.equal(registrations, 0);
    assert.equal(storedJSON, original);
    assert.equal(coordinatorFor(app).owner, undefined);
    const fresh = new harness.TangrowPlugin(app);
    fresh.loadData = async () => JSON.parse(storedJSON) as unknown;
    fresh.saveData = async (data) => { storedJSON = JSON.stringify(data); };
    await fresh.onload();
    assert.equal(fresh.loadWritingDraft().text, 'The protected body after a read error.');
    assert.equal(fresh.loadWritingDraft().title, 'The protected title after a read error');
    assert.equal(storedJSON, original);
    assert.deepEqual(app.vault.createdPaths, []);
    assert.deepEqual(app.vault.processedPaths, []);
  });
});

test('final unload flushes read rolled-back settings before a new instance loads the latest draft', { timeout: 5000 }, async () => {
  await withWindow(async () => {
    for (const transaction of ['folder', 'report'] as const) {
      const app = harness.createMockApp();
      const old = new harness.TangrowPlugin(app);
      let sharedData = storedDraft(old, 'The stored body before the transaction.', 'The stored title before the transaction');
      old.loadData = async () => structuredClone(sharedData);
      old.saveData = async (data) => { sharedData = structuredClone(data); };
      await old.onload();
      const previousSettings = structuredClone(old.settings);
      const entered = deferred();
      const release = deferred();
      const payloads: (PersistedDraft & { settings: Settings })[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      old.saveData = async (data) => {
        const index = payloads.push(structuredClone(data) as PersistedDraft & { settings: Settings });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (index === 1) { entered.resolve(); await release.promise; throw new Error('Simulated transaction save failure during unload'); }
          sharedData = structuredClone(data);
        } finally { inFlight--; }
      };
      const update = transaction === 'folder'
        ? old.updateFolderSetting('projectFolder', '20-Project/Temporary root')
        : old.updateReportSettings({ activityGoalMinutes: 61 });
      const rejected = assert.rejects(update, /Simulated transaction save failure during unload/);
      try {
        await entered.promise;
        const text = `The latest ${transaction} body at unload.`;
        const title = `The latest ${transaction} title at unload`;
        assert.equal(old.updateWritingDraft({ text, title }, old.loadWritingDraft().revision), true);
        old.onunload();
        const finalFlush = old.writes;
        let newReads = 0;
        const fresh = new harness.TangrowPlugin(app);
        fresh.loadData = async () => { newReads++; assert.equal(inFlight, 0); return structuredClone(sharedData); };
        fresh.saveData = async (data) => { sharedData = structuredClone(data); };
        const loading = fresh.onload();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(newReads, 0);
        assert.equal(payloads.length, 1);
        release.resolve();
        await Promise.all([rejected, finalFlush, loading]);
        assert.equal(newReads, 1);
        assert.equal(maxInFlight, 1);
        assert.equal(payloads.length, 2);
        if (transaction === 'folder') assert.equal(payloads[0]!.settings.projectFolder, '20-Project/Temporary root');
        else assert.equal(payloads[0]!.settings.activityGoalMinutes, 61);
        assert.deepEqual(payloads[1]!.settings, previousSettings);
        assert.equal(payloads[1]!.scratch, text);
        assert.equal(payloads[1]!.composer.scratchTitle, title);
        assert.deepEqual(fresh.settings, previousSettings);
        assert.equal(fresh.loadWritingDraft().text, text);
        assert.equal(fresh.loadWritingDraft().title, title);
        assert.equal(fresh.loadComposer().capture, 'Keep the stored capture.');
        assert.deepEqual((sharedData as { settings: Settings }).settings, previousSettings);
        assert.deepEqual(app.vault.createdPaths, []);
        assert.deepEqual(app.vault.processedPaths, []);
      } finally { release.resolve(); }
    }
  });
});
