import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CaptureSuggestion, QuickKind } from '../src/ai';
import type { Settings } from '../src/types';
import type { MockApp, TFile, createMockApp as AppFactory } from './obsidian-mock';

class Element extends EventTarget {
  children: Element[] = [];
  textContent = '';
  value = '';
  disabled = false;
  classes = new Set<string>();
  attributes = new Map<string, string>();
  constructor(readonly tag = 'div') { super(); }
  createEl(tag: string, options: { text?: string; value?: string; cls?: string; attr?: Record<string, string> } = {}): Element {
    const child = new Element(tag);
    child.textContent = options.text ?? '';
    child.value = options.value ?? '';
    child.classes = new Set(options.cls?.split(' ') ?? []);
    child.attributes = new Map(Object.entries(options.attr ?? {}));
    this.children.push(child);
    return child;
  }
  createDiv(options = {}): Element { return this.createEl('div', options); }
  createSpan(options = {}): Element { return this.createEl('span', options); }
  addClass(...names: string[]): void { names.forEach((name) => this.classes.add(name)); }
  empty(): void { this.children = []; }
  focus(): void {}
  setSelectionRange(): void {}
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  querySelectorAll(selector: string): Element[] {
    const matches = (element: Element): boolean => selector.split(',').some((part) => {
      const value = part.trim();
      return value.startsWith('.') ? element.classes.has(value.slice(1)) : element.tag === value;
    });
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}

interface Host {
  settings: Settings;
  aiReady(): boolean;
  suggestCapture(text: string): Promise<CaptureSuggestion>;
}
interface Dialog {
  text: string;
  original: string | null;
  kind: QuickKind;
  contentEl: Element;
  render(): void;
  suggest(): Promise<void>;
  save(): Promise<void>;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  absWorkingDir: repository,
  stdin: { contents: "export { default as TangrowPlugin } from './src/main'; export { QuickAddModal } from './src/quick-add'; export * from './tests/obsidian-mock';", resolveDir: repository, loader: 'ts' },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-quick-add', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as {
  TangrowPlugin: new (app: MockApp) => Host;
  QuickAddModal: new (host: Host, kind: QuickKind, text: string) => Dialog;
  createMockApp: typeof AppFactory;
  notices: string[];
};

function setup(text: string, kind: QuickKind = 'capture') {
  const app = harness.createMockApp();
  const plugin = new harness.TangrowPlugin(app);
  plugin.settings.language = 'en';
  plugin.aiReady = () => true;
  plugin.suggestCapture = async () => ({ kind: 'project', title: 'Launch', due: null, project: null, reason: 'Project material' });
  const dialog = new harness.QuickAddModal(plugin, kind, text);
  let closed = false;
  Object.assign(dialog, { contentEl: new Element(), setTitle: () => undefined, close: () => { closed = true; } });
  dialog.render();
  return { app, plugin, dialog, isClosed: () => closed };
}

const SOURCE = 'Ship the launch\n\n- Keep the migration checklist\n- [ ] Verify rollback\n\n[Spec](https://example.com/spec) and [[Design]]';

test('a project suggestion preserves the source in the editable input and the new project note', async () => {
  const { app, dialog, isClosed } = setup(SOURCE);
  await dialog.suggest();
  assert.equal(dialog.contentEl.querySelector('textarea')!.value, `Launch\n${SOURCE}`);
  assert.equal(app.vault.getMarkdownFiles().length, 0);
  await dialog.save();
  const file = app.vault.getAbstractFileByPath('20-Project/Launch/Launch.md') as TFile;
  assert.ok(file);
  assert.ok(file.content.endsWith(`# Launch\n\n${SOURCE}\n`));
  assert.equal(app.metadataCache.getFileCache(file).frontmatter?.tangrow_kind, 'project');
  assert.equal(app.vault.getMarkdownFiles().length, 1);
  assert.equal(dialog.original, null);
  assert.equal(dialog.text, '');
  assert.equal(isClosed(), true);
});

test('project edits and source material survive a failed write to an existing project and a retry', async () => {
  const { app, dialog, isClosed } = setup(SOURCE);
  const existing = app.vault.seedFile('20-Project/Existing/Launch.md', '# Keep the existing note\n');
  await dialog.suggest();
  const editor = dialog.contentEl.querySelector('textarea')!;
  editor.value += '\n\nAdded during review.';
  editor.dispatchEvent(new Event('input'));
  const project = dialog.contentEl.querySelector('select')!;
  project.value = '20-Project/Existing';
  project.dispatchEvent(new Event('change'));
  const submitted = dialog.text;
  app.vault.failCreates = 1;
  await dialog.save();
  assert.equal(dialog.text, submitted);
  assert.equal(dialog.original, SOURCE);
  assert.equal(isClosed(), false);
  assert.equal(existing.content, '# Keep the existing note\n');
  assert.equal(harness.notices.at(-1), 'Simulated vault write failure');
  await dialog.save();
  const saved = app.vault.getAbstractFileByPath('20-Project/Existing/Launch (2).md') as TFile;
  assert.ok(saved.content.endsWith(`${SOURCE}\n\nAdded during review.\n`));
  assert.equal(existing.content, '# Keep the existing note\n');
  assert.equal(app.vault.getMarkdownFiles().length, 2);
  assert.equal(isClosed(), true);
});

test('undoing a project suggestion restores the exact original capture', async () => {
  const { app, dialog } = setup(SOURCE);
  await dialog.suggest();
  const undo = dialog.contentEl.querySelectorAll('button').find((button) => button.getAttribute('aria-label') === 'Undo')!;
  undo.dispatchEvent(new Event('click'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(dialog.kind, 'capture');
  assert.equal(dialog.text, SOURCE);
  await dialog.save();
  const files = app.vault.getMarkdownFiles();
  assert.equal(files.length, 1);
  assert.ok(files[0]!.path.startsWith('00-Inbox/'));
  assert.ok(files[0]!.content.endsWith(`${SOURCE}\n`));
});

test('manually entered project bodies are saved while title-only projects still work', async () => {
  for (const body of ['', '\n\nRequirements\n\n- Keep every line']) {
    const { app, dialog } = setup(`Manual${body}`, 'project');
    await dialog.save();
    const saved = app.vault.getAbstractFileByPath('20-Project/Manual/Manual.md') as TFile;
    assert.ok(saved.content.endsWith(`# Manual\n\n${body.trim()}\n`));
  }
});

test('a project suggestion without a title preserves the source heading and body', async () => {
  const { app, plugin, dialog } = setup(SOURCE);
  plugin.suggestCapture = async () => ({ kind: 'project', title: '', due: null, project: null, reason: 'Project material' });
  await dialog.suggest();
  await dialog.save();
  const saved = app.vault.getAbstractFileByPath('20-Project/Ship the launch/Ship the launch.md') as TFile;
  assert.ok(saved.content.endsWith(`# ${SOURCE}\n`));
});
