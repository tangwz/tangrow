/// <reference lib="es2024.promise" />
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { recentDays } from '../src/model';
import { canonicalEntityNotes, reportStatusSource } from '../src/report-metrics';
import type { ReportData, ReportDestination, ReportEntity, ReportPage, ReportRange, ReportRecord, ReportSnapshot, ReportStatusChange, ReportTask, ReportTaskStatus } from '../src/report-contract';
import type { Settings } from '../src/types';
import type { MockApp, TFile as MockFile, createMockApp as AppFactory } from './obsidian-mock';

interface ReportPlugin {
  settings: Settings;
  loadReport(range: ReportRange): Promise<ReportSnapshot>;
  updateReportStatus(change: ReportStatusChange): Promise<void>;
  subscribe(listener: () => void): () => void;
}
interface ReportView {
  snapshot: ReportSnapshot;
  mounted: boolean;
  page: string;
  refresh(): Promise<void>;
  renderEntities(parent: Element, entities: ReportEntity[], collection: 'projects' | 'areas'): void;
  renderTasks(parent: Element, data: ReportData): void;
  renderClips(parent: Element, data: ReportData): void;
  renderResources(parent: Element, data: ReportData): void;
  noteStatus(parent: Element, note: ReportRecord): void;
}
interface RangeReportView extends ReportView {
  readonly range: ReportRange;
  snapshotRange: ReportRange;
  loading: boolean;
  contentEl: Element;
  render(): void;
  selectPage(page: ReportPage): void;
  navigate(destination: ReportDestination): void;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  absWorkingDir: repository,
  stdin: { contents: "export { default as TangrowPlugin } from './src/main'; export { TangrowReport } from './src/report'; export { changeReportTaskStatus } from './src/report-editing'; export * from './tests/obsidian-mock';", resolveDir: repository, loader: 'ts' },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-report-editing', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as {
  TangrowPlugin: new (app: MockApp) => ReportPlugin;
  TangrowReport: new (leaf: unknown, host: ReportPlugin) => ReportView;
  changeReportTaskStatus(content: string, task: ReportTask, status: ReportTaskStatus): string;
  createMockApp: typeof AppFactory;
  notices: string[];
};

