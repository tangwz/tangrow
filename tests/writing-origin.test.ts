import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { WritingDraft, WritingSaveOrigin } from '../src/types';
import type { MockApp, Plugin as MockPlugin, TFile as MockFile, FileView as MockFileView, ItemView as MockItemView, createMockApp as MockAppFactory } from './obsidian-mock';

interface WritingPlugin extends MockPlugin {
  loadWritingDraft(): WritingDraft;
  updateWritingDraft(patch: Partial<Pick<WritingDraft, 'text' | 'title'>>, revision: number): boolean;
  submitWritingDraft(revision: number, origin?: WritingSaveOrigin): Promise<void>;
  beginWritingDraftComposition(view: string, revision: number): boolean;
  endWritingDraftComposition(view: string): void;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  absWorkingDir: repository,
  stdin: { contents: "export { default as TangrowPlugin } from './src/main'; export * from './tests/obsidian-mock';", resolveDir: repository, loader: 'ts' },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-writing-origin', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as {
  TangrowPlugin: new (app: MockApp) => WritingPlugin;
  FileView: new () => MockFileView;
  ItemView: new () => MockItemView;
  createMockApp: typeof MockAppFactory;
  notices: string[];
};

class Events {
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, callback: () => void): void {
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback); this.listeners.set(type, callbacks);
  }
  removeEventListener(type: string, callback: () => void): void { this.listeners.get(type)?.delete(callback); }
  emit(type: string): void { for (const callback of this.listeners.get(type) ?? []) callback(); }
  count(): number { return [...this.listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); }
}
class DocumentFixture extends Events {
  hidden = false;
  focused = true;
  activeElement: unknown = { kind: 'save-button' };
  defaultView = Object.assign(new Events(), { closed: false });
  hasFocus(): boolean { return this.focused; }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}
