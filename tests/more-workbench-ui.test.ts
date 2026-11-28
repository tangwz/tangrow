import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readSettings } from '../src/model';
import type { ActionId, BaseId, NoteSummary, SidebarHost, Snapshot } from '../src/types';

interface ElementOptions {
  cls?: string;
  text?: string;
  value?: string;
  attr?: Record<string, string>;
}

interface DocumentState { activeElement: Element | null }

class Element extends EventTarget {
  readonly dataset: Record<string, string> = {};
  readonly classes: Set<string>;
  private readonly attributes: Map<string, string>;
  children: Element[] = [];
  disabled = false;
  hidden = false;
  value: string;
  textContent: string;

  constructor(readonly tag = 'div', readonly ownerDocument: DocumentState = { activeElement: null }, options: ElementOptions = {}) {
    super();
    this.classes = new Set(options.cls?.split(' '));
    this.attributes = new Map(Object.entries(options.attr ?? {}));
    this.value = options.value ?? '';
    this.textContent = options.text ?? '';
  }

  createEl(tag: string, options?: ElementOptions): Element {
    const element = new Element(tag, this.ownerDocument, options);
    this.children.push(element);
    return element;
  }
  createDiv(options?: ElementOptions): Element { return this.createEl('div', options); }
  createSpan(options?: ElementOptions): Element { return this.createEl('span', options); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addClass(...names: string[]): void { for (const name of names) this.classes.add(name); }
  empty(): void {
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
    this.children = [];
  }
  hasChildNodes(): boolean { return this.children.length > 0; }
  contains(node: Element | null): boolean { return node === this || this.children.some((child) => child.contains(node)); }
  focus(): void { this.ownerDocument.activeElement = this; }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
  querySelectorAll(selector: string): Element[] {
    return this.all().slice(1).filter((element) => selector.split(',').some((part) => {
      const query = part.trim();
      const action = /\[data-tangrow-action="([^"]+)"\]$/.exec(query);
      if (action) return element.dataset.tangrowAction === action[1];
      if (query.startsWith('.')) return element.classes.has(query.slice(1));
      return element.tag === query;
    }));
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  absWorkingDir: repository,
  stdin: { contents: "export { TangrowSidebar } from './src/sidebar';", resolveDir: repository, loader: 'ts' },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-more-workbench', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const { TangrowSidebar } = moduleObject.exports as typeof import('../src/sidebar');

function fixture() {
  const state: Snapshot = {
    active: null, activePinned: false,
    counts: { notes: 0, projects: 0, captures: 0, drafts: 0, focusMinutes: 0, tasks: 0 },
    recent: [], recentOpened: [], pins: [], captures: [], drafts: [], tasks: [], habits: [], focus: null,
    focusRemainingMs: 0, supportReady: true, projectFolders: [], widePage: false
  };
  const actions: ActionId[] = [];
  const bases: BaseId[] = [];
  const host = {
    settings: readSettings({ language: 'en' }), snapshot: () => state,
    action: async (id: ActionId) => { actions.push(id); },
    openBase: async (id: BaseId) => { bases.push(id); },
    loadWritingDraft: () => ({ text: '', title: '', revision: 0 })
  } satisfies Pick<SidebarHost, 'settings' | 'snapshot' | 'action' | 'openBase' | 'loadWritingDraft'>;
  const view = new TangrowSidebar({} as ConstructorParameters<typeof TangrowSidebar>[0], host as SidebarHost);
  const root = new Element();
  const content = root.createDiv();
  Object.assign(view, { contentEl: root, workspacePane: content, noteLabel: root.createDiv(), isMounted: true });
  view.showSection('more');
  return { view, state, content, actions, bases, settings: host.settings };
}

function actionButtons(content: Element, id: string): Element[] {
  return content.querySelectorAll('button').filter((button) => button.dataset.tangrowAction === id);
}

function actionButton(content: Element, id: string): Element {
  const matches = actionButtons(content, id);
  assert.equal(matches.length, 1, id);
  return matches[0]!;
}

async function click(button: Element): Promise<void> {
  assert.equal(button.disabled, false);
  button.focus();
  button.dispatchEvent(new Event('click'));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const legacyPages = [['focus', 'Focus'], ['habits', 'Habits'], ['pins', 'Pins']] as const;
const subpages = [...legacyPages, ['databases', 'Your database views'], ['tools', 'File tools']] as const;

test('the More navigation label stays short and localized when the interface language changes', () => {
  const { view, content, settings } = fixture();
  const button = content.createEl('button');
  const label = button.createSpan({ cls: 'tangrow-nav-label' });
  Object.assign(view, { navButtons: new Map([['more', button]]) });

  view['refreshShellLabels']();
  assert.equal(label.textContent, 'More');
  assert.equal(button.getAttribute('aria-label'), 'More');

  settings.language = 'zh-CN';
  view['refreshShellLabels']();
  assert.equal(label.textContent, '更多');
  assert.equal(button.getAttribute('aria-label'), '更多');
});

test('More exposes one report entry and restores the opening row after returning from each subpage', async () => {
  const { content, actions, bases } = fixture();
  assert.deepEqual(content.querySelectorAll('section').map((section) => section.children[0]?.textContent), ['Extras', 'Browse', 'Tools', 'Settings']);
  assert.equal(actionButtons(content, 'report').length, 0);
  await click(actionButton(content, 'more-report'));
  assert.deepEqual(actions, ['report']);
  for (const [id, title] of subpages) {
    const key = `more-${id}`;
    await click(actionButton(content, key));
    assert.ok(content.all().some((element) => element.textContent === title), title);
    assert.equal(actionButtons(content, 'more-report').length + actionButtons(content, 'report').length, 0);
    assert.equal(content.ownerDocument.activeElement, actionButton(content, 'more-back'));
    if (id === 'databases') {
      const allNotes = content.querySelectorAll('button').find((button) => button.getAttribute('aria-label') === 'All notes');
      assert.ok(allNotes);
      await click(allNotes);
      assert.deepEqual(bases, ['notes']);
    }
    await click(actionButton(content, 'more-back'));
    assert.equal(content.ownerDocument.activeElement, actionButton(content, key));
    assert.equal(actionButtons(content, 'more-report').length, 1);
  }
  assert.deepEqual(actions, ['report']);
});

test('legacy sidebar entries open the matching More page and can return to its landing', () => {
  const { view, content } = fixture();
  for (const [entry, title] of legacyPages) {
    view.showSection(entry);
    assert.ok(content.all().some((element) => element.textContent === title), title);
    assert.equal(actionButtons(content, 'more-report').length, 0);
    assert.equal(actionButtons(content, 'more-back').length, 1);
    view.showSection('more');
    assert.equal(actionButtons(content, 'more-report').length, 1);
  }
});

const toolGroups: Record<string, ActionId[]> = {
  'Current file': ['copy-link', 'copy-path', 'file-location'],
  'Current note': ['toggle-pin', 'fold', 'unfold', 'page-width', 'cover', 'title-date', 'timestamp'],
  Workspace: ['refresh', 'random-note', 'all-width', 'file-list', 'stack-tabs', 'settings', 'hide-panel'],
  Appearance: ['toggle-theme', 'appearance']
};

test('More file tools group actions and retain file type guards', async () => {
  const { view, state, content, actions } = fixture();
  const base: NoteSummary = { path: '00-Inbox/Reading.base', name: 'Reading', folder: '00-Inbox', modified: 1 };
  const note: NoteSummary = { ...base, path: '00-Inbox/Reading.md' };
  for (const active of [null, base, note]) {
    state.active = active;
    state.activePinned = state.widePage = active === note;
    state.counts.notes = active === note ? 1 : 0;
    view.showSection('more');
    await click(actionButton(content, 'more-tools'));
    const groups = content.querySelectorAll('.tangrow-tool-list');
    assert.deepEqual(groups.map((group) => group.getAttribute('aria-label')), Object.keys(toolGroups));
    for (const group of groups) {
      assert.equal(group.getAttribute('role'), 'group');
      const expected = toolGroups[group.getAttribute('aria-label') ?? ''];
      assert.deepEqual(group.querySelectorAll('button').map((button) => button.dataset.tangrowAction), expected);
    }
    for (const id of toolGroups['Current file']!) assert.equal(actionButton(content, id).disabled, !active, id);
    for (const id of toolGroups['Current note']!) assert.equal(actionButton(content, id).disabled, active !== note, id);
    assert.equal(actionButton(content, 'random-note').disabled, active !== note);
    assert.equal(actionButton(content, 'refresh').disabled, false);
    if (active) await click(actionButton(content, 'file-location'));
  }
  assert.equal(actionButton(content, 'toggle-pin').getAttribute('aria-pressed'), 'true');
  assert.equal(actionButton(content, 'page-width').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(actions, ['file-location', 'file-location']);
});
