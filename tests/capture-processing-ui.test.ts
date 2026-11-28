import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CaptureRequest, CaptureSummary, Settings } from '../src/types';
import { readSettings } from '../src/model';
import type { CaptureSuggestion } from '../src/ai';
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
  requireAccess(): boolean;
  app: MockApp;
  settings: Settings;
  processCapture(path: string, request: CaptureRequest): Promise<string | null>;
  openCardFromCapture(path: string, beforeOpen?: () => boolean): Promise<boolean>;
  openNote(path: string): Promise<void>;
  aiReady(): boolean;
  readCapture(path: string): Promise<string>;
  suggestCapture(text: string, signal?: AbortSignal): Promise<CaptureSuggestion>;
}
interface Panel {
  root: Element;
  timeline: Element;
  timelineCount: Element;
  footer: Element;
  captureFilter: 'pending' | 'processed' | 'all';
  selectedDay: string | null;
  refresh(): void;
  renderTimeline(captures: CaptureSummary[]): void;
}
interface Dialog {
  contentEl: Element;
  setTitle(title: string): void;
  close(): void;
  onOpen(): void;
  onClose(): void;
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
  return {
    requireAccess: () => true, app: harness.createMockApp(), settings: readSettings({ language: 'en' }), processCapture: async () => null,
    openCardFromCapture: async () => false,
    openNote: async () => undefined, aiReady: () => false, readCapture: async () => 'Source body',
    suggestCapture: async () => { throw new Error('Unexpected suggestion request'); }
  };
}
function capture(name: string, fields: Partial<CaptureSummary> = {}): CaptureSummary {
  return { name, path: `00-Inbox/${name}.md`, folder: '00-Inbox', modified: 1, created: new Date(2026, 10, 9, 12).getTime(), ...fields };
}
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function openDialog(service: Host, source = capture('Source')): Dialog {
  const dialog = new harness.CaptureProcessingModal(service, source);
  Object.assign(dialog, { contentEl: new Element(), setTitle: () => undefined, close: () => dialog.onClose() });
  dialog.onOpen();
  return dialog;
}

async function suggestingDialog() {
  const service = host();
  const projectPath = service.app.vault.seedFile('20-Project/Launch/Launch.md', '# Launch').path;
  const pending = deferred<CaptureSuggestion>();
  service.aiReady = () => true;
  service.suggestCapture = () => pending.promise;
  const dialog = openDialog(service);
  const form = dialog.contentEl.querySelector('form')!;
  const [action, project] = form.querySelectorAll('select') as [Element, Element];
  const title = form.querySelector('input')!;
  const suggest = form.querySelector('.tangrow-capture-suggest')!;
  suggest.dispatchEvent(new Event('click'));
  await flush();
  const suggestion: CaptureSuggestion = { kind: 'task', title: 'Suggested task', project: null, due: null, reason: 'Suggested reason' };
  return { service, dialog, form, action, project, title, suggest, pending, suggestion, projectPath };
}

test('an AI suggestion updates an untouched processing form', async () => {
  const context = await suggestingDialog();
  context.pending.resolve(context.suggestion);
  await flush();
  assert.equal(context.action.value, 'task');
  assert.equal(context.title.value, 'Suggested task');
  assert.equal(context.form.querySelector('.tangrow-quick-suggestion')!.textContent, 'Suggested reason');
  assert.equal(context.suggest.disabled, false);
});

for (const field of ['title', 'action', 'project', 'reverted title'] as const) {
  test(`a late AI suggestion preserves a manually edited ${field}`, async () => {
    const context = await suggestingDialog();
    if (field === 'action') {
      context.action.value = 'done';
      context.action.dispatchEvent(new Event('change'));
    } else if (field === 'project') {
      context.project.value = context.projectPath;
      context.project.dispatchEvent(new Event('change'));
    } else {
      context.title.value = 'My title';
      context.title.dispatchEvent(new Event('input'));
      if (field === 'reverted title') {
        context.title.value = 'Source';
        context.title.dispatchEvent(new Event('input'));
      }
    }
    const expected = [context.action.value, context.title.value, context.project.value];
    context.pending.resolve(context.suggestion);
    await flush();
    assert.deepEqual([context.action.value, context.title.value, context.project.value], expected);
    assert.equal(context.form.querySelector('.tangrow-quick-suggestion')!.textContent, '');
    assert.equal(context.suggest.disabled, false);
  });
}

