import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CaptureRequest, CaptureSummary, Settings } from '../src/types';
import { readSettings } from '../src/model';
import type { MockApp, createMockApp as MockAppFactory } from './obsidian-mock';

class Element extends EventTarget {
  children: Element[] = [];
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  classes = new Set<string>();
  parentElement: Element | null = null;
  ownerDocument = { activeElement: null as Element | null };
  constructor(readonly tag = 'div') { super(); }
  createEl(tag: string, options: { text?: string; value?: string; cls?: string; attr?: Record<string, string> } = {}): Element {
    const child = new Element(tag);
    child.textContent = options.text ?? '';
    child.value = options.value ?? '';
    child.attributes = new Map(Object.entries(options.attr ?? {}));
    child.classes = new Set(options.cls?.split(' ') ?? []);
    child.parentElement = this;
    child.ownerDocument = this.ownerDocument;
    this.children.push(child);
    if (this.tag === 'select' && this.children.length === 1) this.value = child.value;
    return child;
  }
  createDiv(options = {}): Element { return this.createEl('div', options); }
  createSpan(options = {}): Element { return this.createEl('span', options); }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  addClass(key: string): void { this.classes.add(key); }
  focus(): void { this.ownerDocument.activeElement = this; }
  select(): void {}
  empty(): void { this.children = []; }
  contains(element: Element | null): boolean { return element !== null && (element === this || this.children.some((child) => child.contains(element))); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): Element[] {
    const matches = (element: Element): boolean => selector.startsWith('.') ? element.classes.has(selector.slice(1))
      : selector === 'button[data-capture-source]' ? element.tag === 'button' && Boolean(element.dataset.captureSource)
      : element.tag === selector;
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
interface Host {
  app: MockApp;
  settings: Settings;
  processCapture(path: string, request: CaptureRequest): Promise<string | null>;
  openNote(path: string): Promise<void>;
  aiReady(): boolean;
}
interface Panel {
  root: Element;
  timeline: Element;
  timelineCount: Element;
  footer: Element;
  captureFilter: 'pending' | 'processed' | 'all';
  selectedDay: string | null;
  renderTimeline(captures: CaptureSummary[]): void;
}
interface Dialog {
  contentEl: Element;
  setTitle(title: string): void;
  close(): void;
  onOpen(): void;
}
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  absWorkingDir: repository,
  stdin: { contents: "export { CapturePanel } from './src/capture-panel'; export { CaptureProcessingModal } from './src/capture-processing-modal'; export * from './tests/obsidian-mock';", resolveDir: repository, loader: 'ts' },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-capture-ui', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as {
  CapturePanel: new (host: Host) => Panel;
  CaptureProcessingModal: new (host: Host, capture: CaptureSummary) => Dialog;
  createMockApp: typeof MockAppFactory;
};
function host(): Host {
  return { app: harness.createMockApp(), settings: readSettings({ language: 'en' }), processCapture: async () => null, openNote: async () => undefined, aiReady: () => false };
}
function capture(name: string, fields: Partial<CaptureSummary> = {}): CaptureSummary {
  return { name, path: `00-Inbox/${name}.md`, folder: '00-Inbox', modified: 1, created: new Date(2026, 10, 9, 12).getTime(), ...fields };
}
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test('the capture timeline defaults to pending, exposes resumable actions and intersects status with the date', () => {
  const panel = new harness.CapturePanel(host());
  const root = new Element();
  Object.assign(panel, { root, timeline: root.createDiv(), timelineCount: root.createSpan(), footer: root.createDiv() });
  const entries = [capture('Pending'), capture('Finished', { processed: true }), capture('Interrupted', { processing: true })];
  panel.renderTimeline(entries);
  assert.equal(panel.timelineCount.textContent, 'Pending captures · 2');
  assert.deepEqual(panel.timeline.querySelectorAll('strong').map((element) => element.textContent), ['Interrupted', 'Pending']);
  assert.ok(panel.timeline.querySelectorAll('button').some((element) => element.getAttribute('aria-label') === 'Continue processing'));
  panel.captureFilter = 'processed';
  panel.renderTimeline(entries);
  assert.equal(panel.timelineCount.textContent, 'Processed captures · 1');
  assert.deepEqual(panel.timeline.querySelectorAll('strong').map((element) => element.textContent), ['Finished']);
  assert.ok(panel.timeline.querySelectorAll('button').some((element) => element.getAttribute('aria-label') === 'Move back to pending'));
  panel.captureFilter = 'all';
  panel.selectedDay = '2026-11-10';
  panel.renderTimeline(entries);
  assert.equal(panel.timeline.querySelectorAll('article').length, 0);
  assert.match(panel.timeline.querySelector('strong')!.textContent, /No captures match/);
});

test('the processing dialog validates project selection and opens the result only on a separate user action', async () => {
  const service = host();
  const project = service.app.vault.seedFile('20-Project/Launch/Launch.md', '# Launch');
  const requests: CaptureRequest[] = [];
  const opened: string[] = [];
  service.processCapture = async (_path, request) => { requests.push(request); return project.path; };
  service.openNote = async (path) => { opened.push(path); };
  const dialog = new harness.CaptureProcessingModal(service, capture('Source'));
  let closed = 0;
  Object.assign(dialog, { contentEl: new Element(), setTitle: () => undefined, close: () => { closed++; } });
  dialog.onOpen();
  const form = dialog.contentEl.querySelector('form')!;
  const [action, projectSelect] = form.querySelectorAll('select');
  const save = form.querySelectorAll('button').find((element) => element.getAttribute('type') === 'submit')!;
  action!.value = 'project';
  action!.dispatchEvent(new Event('change'));
  assert.equal(save.disabled, true);
  projectSelect!.value = project.path;
  projectSelect!.dispatchEvent(new Event('change'));
  assert.equal(save.disabled, false);
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  assert.deepEqual(requests, [{ action: 'project', projectPath: project.path }]);
  assert.deepEqual(opened, []);
  assert.equal(closed, 0);
  assert.equal(save.hidden, true);
  form.querySelectorAll('button').find((element) => element.textContent === 'Open result')!.dispatchEvent(new Event('click'));
  await flush();
  assert.deepEqual(opened, [project.path]);
  assert.equal(closed, 1);
});