function setup() {
  const app = harness.createMockApp();
  const plugin = new harness.TangrowPlugin(app);
  plugin.settings.language = 'en';
  return { app, plugin };
}
function note(app: MockApp, path: string, fields: Record<string, unknown> = {}, body = '# Keep this body.\n'): MockFile {
  const yaml = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}\n`).join('');
  return app.vault.seedFile(path, `---\n${yaml}---\n\n${body}`);
}
async function source(plugin: ReportPlugin, file: MockFile) {
  return reportStatusSource((await plugin.loadReport(30)).data.notes.find((record) => record.path === file.path)!);
}
function entityChange(snapshot: ReportSnapshot, path: string, status: 'open' | 'done' | 'archived', collection: 'projects' | 'areas' = 'projects'): ReportStatusChange {
  return { kind: 'entity', collection, path, status, sources: canonicalEntityNotes(snapshot.data.notes, path).map(reportStatusSource) };
}
function fields(app: MockApp, file: MockFile): Record<string, unknown> { return app.metadataCache.getFileCache(file).frontmatter ?? {}; }

test('note status editing preserves the body and other fields, and respects existing status field names', async () => {
  for (const initial of [{ status: 'active' }, { tangrow_status: 'open' }, { status: 'active', tangrow_status: 'open' }, {}]) {
    const { app, plugin } = setup();
    const file = note(app, '00-Inbox/Note.md', { ...initial, custom: ['keep', 'these'] });
    await plugin.updateReportStatus({ kind: 'note', source: await source(plugin, file), status: 'done' });
    const saved = fields(app, file);
    assert.deepEqual(saved.custom, ['keep', 'these']);
    assert.ok(file.content.endsWith('\n# Keep this body.\n'));
    if ('status' in initial) assert.equal(saved.status, 'done');
    if ('tangrow_status' in initial || !('status' in initial)) assert.equal(saved.tangrow_status, 'done');
    else assert.equal(saved.tangrow_status, undefined);
    assert.deepEqual(app.vault.createdPaths, []);
  }
});

test('clip completion and its source note reflect the same saved status', async () => {
  const { app, plugin } = setup();
  const clip = note(app, '40-Resources/Clip.md', { source: 'https://example.com/article', status: 'active' });
  assert.equal((await plugin.loadReport(30)).data.completion.clips.open, 1);
  await plugin.updateReportStatus({ kind: 'note', source: await source(plugin, clip), status: 'done' });
  const report = await plugin.loadReport(30);
  assert.equal(report.data.completion.clips.done, 1);
  assert.equal(report.data.completion.clips.rate, 1);
  assert.equal(fields(app, clip).source, 'https://example.com/article');
  await plugin.updateReportStatus({ kind: 'note', source: await source(plugin, clip), status: 'archived' });
  assert.equal((await plugin.loadReport(30)).data.completion.clips.archived, 1);
});

test('saving waits for the native index before the report reloads stale status metadata', async () => {
  const { app, plugin } = setup();
  const file = note(app, '00-Inbox/Delayed.md', { status: 'active' });
  const expected = await source(plugin, file);
  const original = app.metadataCache.getFileCache;
  const stale = original(file);
  let indexed = false;
  app.metadataCache.getFileCache = (entry) => entry === file && !indexed ? stale : original(entry);
  let finished = false;
  const saving = plugin.updateReportStatus({ kind: 'note', source: expected, status: 'done' }).then(() => { finished = true; });
  await flush();
  assert.equal(finished, false);
  assert.ok(file.content.includes('status: "done"'));
  indexed = true;
  app.metadataCache.trigger('changed', file);
  await saving;
  assert.equal((await plugin.loadReport(30)).data.notes[0]!.frontmatter!.status, 'done');
});

test('a project status edit aligns canonical sources without changing ordinary or nested notes', async () => {
  const { app, plugin } = setup();
  const folder = '20-Project/Alpha';
  const primary = note(app, `${folder}/Alpha.md`);
  const readme = note(app, `${folder}/README.md`, { status: 'active' });
  const index = note(app, `${folder}/index.md`, { tangrow_status: 'done' });
  const empty = note(app, `${folder}/Overview.md`);
  const log = note(app, `${folder}/Log.md`, { status: 'active' });
  const nested = note(app, `${folder}/Sub/README.md`, { status: 'active' });
  const untouched = [empty, log, nested].map((file) => file.content);
  const before = await plugin.loadReport(30);
  assert.equal(before.data.projects[0]!.status, 'unknown');
  await plugin.updateReportStatus(entityChange(before, folder, 'done'));
  const after = await plugin.loadReport(30);
  assert.equal(after.data.projects[0]!.status, 'done');
  assert.equal(after.data.completion.projects.rate, 1);
  assert.equal(fields(app, primary).tangrow_status, 'done');
  assert.equal(fields(app, readme).status, 'done');
  assert.equal(fields(app, index).tangrow_status, 'done');
  assert.deepEqual([empty, log, nested].map((file) => file.content), untouched);
  assert.deepEqual(app.vault.createdPaths, []);
});

test('the first canonical note preserves an existing entity creation date and 90-day gains', async () => {
  const { app, plugin } = setup();
  const folder = '20-Project/Old project';
  const file = note(app, `${folder}/Research.md`);
  file.stat.ctime = Date.now() - 200 * 86_400_000;
  const original = file.content;
  const before = await plugin.loadReport(30);
  await plugin.updateReportStatus(entityChange(before, folder, 'open'));
  const created = app.vault.getAbstractFileByPath(`${folder}/README.md`) as MockFile;
  const after = await plugin.loadReport(30);
  assert.equal(fields(app, created).tangrow_status, 'open');
  assert.equal(fields(app, created).tangrow_kind, 'project');
  assert.equal(after.data.projects[0]!.created, before.data.projects[0]!.created);
  assert.equal(after.data.gains90.projects, before.data.gains90.projects);
  assert.equal(after.data.counts.projects, before.data.counts.projects);
  assert.equal(after.data.projects[0]!.noteCount, 2);
  assert.equal(file.content, original);
});

test('an empty area can acquire a canonical note and an editable status', async () => {
  const { app, plugin } = setup();
  const folder = '30-Area/Health';
  app.vault.seedFolder(folder);
  const before = await plugin.loadReport(30);
  await plugin.updateReportStatus(entityChange(before, folder, 'archived', 'areas'));
  const after = await plugin.loadReport(30);
  assert.equal(after.data.areas[0]!.status, 'archived');
  assert.equal(after.data.areas[0]!.notePath, `${folder}/README.md`);
  assert.equal(after.data.counts.areas, before.data.counts.areas);
});

test('stale unknown status values and changes during the atomic write cannot be overwritten', async () => {
  const { app, plugin } = setup();
  const file = note(app, '00-Inbox/Custom.md', { status: 'on hold' });
  const stale = await source(plugin, file);
  file.content = file.content.replace('on hold', 'waiting for approval');
  await assert.rejects(plugin.updateReportStatus({ kind: 'note', source: stale, status: 'done' }), /status changed/);
  assert.equal(fields(app, file).status, 'waiting for approval');
  const current = await source(plugin, file);
  const process = app.fileManager.processFrontMatter;
  app.fileManager.processFrontMatter = async (target, update) => {
    target.content = target.content.replace('waiting for approval', 'changed just before writing');
    await process(target, update);
  };
  await assert.rejects(plugin.updateReportStatus({ kind: 'note', source: current, status: 'done' }), /status changed/);
  assert.equal(fields(app, file).status, 'changed just before writing');
});

test('new canonical sources invalidate an old entity edit before any source is changed', async () => {
  const { app, plugin } = setup();
  const folder = '20-Project/Alpha';
  const primary = note(app, `${folder}/Alpha.md`, { status: 'active' });
  const change = entityChange(await plugin.loadReport(30), folder, 'done');
  const other = note(app, `${folder}/README.md`, { status: 'done' });
  const original = [primary.content, other.content];
  await assert.rejects(plugin.updateReportStatus(change), /status changed/);
  assert.deepEqual([primary.content, other.content], original);
});

test('a partial write failure leaves the report truthful and permits a retry with fresh sources', async () => {
  const { app, plugin } = setup();
  const folder = '20-Project/Alpha';
  note(app, `${folder}/Alpha.md`, { status: 'active' });
  note(app, `${folder}/README.md`, { status: 'active' });
  const original = app.fileManager.processFrontMatter;
  let writes = 0;
  app.fileManager.processFrontMatter = async (file, change) => {
    if (++writes === 2) throw new Error('Simulated second write failure');
    await original(file, change);
  };
  let notifications = 0;
  plugin.subscribe(() => { notifications++; });
  await assert.rejects(plugin.updateReportStatus(entityChange(await plugin.loadReport(30), folder, 'done')), /second write failure/);
  assert.equal((await plugin.loadReport(30)).data.projects[0]!.status, 'unknown');
  assert.ok(notifications > 0);
  app.fileManager.processFrontMatter = original;
  await plugin.updateReportStatus(entityChange(await plugin.loadReport(30), folder, 'done'));
  assert.equal((await plugin.loadReport(30)).data.projects[0]!.status, 'done');
});

test('task edits support progress, completion, reopening and cancellation with refreshed counts', async () => {
  const { app, plugin } = setup();
  const file = note(app, '00-Inbox/Tasks.md', {}, '- [ ] Call lawyer\n');
  for (const status of ['/', 'x', ' ', '-'] as const) {
    const task = (await plugin.loadReport(30)).data.taskItems[0]!;
    await plugin.updateReportStatus({ kind: 'task', task, status });
    const after = await plugin.loadReport(30);
    assert.equal(after.data.taskItems[0]!.status, status);
    assert.equal(after.data.counts.openTasks, status === ' ' || status === '/' ? 1 : 0);
    assert.equal(after.data.counts.completedTasks, status === 'x' ? 1 : 0);
    assert.equal(after.data.counts.cancelledTasks, status === '-' ? 1 : 0);
    assert.ok(file.content.endsWith(`- [${status}] Call lawyer\n`));
  }
});

test('task edits reject stale labels and markers while preserving quoted tasks and CRLF', () => {
  const task: ReportTask = { path: 'Tasks.md', name: 'Tasks', line: 1, text: '**Call** [lawyer](Contact.md)  ', status: '/' };
  const content = '# Tasks\r\n> 1. [/] **Call** [lawyer](Contact.md)  \r\n- [ ] Another\r\n';
  assert.equal(harness.changeReportTaskStatus(content, task, 'x'), content.replace('[/]', '[x]'));
  for (const stale of [{ ...task, text: '**Call**' }, { ...task, status: ' ' }, { ...task, line: -1 }, { ...task, line: 1.5 }]) {
    assert.throws(() => harness.changeReportTaskStatus(content, stale, '-'), /task changed/);
  }
  assert.throws(() => harness.changeReportTaskStatus(content, task, '?' as ReportTaskStatus), /valid task status/);
});

test('excluded records, archived tasks and non-entity folders cannot be edited', async () => {
  const { app, plugin } = setup();
  const file = note(app, '00-Inbox/Excluded.md', { status: 'active' });
  const request = { kind: 'note' as const, source: await source(plugin, file), status: 'done' as const };
  plugin.settings.reportExcludedFolders = [file.path];
  await assert.rejects(plugin.updateReportStatus(request), /excluded/);
  const archived = note(app, '90-Archive/Tasks.md', {}, '- [ ] Old task\n');
  await assert.rejects(plugin.updateReportStatus({ kind: 'task', task: { path: archived.path, name: archived.basename, line: 4, text: 'Old task', status: ' ' }, status: 'x' }), /excluded/);
  app.vault.seedFolder('20-Project/Parent/Child');
  await assert.rejects(plugin.updateReportStatus({ kind: 'entity', collection: 'projects', path: '20-Project/Parent/Child', sources: [], status: 'done' }), /existing project or area/);
  assert.deepEqual(app.vault.processedPaths, []);
});

class ElementDocument {
  readonly body = new Element('body', this);
  activeElement = this.body;
  createElementNS(_namespace: string, tag: string): Element { return new Element(tag, this); }
}

class Element extends EventTarget {
  children: Element[] = [];
  textContent = '';
  value = '';
  type = '';
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  scrollTop = 0;
  disabled = false;
  checked = false;
  open = false;
  style = { setProperty(name: string, value: string): void { Object.assign(this, { [name]: value }); } };
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  constructor(readonly tag = 'div', readonly ownerDocument = new ElementDocument()) { super(); }
  get tagName(): string { return this.tag.toUpperCase(); }
  get isConnected(): boolean { return this.ownerDocument.body.contains(this); }
  createEl(tag: string, options: { text?: string; value?: string; type?: string; cls?: string; attr?: Record<string, string> } = {}): Element {
    const child = new Element(tag, this.ownerDocument);
    child.textContent = options.text ?? '';
    child.value = options.value ?? '';
    child.type = options.type ?? '';
    for (const [key, value] of Object.entries(options.attr ?? {})) child.setAttribute(key, value);
    if (options.cls) child.attributes.set('class', options.cls);
    this.appendChild(child);
    return child;
  }
  createDiv(options = {}): Element { return this.createEl('div', options); }
  createSpan(options = {}): Element { return this.createEl('span', options); }
  appendChild(child: Element): void { this.children.push(child); }
  contains(element: Element | null): boolean { return this === element || this.children.some((child) => child.contains(element)); }
  empty(): void {
    if (this.children.some((child) => child.contains(this.ownerDocument.activeElement))) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.children = [];
    this.textContent = '';
  }
  focus(): void { if (!this.disabled) this.ownerDocument.activeElement = this; }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView(): void {}
  setText(text: string): void { this.textContent = text; }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  setAttribute(key: string, value: string): void {
    this.attributes.set(key, value);
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  addClass(name: string): void { this.attributes.set('class', `${this.attributes.get('class') ?? ''} ${name}`.trim()); }
  toggleClass(name: string, enabled: boolean): void {
    const classes = new Set((this.attributes.get('class') ?? '').split(/\s+/).filter(Boolean));
    if (enabled) classes.add(name);
    else classes.delete(name);
    this.attributes.set('class', [...classes].join(' '));
  }
  private matches(selector: string): boolean {
    const data = /^\[data-([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (data) {
      const key = data[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return data[2] === undefined ? key in this.dataset : this.dataset[key] === data[2];
    }
    return this.tag === selector;
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
function statusSelect(root: Element): Element { return root.querySelectorAll('select').find((select) => select.dataset.reportFocus?.startsWith('status-'))!; }

test('entity status controls serialize changes, show unknown as a placeholder and refresh after failures', async () => {
  const { app, plugin } = setup();
  app.vault.seedFolder('20-Project/Empty');
  const snapshot = await plugin.loadReport(30);
  const view = new harness.TangrowReport({}, plugin);
  let root = new Element();
  let reject!: (error: Error) => void;
  const changes: ReportStatusChange[] = [];
  plugin.updateReportStatus = (change) => { changes.push(change); return new Promise((_, fail) => { reject = fail; }); };
  Object.assign(view, { snapshot, mounted: true, page: 'projects', refresh: async () => {
    root = new Element();
    view.renderEntities(root, snapshot.data.projects, 'projects');
  } });
  view.renderEntities(root, snapshot.data.projects, 'projects');
  const select = statusSelect(root);
  assert.equal(select.value, 'unknown');
  assert.equal(select.children.find((option) => option.value === 'unknown')!.disabled, true);
  select.value = 'done';
  select.dispatchEvent(new Event('change'));
  select.dispatchEvent(new Event('change'));
  await flush();
  assert.equal(select.disabled, true);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0], { kind: 'entity', collection: 'projects', path: '20-Project/Empty', sources: [], status: 'done' });
  const remount = new Element();
  view.renderEntities(remount, snapshot.data.projects, 'projects');
  assert.equal(statusSelect(remount).disabled, true);
  reject(new Error('Save failed'));
  await flush();
  assert.equal(statusSelect(root).disabled, false);
  assert.equal(statusSelect(root).value, 'unknown');
  assert.equal(harness.notices.at(-1), 'Save failed');
});

test('root entity, clip and ordinary note controls use the same source-note status edit', async () => {
  const { app, plugin } = setup();
  const file = note(app, '20-Project/Standalone.md', { source: 'https://example.com', status: 'active' });
  const snapshot = await plugin.loadReport(30);
  const view = new harness.TangrowReport({}, plugin);
  Object.assign(view, { snapshot, mounted: true, refresh: async () => undefined });
  const changes: ReportStatusChange[] = [];
  plugin.updateReportStatus = async (change) => { changes.push(change); };
  for (const render of [
    (root: Element) => view.renderEntities(root, snapshot.data.projects, 'projects'),
    (root: Element) => view.renderClips(root, snapshot.data),
    (root: Element) => view.noteStatus(root, snapshot.data.notes[0]!)
  ]) {
    const root = new Element();
    render(root);
    const select = statusSelect(root);
    select.value = 'done';
    select.dispatchEvent(new Event('change'));
    await flush();
    assert.deepEqual(changes.at(-1), { kind: 'note', source: await source(plugin, file), status: 'done' });
  }
});

test('task status controls normalize uppercase completion for display while retaining the original guard', async () => {
  const { app, plugin } = setup();
  note(app, '00-Inbox/Tasks.md', {}, '- [X] Finished\n');
  const snapshot = await plugin.loadReport(30);
  const view = new harness.TangrowReport({}, plugin);
  Object.assign(view, { snapshot, mounted: true, page: 'tasks', refresh: async () => undefined });
  const changes: ReportStatusChange[] = [];
  plugin.updateReportStatus = async (change) => { changes.push(change); };
  const root = new Element();
  view.renderTasks(root, snapshot.data);
  const select = statusSelect(root);
  assert.equal(select.value, 'x');
  assert.deepEqual(select.children.map((option) => option.value), [' ', '/', 'x', '-']);
  select.value = '-';
  select.dispatchEvent(new Event('change'));
  await flush();
  assert.deepEqual(changes[0], { kind: 'task', task: snapshot.data.taskItems[0], status: '-' });
});

test('resource updates are relative to the report snapshot while empty folders keep unknown dates', async () => {
  const { app, plugin } = setup();
  const now = Date.now();
  note(app, '40-Resources/Recent.md').stat.mtime = now - 2 * 86_400_000;
  note(app, '40-Resources/Topic/Notes.md').stat.mtime = now - 65 * 86_400_000;
  app.vault.seedFolder('40-Resources/Empty');
  const snapshot = await plugin.loadReport(30);
  snapshot.generatedAt = now;
  const view = new harness.TangrowReport({}, plugin);
  Object.assign(view, { snapshot, mounted: true, page: 'resources' });
  const root = new Element();
  view.renderResources(root, snapshot.data);
  const rows = new Map(root.querySelectorAll('tbody')[0]!.children.map((row) => {
    const cells = row.children.map((cell) => cell.textContent + cell.querySelectorAll('span').map((span) => span.textContent).join(''));
    return [cells[0], cells];
  }));
  assert.equal(rows.get('Recent.md')?.[2], '2 days ago');
  assert.equal(rows.get('Topic')?.[2], '2 months ago');
  assert.deepEqual(rows.get('Empty')?.slice(1, 4), ['0', 'Unknown', 'Unknown']);
  const emptyLink = root.querySelectorAll('button').find((button) => button.dataset.reportFocus === 'resource-40-Resources/Empty');
  assert.equal(emptyLink?.disabled, true);
});

test('a late today load cannot replace overview data and each page restores its own range', async () => {
  const { plugin } = setup();
  const month = await plugin.loadReport(30);
  const today = await plugin.loadReport(1);
  const requests = deferReportLoads(plugin);
  const view = mountReport(plugin, month);

  view.selectPage('time');
  await chooseRange(view, 1);
  assert.equal(requests[0]!.range, 1);

  view.selectPage('overview');
  assert.equal(requests[1]!.range, 30);
  requests[0]!.resolve(today);
  await flush();
  assert.equal(view.snapshot, month);
  assert.equal(view.snapshot.data.trends.length, 30);
  assert.equal(view.range, 30);
  assert.equal(view.loading, true);
  requests[1]!.resolve(month);
  await flush();
  assert.equal(view.loading, false);

  view.selectPage('time');
  assert.equal(requests[2]!.range, 1);
  requests[2]!.resolve(today);
  await flush();
  assert.equal(view.snapshot.data.trends.length, 1);
  assert.equal(view.snapshotRange, 1);

  view.selectPage('overview');
  assert.equal(requests[3]!.range, 30);
  requests[3]!.resolve(month);
  await flush();
  assert.equal(view.snapshot.data.trends.length, 30);
  assert.equal(view.snapshotRange, 30);
  assert.equal(view.contentEl.querySelector('[data-report-focus="range-30"]')!.attributes.get('aria-pressed'), 'true');
});

function deferReportLoads(plugin: ReportPlugin) {
  const requests: Array<{ range: ReportRange; resolve(snapshot: ReportSnapshot): void; reject(error: Error): void }> = [];
  plugin.loadReport = (range) => {
    const { promise, resolve, reject } = Promise.withResolvers<ReportSnapshot>();
    requests.push({ range, resolve, reject });
    return promise;
  };
  return requests;
}

function mountReport(plugin: ReportPlugin, snapshot: ReportSnapshot, page: ReportPage = 'overview'): RangeReportView {
  const view = new harness.TangrowReport({}, plugin) as RangeReportView;
  const doc = new ElementDocument();
  Object.assign(view, { snapshot, snapshotRange: 30, mounted: true, page, contentEl: doc.body.createDiv() });
  view.render();
  return view;
}

async function chooseRange(view: RangeReportView, range: ReportRange): Promise<void> {
  const button = view.contentEl.querySelector(`[data-report-focus="range-${range}"]`);
  assert.ok(button, `Range ${range} must remain available`);
  button.focus();
  button.dispatchEvent(new Event('click'));
  await flush();
}

async function clickReportControl(view: RangeReportView, focus: string): Promise<void> {
  const button = view.contentEl.querySelector(`[data-report-focus="${focus}"]`);
  assert.ok(button, `Missing report control ${focus}`);
  button.dispatchEvent(new Event('click'));
  await flush();
}

test('overview daily and 90-day drill-downs use the dates and roles behind each count', async () => {
  const { app, plugin } = setup();
  const dates = recentDays(110);
  const yesterday = dates.at(-2)!;
  const newFile = note(app, 'Recent.md', {}, '- [ ] Recent task\n');
  newFile.stat.ctime = new Date(`${yesterday}T12:00:00`).getTime();
  const capture = note(app, 'Capture.md', { tangrow_kind: 'capture', created: yesterday });
  capture.stat.ctime = new Date(`${dates[0]}T12:00:00`).getTime();
  const journal = note(app, 'Retrospective.md', { journal: 'Daily', 'journal-date': yesterday });
  journal.stat.ctime = capture.stat.ctime;
  const lastSeason = note(app, 'Last season.md', {}, '- [ ] Earlier task\n');
  lastSeason.stat.ctime = new Date(`${dates.at(-40)}T12:00:00`).getTime();
  const view = mountReport(plugin, await plugin.loadReport(30));
  await chooseRange(view, 7);
  const overviewHeadings = view.contentEl.querySelectorAll('h2').map((heading) => heading.textContent);
  for (const title of ['Creation trends', 'Notes and actions', 'Records and time', 'Review and discovery', 'Card notes']) assert.ok(overviewHeadings.includes(title));

  const daily = view.contentEl.querySelector('details')!;
  daily.open = true;
  daily.dispatchEvent(new Event('toggle'));
  await clickReportControl(view, `trend-captures-${yesterday}`);
  assert.equal(view.contentEl.querySelector('[data-report-focus="role"]')?.value, 'captures');
  assert.ok(view.contentEl.querySelector('[data-report-focus="note-Capture.md"]'));
  assert.equal(view.contentEl.querySelector('[data-report-focus="note-Recent.md"]'), null);

  view.navigate({ page: 'overview' });
  assert.equal(view.contentEl.querySelector('details')?.open, true);
  await clickReportControl(view, `trend-tasks-${yesterday}`);
  const tasks = view.contentEl.querySelectorAll('button').filter((button) => button.dataset.reportFocus?.startsWith('task-'));
  assert.deepEqual(tasks.map((task) => task.attributes.get('aria-label')), ['Recent task']);

  view.navigate({ page: 'overview' });
  await clickReportControl(view, 'gain-notes-');
  assert.ok(view.contentEl.querySelector('[data-report-focus="note-Last season.md"]'));
  assert.equal(view.contentEl.querySelector('[data-report-focus="note-Capture.md"]'), null);

  view.navigate({ page: 'overview' });
  await clickReportControl(view, `history-journals-${yesterday}`);
  assert.equal(view.contentEl.querySelector('[data-report-focus="role"]')?.value, 'journals');
  assert.ok(view.contentEl.querySelector('[data-report-focus="note-Retrospective.md"]'));
  assert.equal(view.contentEl.querySelector('[data-report-focus="note-Recent.md"]'), null);
  view.navigate({ page: 'overview' });
  await clickReportControl(view, `history-captures-${yesterday}`);
  assert.ok(view.contentEl.querySelector('[data-report-focus="note-Capture.md"]'));
  assert.equal(view.contentEl.querySelector('[data-report-focus="note-Retrospective.md"]'), null);
});

test('card destinations and the generic report open independently while card availability changes', async () => {
  const { app, plugin } = setup();
  note(app, 'Card.md', { tangrow_kind: 'card' });
  const snapshot = await plugin.loadReport(30);
  snapshot.quality.linksReady = false;
  snapshot.cards!.linksReady = false;
  const view = mountReport(plugin, snapshot);
  assert.equal(view.contentEl.querySelector('[data-report-focus="count-Orphan notes"]'), null);
  assert.equal(view.contentEl.querySelector('[data-report-focus="control-Open a random orphan"]')?.disabled, true);
  assert.ok(view.contentEl.querySelector('[data-report-focus="count-Notes total"]'));
  view.navigate({ page: 'cards', filter: 'week' });
  assert.equal(view.contentEl.querySelector('[data-report-focus="note-tab-cards"]')?.attributes.get('aria-selected'), 'true');
  assert.equal(view.contentEl.querySelector('[data-report-focus="card-filter"]')?.value, 'week');
  view.navigate({ page: 'overview' });
  assert.equal(view.contentEl.querySelector('[data-page="overview"]')?.attributes.get('aria-selected'), 'true');

  view.navigate({ page: 'cards' });
  plugin.settings.knowledgeEnabled = false;
  view.render();
  assert.equal(view.contentEl.querySelector('[data-page="overview"]')?.attributes.get('aria-selected'), 'true');
  assert.ok(view.contentEl.querySelector('[data-report-focus="count-Manuscripts"]'));
  assert.equal(view.contentEl.querySelectorAll('h2').some((heading) => heading.textContent === 'Card notes'), false);
  view.navigate({ page: 'cards' });
  assert.equal(view.contentEl.querySelector('[data-page="overview"]')?.attributes.get('aria-selected'), 'true');
});

test('returning to card trends preserves focus across the range load and zero groups open their own empty list', async () => {
  const { plugin } = setup();
  const month = await plugin.loadReport(30);
  const view = mountReport(plugin, month, 'time');
  await chooseRange(view, 1);
  const requests = deferReportLoads(plugin);
  view.navigate({ page: 'cards' });
  const openTrend = view.contentEl.querySelectorAll('button').find((button) => button.getAttribute('aria-label') === 'View card creation trend');
  assert.ok(openTrend);
  openTrend.dispatchEvent(new Event('click'));
  await flush();
  assert.deepEqual(requests.map(({ range }) => range), [30]);
  assert.ok(view.contentEl.querySelector('[data-report-focus="count-Notes total"]'));
  const active = (): Element => view.contentEl.ownerDocument.activeElement;
  assert.equal(active().dataset.reportFocus, 'card-overview-trend');
  requests[0]!.resolve(month);
  await flush();
  assert.equal(active().dataset.reportFocus, 'card-overview-trend');

  const zero = view.contentEl.querySelectorAll('button').find((button) => button.getAttribute('class')?.includes('tangrow-card-trend-bin') && button.getAttribute('aria-label')?.endsWith('0 cards'));
  assert.ok(zero && !zero.disabled);
  zero.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(view.contentEl.querySelector('[data-report-focus="card-filter"]')?.value, 'period');
  assert.equal(view.contentEl.querySelectorAll('p').find((element) => element.getAttribute('role') === 'status')?.textContent, '0 cards');
});

test('material filters, page, and search focus survive report refreshes and IME composition', async () => {
  const { app, plugin } = setup();
  const query = '\u8d44\u6599';
  const matches = Array.from({ length: 21 }, (_, index) => `${query} ${String(index).padStart(2, '0')}`);
  const materials = new Map([...matches, 'Other', `${query} Uncovered`].map((name) => {
    const file = note(app, `40-Resources/${name}.md`);
    return [file.path, file];
  }));
  app.metadataCache.getFirstLinkpathDest = (link) => materials.get(link) ?? null;
  Object.assign(app.metadataCache, { resolvedLinks: {} });
  note(app, 'Card.md', { tangrow_kind: 'card', tangrow_sources: [...matches, 'Other'].map((name) => `[[40-Resources/${name}.md]]`) });
  const view = mountReport(plugin, await plugin.loadReport(30), 'resources');
  await clickReportControl(view, 'resource-tab-materials');
  await clickReportControl(view, 'material-coverage');
  const search = () => view.contentEl.querySelector('[data-report-focus="material-search"]')!;
  const hasButton = (label: string) => view.contentEl.querySelectorAll('button').some((button) => button.getAttribute('aria-label') === label);
  const input = search();
  input.focus();
  input.dispatchEvent(new Event('compositionstart'));
  input.value = 'zi';
  input.dispatchEvent(new Event('input'));
  await view.refresh();
  assert.equal(search(), input);
  assert.ok(hasButton('Other'));

  input.value = query;
  input.dispatchEvent(new Event('compositionend'));
  assert.equal(hasButton('Other'), false);
  const next = view.contentEl.querySelectorAll('button').find((button) => button.getAttribute('aria-label') === 'Next page')!;
  next.dispatchEvent(new Event('click'));
  await flush();
  assert.ok(hasButton(matches[20]!));
  assert.equal(hasButton(`${query} Uncovered`), false);

  search().focus();
  search().setSelectionRange(1, 2);
  await view.refresh();
  assert.equal(search().value, query);
  assert.equal(view.contentEl.ownerDocument.activeElement, search());
  assert.deepEqual([search().selectionStart, search().selectionEnd], [1, 2]);
  assert.equal(view.contentEl.querySelector('[data-report-focus="material-coverage"]')?.getAttribute('aria-pressed'), 'true');
  assert.ok(hasButton(matches[20]!));
  assert.equal(hasButton(matches[0]!), false);
  assert.equal(hasButton(`${query} Uncovered`), false);
});

test('manuscript stage stays selected across report refreshes', async () => {
  const { app, plugin } = setup();
  note(app, 'Manuscript.md', { tangrow_kind: 'draft', tangrow_writing_stage: 'drafting' });
  note(app, 'Later.md', { tangrow_kind: 'draft', tangrow_writing_stage: 'outline' });
  const view = mountReport(plugin, await plugin.loadReport(30), 'notes');
  await clickReportControl(view, 'note-tab-drafts');
  const stage = () => view.contentEl.querySelector('[data-report-focus="draft-stage"]')!;
  stage().value = 'drafting';
  stage().dispatchEvent(new Event('change'));
  await view.refresh();
  assert.equal(stage().value, 'drafting');
  const names = view.contentEl.querySelectorAll('button').map((button) => button.getAttribute('aria-label'));
  assert.ok(names.includes('Manuscript'));
  assert.equal(names.includes('Later'), false);

  view.navigate({ page: 'overview' });
  await clickReportControl(view, 'count-Manuscripts');
  assert.equal(stage().value, '');
  assert.ok(view.contentEl.querySelectorAll('button').some((button) => button.getAttribute('aria-label') === 'Later'));
});

test('today habit check-ins can be recorded from the overview count', async () => {
  const { plugin } = setup();
  plugin.settings.habits = [{ id: 'read', name: 'Read' }];
  const view = mountReport(plugin, await plugin.loadReport(30));
  await clickReportControl(view, 'count-Habit check-ins today');
  assert.equal(view.contentEl.querySelector('[data-page="actions"]')?.attributes.get('aria-selected'), 'true');
  const check = view.contentEl.querySelector('[data-report-focus="habit-read"]')!;
  assert.equal(check.checked, false);
  check.checked = true;
  check.dispatchEvent(new Event('change'));
  await flush();
  assert.equal(view.snapshot.data.habits.todayCompleted, 1);
  assert.equal(view.contentEl.querySelector('[data-report-focus="habit-read"]')?.disabled, true);
});

test('returning to a cached range restarts an interrupted refresh and includes new notes', async () => {
  const { app, plugin } = setup();
  const original = await plugin.loadReport(30);
  const oldToday = await plugin.loadReport(1);
  const view = mountReport(plugin, original, 'time');
  note(app, '40-Resources/New.md');
  const updatedToday = await plugin.loadReport(1);
  const updatedMonth = await plugin.loadReport(30);
  const requests = deferReportLoads(plugin);

  await chooseRange(view, 1);
  const updating = view.refresh();
  view.selectPage('overview');
  assert.deepEqual(requests.map(({ range }) => range), [1, 1, 30]);

  requests[1]!.resolve(updatedToday);
  await updating;
  assert.equal(view.snapshot, original);
  assert.equal(view.loading, true);

  requests[2]!.resolve(updatedMonth);
  await flush();
  requests[0]!.resolve(oldToday);
  await flush();
  assert.equal(view.snapshot, updatedMonth);
  assert.equal(view.snapshot.data.counts.notes, 1);
  assert.equal(view.snapshotRange, 30);
  assert.equal(view.loading, false);

  view.selectPage('tasks');
  view.selectPage('overview');
  assert.equal(requests.length, 3);
});

for (const page of ['overview', 'time'] as const) {
  test(`${page} range controls retain focus during loading and after success or failure`, async () => {
    const { plugin } = setup();
    const month = await plugin.loadReport(30);
    const range = page === 'time' ? 1 : 7;
    const updated = await plugin.loadReport(range);
    const view = mountReport(plugin, month, page);
    const requests = deferReportLoads(plugin);
    const assertFocus = (expectedRange: ReportRange): void => {
      const active = view.contentEl.ownerDocument.activeElement;
      assert.ok(view.contentEl.contains(active));
      assert.equal(active.dataset.reportFocus, `range-${expectedRange}`);
      assert.equal(active.attributes.get('aria-pressed'), 'true');
    };

    await chooseRange(view, range);
    assert.equal(view.loading, true);
    assertFocus(range);
    assert.equal(view.contentEl.querySelector('svg'), null);
    requests[0]!.resolve(updated);
    await flush();
    assert.equal(view.loading, false);
    assertFocus(range);

    await chooseRange(view, 90);
    assertFocus(90);
    requests[1]!.reject(new Error('Refresh failed'));
    await flush();
    assert.equal(view.loading, false);
    assertFocus(90);
    assert.ok(view.contentEl.querySelector('[data-report-focus="control-Retry report"]'));

    await chooseRange(view, 30);
    requests[2]!.resolve(month);
    await flush();
    assert.equal(view.snapshotRange, 30);
    assertFocus(30);
  });
}

test('completing a range refresh does not steal focus from another control', async () => {
  const { plugin } = setup();
  const month = await plugin.loadReport(30);
  const week = await plugin.loadReport(7);
  const view = mountReport(plugin, month);
  const requests = deferReportLoads(plugin);
  await chooseRange(view, 7);
  const doc = view.contentEl.ownerDocument;
  const outside = doc.body.createEl('button');
  outside.focus();
  requests[0]!.resolve(week);
  await flush();
  assert.equal(view.snapshotRange, 7);
  assert.equal(doc.activeElement, outside);
});