test('a suggestion finishing during submission cannot change the saved form', async () => {
  const context = await suggestingDialog();
  const saving = deferred<string | null>();
  const requests: CaptureRequest[] = [];
  context.service.processCapture = async (_path, request) => { requests.push(request); return saving.promise; };
  context.form.dispatchEvent(new Event('submit', { cancelable: true }));
  context.pending.resolve(context.suggestion);
  await flush();
  assert.deepEqual(requests, [{ action: 'note', title: 'Source' }]);
  assert.equal(context.action.value, 'note');
  assert.equal(context.title.value, 'Source');
  assert.equal(context.suggest.disabled, true);
  saving.resolve('00-Inbox/Source note.md');
  await flush();
});

test('closing the dialog invalidates a pending AI suggestion', async () => {
  const context = await suggestingDialog();
  context.dialog.close();
  context.pending.resolve(context.suggestion);
  await flush();
  assert.equal(context.dialog.contentEl.children.length, 0);
  assert.equal(context.action.value, 'note');
  assert.equal(context.title.value, 'Source');
});

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

test('clearing the pending inbox offers to see all processed captures while an empty date keeps its own feedback', async () => {
  const panel = new harness.CapturePanel(host());
  const root = new Element();
  const statusFilter = root.createEl('select', { value: 'pending' });
  const finished = [capture('Finished', { processed: true })];
  Object.assign(panel, {
    root, timeline: root.createDiv(), timelineCount: root.createSpan(), footer: root.createDiv(), statusFilter,
    refresh: () => panel.renderTimeline(finished)
  });

  panel.selectedDay = '2026-11-10';
  panel.renderTimeline(finished);
  assert.equal(panel.timeline.querySelector('strong')?.textContent, 'No captures match this filter');
  assert.equal(panel.timeline.querySelector('button'), null);

  panel.selectedDay = null;
  panel.renderTimeline(finished);
  assert.equal(panel.timeline.querySelector('strong')?.textContent, 'Nothing left to process');
  const seeProcessed = panel.timeline.querySelector('button')!;
  assert.equal(seeProcessed.getAttribute('aria-label'), 'See 1 processed');
  seeProcessed.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(statusFilter.value, 'processed');
  assert.equal(root.ownerDocument.activeElement, statusFilter);
  assert.equal(panel.timelineCount.textContent, 'Processed captures · 1');
  assert.equal(panel.timeline.querySelector('strong')?.textContent, 'Finished');
});

test('the capture timeline shows one passive coming soon hint across filters and language changes', () => {
  const service = host();
  const panel = new harness.CapturePanel(service);
  const root = new Element();
  Object.assign(panel, { root, timeline: root.createDiv(), timelineCount: root.createSpan(), footer: root.createDiv() });
  const entries = [capture('Pending'), capture('Finished', { processed: true })];

  panel.renderTimeline(entries);
  let hints = root.querySelectorAll('.tangrow-coming-soon');
  assert.equal(hints.length, 1);
  assert.equal(hints[0]?.querySelector('.tangrow-coming-soon-label')?.textContent, 'Coming soon');
  assert.equal(hints[0]?.querySelector('button'), null);
  assert.equal(hints[0]?.querySelector('a'), null);
  assert.equal(hints[0]?.getAttribute('tabindex'), null);

  service.settings.language = 'zh-CN';
  panel.captureFilter = 'processed';
  panel.renderTimeline(entries);
  hints = root.querySelectorAll('.tangrow-coming-soon');
  assert.equal(hints.length, 1);
  assert.equal(hints[0]?.querySelector('.tangrow-coming-soon-description')?.textContent, 'AI 为每条速记建议去向');
  assert.equal(hints[0]?.querySelector('.tangrow-coming-soon-label')?.textContent, '即将推出');

  panel.renderTimeline([]);
  assert.equal(root.querySelectorAll('.tangrow-coming-soon').length, 0);
});

