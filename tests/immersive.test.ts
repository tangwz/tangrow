import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readSettings } from '../src/model';
import type { JournalPeriod } from '../src/periodic-notes';

class Element extends EventTarget {
  children: Element[] = [];
  parentElement: Element | null = null;
  textContent = '';
  hidden = false;
  disabled = false;
  title = '';
  attributes = new Map<string, string>();
  classes = new Set<string>();
  constructor(readonly ownerDocument: TestDocument, readonly tag = 'div') { super(); }
  createEl(tag: string, options: { text?: string; attr?: Record<string, string> } = {}): Element {
    const child = new Element(this.ownerDocument, tag);
    child.textContent = options.text ?? '';
    child.attributes = new Map(Object.entries(options.attr ?? {}));
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  createSpan(options = {}): Element { return this.createEl('span', options); }
  createDiv(options = {}): Element { return this.createEl('div', options); }
  get lastElementChild(): Element | null { return this.children.at(-1) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  querySelector(tag: string): Element | null { return this.children.find((child) => child.tag === tag) ?? null; }
  addClass(name: string): void { this.classes.add(name); }
  removeClass(name: string): void { this.classes.delete(name); }
  empty(): void { for (const child of this.children) child.parentElement = null; this.children = []; }
  remove(): void {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
}
class TestDocument extends EventTarget {
  body = new Element(this, 'body');
  fullscreenElement = null;
}
interface Panel {
  periodControls: Element;
  selectDay(day: string): void;
  moveMonth(offset: number): void;
  journalDay(): string;
  renderPeriodControls(): void;
}
interface Immersion { close(): void }
interface Host {
  settings: ReturnType<typeof readSettings>;
  subscribe(listener: () => void): () => void;
  openPeriodicNote(period: JournalPeriod, date?: string, immersive?: boolean): Promise<void>;
}
interface Harness {
  CapturePanel: new (host: Host) => Panel;
  NoteImmersion: new (view: unknown, host: Host, closed: () => void) => Immersion;
}
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  absWorkingDir: repository,
  stdin: {
    contents: "export { CapturePanel } from './src/capture-panel'; export { NoteImmersion } from './src/immersive';",
    resolveDir: repository, sourcefile: 'immersive-test-entry.ts', loader: 'ts'
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-obsidian', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundled.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as Harness;

function createHost(): { host: Host; listeners: Set<() => void>; opened: unknown[][] } {
  const listeners = new Set<() => void>();
  const opened: unknown[][] = [];
  return {
    listeners, opened,
    host: {
      settings: readSettings({ language: 'en' }),
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      openPeriodicNote: async (...args) => { opened.push(args); }
    }
  };
}

test('period controls open notes for the selected date, including an ISO year boundary', async () => {
  const { host, opened } = createHost();
  const panel = new harness.CapturePanel(host);
  const document = new TestDocument();
  panel.periodControls = new Element(document);
  panel.selectDay('2024-12-30');
  panel.renderPeriodControls();
  assert.equal(panel.periodControls.children.length, 5);
  const weekly = panel.periodControls.children.find((button) => button.getAttribute('aria-label') === 'Open weekly note for 2025-W01');
  assert.ok(weekly);
  weekly.dispatchEvent(new Event('click'));
  const daily = panel.periodControls.children.find((button) => button.getAttribute('aria-label') === 'Open daily note for 2024-12-30');
  assert.ok(daily);
  daily.dispatchEvent(new Event('click'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [['weekly', '2024-12-30'], ['daily', '2024-12-30']]);
  panel.moveMonth(1);
  assert.equal(panel.journalDay(), '2025-01-01');
  panel.moveMonth(-1);
  assert.equal(panel.journalDay(), '2024-12-01');
});

test('native note immersion retains its editor and cleans up layout, subscriptions and Escape handling', () => {
  const { host, listeners } = createHost();
  const document = new TestDocument();
  const workspace = document.body.createDiv();
  const leaf = workspace.createDiv();
  const target = leaf.createDiv();
  const originalEditor = target.createDiv();
  target.addClass('existing-view');
  let focusCalls = 0;
  let closed = 0;
  const immersion = new harness.NoteImmersion({ containerEl: target, editor: { focus: () => { focusCalls++; } } }, host, () => { closed++; });
  assert.equal(target.parentElement, leaf);
  assert.equal(target.children[0], originalEditor);
  assert.equal(target.classes.has('tangrow-immersive-note'), true);
  assert.equal(workspace.classes.has('tangrow-immersive-ancestor'), true);
  assert.equal(document.body.classes.size, 0);
  assert.equal(focusCalls, 1);
  assert.equal(listeners.size, 1);
  const toolbar = target.lastElementChild!;
  assert.equal(toolbar.children[0]!.hidden, true);
  host.settings.language = 'zh-CN';
  for (const listener of listeners) listener();
  assert.notEqual(toolbar.children[1]!.getAttribute('aria-label'), 'Exit immersive mode');
  const escape = (composing: boolean): Event => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: 'Escape', isComposing: composing });
    return event;
  };
  document.dispatchEvent(escape(true));
  assert.equal(closed, 0);
  document.dispatchEvent(escape(false));
  assert.equal(closed, 1);
  assert.deepEqual([...target.classes], ['existing-view']);
  assert.equal(workspace.classes.size, 0);
  assert.equal(leaf.classes.size, 0);
  assert.equal(listeners.size, 0);
  assert.deepEqual(target.children, [originalEditor]);
  document.dispatchEvent(escape(false));
  assert.equal(closed, 1);
  immersion.close();
  assert.equal(closed, 1);
});
