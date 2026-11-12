import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { canonicalEntityNotes, reportStatusSource } from '../src/report-metrics';
import type { ReportData, ReportEntity, ReportRecord, ReportSnapshot, ReportStatusChange, ReportTask, ReportTaskStatus } from '../src/report-contract';
import type { Settings } from '../src/types';
import type { MockApp, TFile as MockFile, createMockApp as AppFactory } from './obsidian-mock';

interface ReportPlugin {
  settings: Settings;
  loadReport(range: 30): Promise<ReportSnapshot>;
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
  noteStatus(parent: Element, note: ReportRecord): void;
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

class Element extends EventTarget {
  children: Element[] = [];
  textContent = '';
  value = '';
  disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  constructor(readonly tag = 'div') { super(); }
  createEl(tag: string, options: { text?: string; value?: string; attr?: Record<string, string> } = {}): Element {
    const child = new Element(tag);
    child.textContent = options.text ?? '';
    child.value = options.value ?? '';
    child.attributes = new Map(Object.entries(options.attr ?? {}));
    this.children.push(child);
    return child;
  }
  createDiv(options = {}): Element { return this.createEl('div', options); }
  createSpan(options = {}): Element { return this.createEl('span', options); }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  querySelectorAll(tag: string): Element[] { return this.children.flatMap((child) => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
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