test('the capture timeline refreshes the coming soon hint when its preference changes', () => {
  const service = host();
  const entries = [capture('Pending')];
  Object.assign(service, { snapshot: () => ({ captures: entries }) });
  const panel = new harness.CapturePanel(service);
  const root = new Element();
  Object.assign(panel, {
    mounted: true, root, timeline: root.createDiv(), timelineCount: root.createSpan(), footer: root.createDiv(), language: service.settings.language
  });
  panel.refresh();
  assert.equal(root.querySelectorAll('.tangrow-coming-soon').length, 1);
  service.settings.showComingSoon = false;
  panel.refresh();
  assert.equal(root.querySelectorAll('.tangrow-coming-soon').length, 0);
  assert.equal(panel.timeline.querySelectorAll('article').length, 1);
  service.settings.showComingSoon = true;
  panel.refresh();
  assert.equal(root.querySelectorAll('.tangrow-coming-soon').length, 1);
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

test('the capture task form submits an optional project link only when selected', async () => {
  const service = host();
  const projectPath = service.app.vault.seedFile('20-Project/Launch/Launch.md', '# Launch').path;
  const requests: CaptureRequest[] = [];
  service.processCapture = async (_path, request) => { requests.push(request); return null; };
  for (const project of ['', projectPath]) {
    const dialog = openDialog(service);
    const form = dialog.contentEl.querySelector('form')!;
    const [action, picker] = form.querySelectorAll('select') as [Element, Element];
    action.value = 'task';
    action.dispatchEvent(new Event('change'));
    assert.equal(picker.parentElement?.hidden, false);
    assert.equal(picker.parentElement?.querySelector('label')?.textContent, 'Project or area link (optional)');
    picker.value = project;
    picker.dispatchEvent(new Event('change'));
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
  }
  assert.deepEqual(requests, [
    { action: 'task', title: 'Source' },
    { action: 'task', title: 'Source', projectPath }
  ]);
});

test('filing search shows grouped PARA entries and submits the selected destination', async () => {
  const service = host();
  const area = service.app.vault.seedFolder('30-Area/Health');
  service.app.vault.seedFolder('40-Resources/Systems');
  service.app.vault.seedFile('20-Project/Launch/Launch.md', '# Launch');
  const requests: CaptureRequest[] = [];
  service.processCapture = async (_path, request) => { requests.push(request); return null; };
  const dialog = openDialog(service);
  const form = dialog.contentEl.querySelector('form')!;
  const [, picker] = form.querySelectorAll('select') as [Element, Element];
  const search = form.querySelector('.tangrow-capture-destination-search')!;
  assert.deepEqual(picker.querySelectorAll('optgroup').map((group) => group.getAttribute('label')), ['Projects', 'Areas', 'Resources']);
  search.value = 'hEaLtH';
  search.dispatchEvent(new Event('input'));
  assert.deepEqual(picker.querySelectorAll('optgroup').map((group) => group.getAttribute('label')), ['Areas']);
  assert.deepEqual(picker.querySelectorAll('option').map((option) => option.textContent), ['Keep in the inbox', area.path]);
  picker.value = `area:${area.path}`;
  picker.dispatchEvent(new Event('change'));
  assert.equal(form.querySelector('.tangrow-destination')?.textContent, `Destination: ${area.path}`);
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  assert.deepEqual(requests, [{ action: 'note', title: 'Source', destination: { kind: 'area', path: area.path } }]);
});

test('task linking offers area notes and omits empty area folders and resources', async () => {
  const service = host();
  const note = service.app.vault.seedFile('30-Area/Health/README.md', '# Health');
  service.app.vault.seedFolder('30-Area/Empty');
  service.app.vault.seedFile('40-Resources/Reference.md', '# Resources');
  const requests: CaptureRequest[] = [];
  service.processCapture = async (_path, request) => { requests.push(request); return null; };
  const dialog = openDialog(service);
  const form = dialog.contentEl.querySelector('form')!;
  const [action, picker] = form.querySelectorAll('select') as [Element, Element];
  action.value = 'task';
  action.dispatchEvent(new Event('change'));
  assert.deepEqual(picker.querySelectorAll('option').map((option) => option.textContent), ['No link', '30-Area/Health']);
  picker.value = 'area:30-Area/Health';
  picker.dispatchEvent(new Event('change'));
  assert.match(form.querySelector('.tangrow-destination')?.textContent ?? '', /Link: 30-Area\/Health\/README\.md/);
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  assert.deepEqual(requests, [{ action: 'task', title: 'Source', areaPath: note.path }]);
});

test('distilling hands off to the source-aware card editor without submitting capture processing', async () => {
  const service = host();
  const ready = deferred<void>();
  const source = capture('Source');
  const dialog = openDialog(service, source);
  const form = dialog.contentEl.querySelector('form')!;
  const distill = form.querySelectorAll('button').find((element) => element.textContent === 'Distill a card')!;
  const cardSources: string[] = [];
  const requests: CaptureRequest[] = [];
  service.processCapture = async (_path, request) => { requests.push(request); return null; };
  service.openCardFromCapture = async (path, beforeOpen) => {
    assert.equal(path, source.path);
    await ready.promise;
    if (!beforeOpen?.()) return false;
    assert.equal(dialog.contentEl.children.length, 0);
    cardSources.push(path);
    return true;
  };
  distill.dispatchEvent(new Event('click'));
  distill.dispatchEvent(new Event('click'));
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(distill.disabled, true);
  ready.resolve();
  await flush();

  assert.deepEqual(cardSources, [source.path]);
  assert.deepEqual(requests, []);
});

test('closing capture processing during distillation preparation cancels the card editor handoff', async () => {
  const service = host();
  const ready = deferred<void>();
  const dialog = openDialog(service);
  const distill = dialog.contentEl.querySelectorAll('button').find((element) => element.textContent === 'Distill a card')!;
  let handoff: boolean | undefined;
  service.openCardFromCapture = async (_path, beforeOpen) => {
    await ready.promise;
    handoff = beforeOpen?.();
    return handoff === true;
  };
  distill.dispatchEvent(new Event('click'));
  dialog.close();
  ready.resolve();
  await flush();
  assert.equal(handoff, false);
  assert.equal(dialog.contentEl.children.length, 0);
});

test('denied or failed distillation keeps the processing form available', async () => {
  const service = host();
  const dialog = openDialog(service);
  const distill = dialog.contentEl.querySelectorAll('button').find((element) => element.textContent === 'Distill a card')!;
  let attempts = 0;
  service.openCardFromCapture = async () => { attempts++; throw new Error('This capture no longer exists.'); };
  service.requireAccess = () => false;
  distill.dispatchEvent(new Event('click'));
  assert.equal(attempts, 0);
  assert.equal(distill.disabled, false);
  service.requireAccess = () => true;
  distill.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(attempts, 1);
  assert.equal(distill.disabled, false);
  assert.equal(dialog.contentEl.querySelector('.tangrow-input-error')?.textContent, 'This capture no longer exists.');

  service.settings.knowledgeEnabled = false;
  const noKnowledge = openDialog(service);
  assert.ok(noKnowledge.contentEl.querySelectorAll('button').every((element) => element.textContent !== 'Distill a card'));
});