async function withWindow(run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 1, clearTimeout: () => undefined } });
  try { await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function fixture() {
  const app = harness.createMockApp();
  const plugin = new harness.TangrowPlugin(app);
  const sourceDocument = new DocumentFixture();
  const otherDocument = new DocumentFixture();
  otherDocument.focused = false;
  const sourceContainer = { doc: sourceDocument };
  const otherContainer = { doc: otherDocument };
  const editor = { ownerDocument: sourceDocument, isConnected: true, readOnly: false };
  const sourceView = new harness.ItemView();
  const sourceElement = Object.assign(sourceView.containerEl, { ownerDocument: sourceDocument, isConnected: true, contains: (value: unknown) => value === editor });
  const original = app.vault.seedFile('20-Project/Original.md', '# Original note\n');
  const other = app.vault.seedFile('20-Project/Other.md', '# Other note\n');
  const targetView = new harness.FileView(); targetView.file = original;
  const targetElement = Object.assign(targetView.containerEl, { ownerDocument: sourceDocument, isConnected: true });
  const otherView = new harness.FileView(); otherView.file = other;
  Object.assign(otherView.containerEl, { ownerDocument: otherDocument, isConnected: true });
  const opens: string[] = [];
  const source = { view: sourceView, getContainer: () => sourceContainer };
  let pinned = false;
  let failOpen = false;
  const target = {
    view: targetView, getContainer: () => sourceContainer, getViewState: () => ({ pinned }),
    openFile: async (_file: MockFile) => { if (failOpen) throw new Error('Simulated navigation failure'); opens.push('source-window'); }
  };
  const otherTarget = { view: otherView, getContainer: () => otherContainer };
  const leaves: unknown[] = [source, target, otherTarget];
  let localTarget: unknown = target;
  let globalTarget: unknown = otherTarget;
  const roots: unknown[] = [];
  Object.assign(app.workspace, {
    getMostRecentLeaf: (container?: unknown) => { roots.push(container); return container === sourceContainer ? localTarget : globalTarget; },
    iterateAllLeaves: (visit: (leaf: unknown) => void) => leaves.forEach(visit)
  });
  const origin = { leaf: source, editor } as unknown as WritingSaveOrigin;
  plugin.updateWritingDraft({ text: '\u4e2d\u6587 snapshot.', title: 'Saved title' }, 0);
  return {
    app, plugin, sourceDocument, otherDocument, sourceContainer, otherContainer, editor, source, target, targetView,
    sourceElement, targetElement, original, other, leaves, opens, roots, origin,
    localTarget: (value: unknown) => { localTarget = value; }, globalTarget: (value: unknown) => { globalTarget = value; },
    pin: () => { pinned = true; }, failOpen: () => { failOpen = true; }
  };
}

type Fixture = ReturnType<typeof fixture>;
const cases: Array<{ name: string; setup?: (f: Fixture) => void; change?: (f: Fixture) => void; reveal?: boolean; keep?: boolean; noOrigin?: boolean }> = [
  { name: 'the source window is used even when the global recent leaf belongs to another window', reveal: true },
  { name: 'an unchanged same-window source reveals the saved note', setup: (f) => { f.globalTarget(f.target); }, reveal: true },
  { name: 'returning to the unrelated recent-leaf window cannot authorize navigation', change: (f) => { f.sourceDocument.focused = false; f.otherDocument.focused = true; } },
  { name: 'a transient window blur revokes navigation after focus returns', change: (f) => { f.sourceDocument.defaultView.emit('blur'); } },
  { name: 'a transient control change revokes navigation after the old control regains focus', change: (f) => { const active = f.sourceDocument.activeElement; f.sourceDocument.activeElement = {}; f.sourceDocument.emit('focusin'); f.sourceDocument.activeElement = active; } },
  { name: 'a new composition revokes navigation even when it ends before writing finishes', change: (f) => { f.sourceDocument.emit('compositionstart'); } },
  { name: 'a pending composition without a new revision retains the draft and cannot navigate', change: (f) => { f.plugin.beginWritingDraftComposition('new-composition', f.plugin.loadWritingDraft().revision); }, keep: true },
  { name: 'a source view removed from the workspace cannot navigate', change: (f) => { f.leaves.splice(f.leaves.indexOf(f.source), 1); } },
  { name: 'a detached source editor cannot navigate', change: (f) => { f.editor.isConnected = false; } },
  { name: 'a replaced source editor cannot navigate', change: (f) => { f.sourceElement.contains = () => false; } },
  { name: 'a source editor from another document cannot authorize navigation', setup: (f) => { f.editor.ownerDocument = f.otherDocument; } },
  { name: 'a moved source view cannot navigate into its old container', change: (f) => { f.source.getContainer = () => f.otherContainer; } },
  { name: 'changing the source window target leaf cancels navigation', change: (f) => { f.localTarget(null); } },
  { name: 'changing the note within the same target view cancels navigation', change: (f) => { f.targetView.file = f.other; } },
  { name: 'pinning the target during saving preserves its current note', change: (f) => { f.pin(); } },
  { name: 'a detached target cannot receive navigation', change: (f) => { f.targetElement.isConnected = false; } },
  { name: 'a hidden source window cannot navigate', change: (f) => { f.sourceDocument.hidden = true; } },
  { name: 'closing the source window cannot navigate', change: (f) => { f.sourceDocument.defaultView.closed = true; } },
  { name: 'newer draft input survives an older save', change: (f) => { f.plugin.updateWritingDraft({ text: 'Newer body.', title: 'Newer title' }, f.plugin.loadWritingDraft().revision); }, keep: true },
  { name: 'missing caller context saves in the background', noOrigin: true },
  { name: 'a missing source-window leaf saves in the background', setup: (f) => { f.localTarget(null); } },
  { name: 'a source window containing only the writing panel saves in the background', setup: (f) => { f.localTarget(f.source); } },
  { name: 'a target from another document is rejected even if the host returns it for the source container', setup: (f) => { f.targetElement.ownerDocument = f.otherDocument; } },
  { name: 'a context check failure cannot turn a successful write into a save failure', change: (f) => { f.sourceDocument.hasFocus = () => { throw new Error('Disposed document'); }; } }
];

for (const scenario of cases) test(scenario.name, async () => {
  await withWindow(async () => {
    const f = fixture(); scenario.setup?.(f);
    const submitted = f.plugin.loadWritingDraft();
    const entered = deferred(); const release = deferred();
    const create = f.app.vault.create.bind(f.app.vault);
    f.app.vault.create = async (filePath, content) => { entered.resolve(); await release.promise; return create(filePath, content); };
    const saving = f.plugin.submitWritingDraft(submitted.revision, scenario.noOrigin ? undefined : f.origin);
    await entered.promise;
    scenario.change?.(f);
    const latest = f.plugin.loadWritingDraft();
    release.resolve(); await saving;
    const saved = f.app.vault.getMarkdownFiles().filter((file) => f.app.metadataCache.getFileCache(file).frontmatter?.tangrow_kind === 'draft');
    assert.equal(saved.length, 1);
    assert.ok(saved[0]!.content.includes(submitted.text));
    assert.deepEqual(f.opens, scenario.reveal ? ['source-window'] : []);
    assert.equal(f.app.workspace.navigationRequests.length, 0, 'Global navigation must never choose the destination.');
    assert.ok(f.roots.every((root) => root === f.sourceContainer), 'Recent leaves must be scoped to the caller window.');
    assert.equal(f.plugin.loadWritingDraft().text, scenario.keep ? latest.text : '');
    assert.equal(f.plugin.loadWritingDraft().title, scenario.keep ? latest.title : '');
    assert.equal(f.original.content, '# Original note\n'); assert.equal(f.other.content, '# Other note\n');
    assert.equal(f.sourceDocument.count() + f.sourceDocument.defaultView.count(), 0, 'Navigation listeners must be released.');
    f.plugin.endWritingDraftComposition('new-composition');
  });
});

test('a failed write releases navigation listeners and keeps the draft for retry', async () => {
  await withWindow(async () => {
    const f = fixture(); const draft = f.plugin.loadWritingDraft(); f.app.vault.failCreates = 1;
    await assert.rejects(f.plugin.submitWritingDraft(draft.revision, f.origin), /Simulated vault write failure/);
    assert.deepEqual(f.plugin.loadWritingDraft(), draft);
    assert.equal(f.sourceDocument.count() + f.sourceDocument.defaultView.count(), 0);
    await f.plugin.submitWritingDraft(draft.revision, f.origin);
    assert.deepEqual(f.opens, ['source-window']);
  });
});

test('navigation failure after writing does not duplicate the saved draft on retry', async () => {
  await withWindow(async () => {
    const f = fixture(); f.failOpen();
    await f.plugin.submitWritingDraft(f.plugin.loadWritingDraft().revision, f.origin);
    assert.equal(f.plugin.loadWritingDraft().text, '');
    await assert.rejects(f.plugin.submitWritingDraft(f.plugin.loadWritingDraft().revision, f.origin), /Write a draft before saving/);
    assert.equal(f.app.vault.getMarkdownFiles().filter((file) => f.app.metadataCache.getFileCache(file).frontmatter?.tangrow_kind === 'draft').length, 1);
    assert.ok(harness.notices.some((notice) => notice.includes('Simulated navigation failure')));
    assert.equal(f.sourceDocument.count() + f.sourceDocument.defaultView.count(), 0);
  });
});
