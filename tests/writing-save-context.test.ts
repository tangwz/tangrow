import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { WritingDraft } from '../src/types';
import type { MockApp, Plugin as MockPlugin, MarkdownView as MockMarkdownView, createMockApp as MockAppFactory } from './obsidian-mock';

interface WritingPlugin extends MockPlugin {
  loadWritingDraft(): WritingDraft;
  updateWritingDraft(patch: Partial<Pick<WritingDraft, 'text' | 'title'>>, revision: number): boolean;
  submitWritingDraft(revision: number): Promise<void>;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
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
  plugins: [{ name: 'mock-writing-context', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as {
  TangrowPlugin: new (app: MockApp) => WritingPlugin;
  MarkdownView: new () => MockMarkdownView;
  createMockApp: typeof MockAppFactory;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function withWindow(run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 1, clearTimeout: () => undefined, setInterval: () => 1 } });
  try { await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('delayed writing saves respect window, control, note and draft changes without losing the saved snapshot', async () => {
  await withWindow(async () => {
    for (const change of ['none', 'window', 'control', 'leaf', 'note', 'draft', 'closed'] as const) {
      const app = harness.createMockApp();
      const plugin = new harness.TangrowPlugin(app);
      const original = app.vault.seedFile('20-Project/Original note.md', '# Keep this original note.\n');
      const other = app.vault.seedFile('20-Project/Other note.md', '# Keep this other note.\n');
      const markdown = new harness.MarkdownView();
      markdown.file = original;
      const origin = { view: markdown };
      app.workspace.setMostRecentLeaf(origin);
      const document = { activeElement: null as unknown, hidden: false, focused: true, hasFocus() { return this.focused; } };
      Object.assign(markdown.containerEl, { ownerDocument: document });
      const submittedText = '\u4e2d\u6587 saved snapshot.';
      plugin.updateWritingDraft({ text: submittedText, title: 'A saved title' }, 0);
      const draft = plugin.loadWritingDraft();
      const button = { disabled: false };
      document.activeElement = button;
      const started = deferred();
      const release = deferred();
      const create = app.vault.create.bind(app.vault);
      app.vault.create = async (filePath, content) => { started.resolve(); await release.promise; return create(filePath, content); };
      const saving = plugin.submitWritingDraft(draft.revision);
      await started.promise;
      if (change === 'window') document.focused = false;
      if (change === 'control') document.activeElement = { kind: 'title' };
      if (change === 'leaf') app.workspace.setMostRecentLeaf({ view: new harness.MarkdownView() });
      if (change === 'note') markdown.file = other;
      if (change === 'draft') {
        plugin.updateWritingDraft({ text: 'The newer body in another window.', title: 'The newer title' }, draft.revision);
        document.focused = false;
      }
      if (change === 'closed') { document.hidden = true; document.focused = false; }
      release.resolve();
      await saving;
      const saved = app.vault.getMarkdownFiles().filter((file) => app.metadataCache.getFileCache(file).frontmatter?.tangrow_kind === 'draft');
      assert.equal(saved.length, 1, change);
      assert.ok(saved[0]!.content.includes(submittedText), change);
      assert.equal(app.workspace.navigationRequests.length, change === 'none' ? 1 : 0, change);
      assert.equal(plugin.loadWritingDraft().text, change === 'draft' ? 'The newer body in another window.' : '', change);
      assert.equal(original.content, '# Keep this original note.\n');
      assert.equal(other.content, '# Keep this other note.\n');
    }
  });
});
