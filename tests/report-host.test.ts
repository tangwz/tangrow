import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { EditingActivityState } from '../src/activity';
import type { CardFilter } from '../src/card-report-data';
import type { CardReviewQueue } from '../src/card-review';
import { dayKey } from '../src/model';
import type { ReportDestination, ReportPreferences, ReportRange, ReportSnapshot } from '../src/report-contract';
import type { CardSource, Settings } from '../src/types';
import type { MarkdownView, MockApp, Plugin as MockPlugin, createMockApp as AppFactory } from './obsidian-mock';

interface ReportPlugin extends MockPlugin {
  settings: Settings;
  writes: Promise<void>;
  onload(): Promise<void>;
  onunload(): void;
  loadReport(range: ReportRange): Promise<ReportSnapshot>;
  updateReportSettings(patch: Partial<ReportPreferences>): Promise<void>;
  loadCardReview(day: string): CardReviewQueue | null;
  saveCardReview(queue: CardReviewQueue, rebuild?: boolean): Promise<CardReviewQueue>;
  markCardReviewed(path: string, day: string, entryPath: string): Promise<void>;
  addWritingMaterial(draftPath: string, sourcePath: string): Promise<void>;
  openReport(): Promise<void>;
  openCardReport(filter?: CardFilter): Promise<void>;
  updateKnowledgeEnabled(enabled: boolean): Promise<void>;
  createCard(title: string, body: string, source?: CardSource): Promise<void>;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  absWorkingDir: repository,
  stdin: { contents: "export {default as TangrowPlugin} from './src/main'; export { TangrowReport } from './src/report'; export * from './tests/obsidian-mock';", resolveDir: repository, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22',
  plugins: [{ name: 'mock-obsidian', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundled.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as {
  TangrowPlugin: new (app: MockApp) => ReportPlugin;
  TangrowReport: new (leaf: unknown, host: ReportPlugin) => { navigate(destination: ReportDestination): void };
  createMockApp: typeof AppFactory;
  MarkdownView: new () => MarkdownView;
};

async function withEnvironment(run: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  const originalWindow = globalThis.window;
  const originalNow = Date.now;
  let now = new Date(2026, 10, 9, 12).getTime();
  let timerId = 0;
  const timers = new Map<number, () => void>();
  Date.now = () => now;
  globalThis.window = {
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: () => ++timerId,
    clearInterval: () => undefined
  } as unknown as Window & typeof globalThis;
  try { await run((ms) => { now += ms; }); }
  finally {
    Date.now = originalNow;
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else globalThis.window = originalWindow;
  }
}

test('report preference validation and failed persistence never change notes or folder settings', async () => {
  await withEnvironment(async () => {
    const app = harness.createMockApp();
    const note = app.vault.seedFile('20-Project/Existing/Existing.md', '# Existing project\n');
    const plugin = new harness.TangrowPlugin(app);
    await plugin.onload();
    const original = structuredClone(plugin.settings);
    for (const patch of [
      { activityGoalMinutes: 0 }, { activityGoalMinutes: 1441 }, { activityGoalMinutes: 3.5 },
      { reportExcludedFolders: ['../Outside'] }, { reportExcludedFolders: ['/absolute'] }
    ]) await assert.rejects(plugin.updateReportSettings(patch));
    assert.deepEqual(plugin.settings, original);
    plugin.saveFailures = 1;
    await assert.rejects(plugin.updateReportSettings({ reportExcludedFolders: ['20-Project'], activityGoalMinutes: 45, trackEditingActivity: false }));
    assert.deepEqual(plugin.settings, original);
    await plugin.updateReportSettings({ reportExcludedFolders: ['20-Project', '20-Project'], activityGoalMinutes: 45 });
    assert.deepEqual(plugin.settings.reportExcludedFolders, ['20-Project']);
    assert.equal(plugin.settings.activityGoalMinutes, 45);
    assert.equal(plugin.settings.projectFolder, original.projectFolder);
    assert.equal(note.content, '# Existing project\n');
    assert.deepEqual(app.vault.createdPaths, []);
    assert.deepEqual(app.vault.processedPaths, []);
    plugin.onunload();
    await plugin.writes;
  });
});

test('general report entry always restores overview while an explicit card entry carries its filter', async () => {
  await withEnvironment(async () => {
    const app = harness.createMockApp();
    const plugin = new harness.TangrowPlugin(app);
    const destinations: ReportDestination[] = [];
    const view = new harness.TangrowReport({}, plugin);
    view.navigate = (destination) => destinations.push(destination);
    const leaf = { view };
    const reveals: unknown[] = [];
    Object.assign(app.workspace, { getLeavesOfType: () => [leaf], revealLeaf: async (target: unknown) => { reveals.push(target); } });
    await plugin.openCardReport('candidate');
    await plugin.openReport();
    await plugin.updateKnowledgeEnabled(false);
    await plugin.openCardReport('isolated');
    assert.deepEqual(destinations, [{ page: 'cards', filter: 'candidate' }, { page: 'overview' }, { page: 'overview' }]);
    assert.deepEqual(reveals, [leaf, leaf, leaf]);
  });
});

test('card review retries persist progress without changing the first explicit review timestamp', async () => {
  await withEnvironment(async (advance) => {
    const app = harness.createMockApp();
    const file = app.vault.seedFile('50-Zettel/Viewpoint.md', '---\ntangrow_kind: card\ntangrow_id: stable\n---\n\n# Viewpoint\n');
    const plugin = new harness.TangrowPlugin(app);
    const day = dayKey();
    const established = { day, entries: [{ path: file.path, id: 'stable', reason: 'sample' as const }], completed: [] };
    await plugin.saveCardReview(established);
    assert.deepEqual(await plugin.saveCardReview({ ...established, entries: [] }), established);
    plugin.saveFailures = 1;
    await assert.rejects(plugin.markCardReviewed(file.path, day, file.path));
    assert.deepEqual(plugin.loadCardReview(day)?.completed, []);
    const firstReview = app.metadataCache.getFileCache(file).frontmatter?.tangrow_reviewed_at;
    assert.equal(firstReview, new Date(Date.now()).toISOString());
    advance(5000);
    await plugin.markCardReviewed(file.path, day, file.path);
    assert.equal(app.metadataCache.getFileCache(file).frontmatter?.tangrow_reviewed_at, firstReview);
    assert.deepEqual(plugin.loadCardReview(day)?.completed, [file.path]);
    assert.ok(file.content.endsWith('\n# Viewpoint\n'));
  });
});

test('rebuilding a card review preserves a renamed card’s progress and excludes its replacement', async () => {
  await withEnvironment(async () => {
    const app = harness.createMockApp();
    const originalPath = '50-Zettel/Viewpoint.md';
    const renamedPath = '50-Zettel/Renamed.md';
    const card = app.vault.seedFile(originalPath, '---\ntangrow_kind: card\ntangrow_id: original\n---\n\n# Viewpoint\n');
    const plugin = new harness.TangrowPlugin(app);
    const day = dayKey();
    await plugin.saveCardReview({ day, entries: [{ path: originalPath, id: 'original', reason: 'sample' }], completed: [] });
    await plugin.markCardReviewed(originalPath, day, originalPath);
    await app.vault.rename(card, renamedPath);
    const replacement = app.vault.seedFile(originalPath, '---\ntangrow_kind: card\ntangrow_id: replacement\n---\n\n# Replacement\n');

    const rebuilt = await plugin.saveCardReview({ day, entries: [
      { path: originalPath, id: 'replacement', reason: 'sample' },
      { path: renamedPath, id: 'original', reason: 'sample' }
    ], completed: [] }, true);

    assert.deepEqual(rebuilt.completed, [renamedPath]);
    assert.deepEqual(plugin.loadCardReview(day), rebuilt);
    await plugin.markCardReviewed(originalPath, day, originalPath);
    assert.equal(app.metadataCache.getFileCache(replacement).frontmatter?.tangrow_reviewed_at, new Date(Date.now()).toISOString());
  });
});

test('rebuilding a card review keeps legacy path matches and requires an unambiguous ID for moves', async () => {
  await withEnvironment(async () => {
    const plugin = new harness.TangrowPlugin(harness.createMockApp());
    const day = dayKey();
    const legacy = { path: '50-Zettel/Legacy.md', reason: 'sample' as const };
    const original = { path: '50-Zettel/Original.md', id: 'original', reason: 'sample' as const };
    const renamed = { ...original, path: '50-Zettel/Renamed.md' };
    const duplicate = { ...original, path: '50-Zettel/Duplicate.md' };
    await plugin.saveCardReview({ day, entries: [legacy, original], completed: [legacy.path, original.path] });

    const rebuilt = await plugin.saveCardReview({ day, entries: [legacy, renamed, duplicate], completed: [] }, true);

    assert.deepEqual(rebuilt.completed, [legacy.path]);
  });
});

test('using a card in a manuscript updates only candidate material and deduplicates retries', async () => {
  await withEnvironment(async () => {
    const app = harness.createMockApp();
    const card = app.vault.seedFile('50-Zettel/Viewpoint.md', '---\ntangrow_kind: card\n---\n\n# Viewpoint\n');
    const draft = app.vault.seedFile('00-Inbox/Manuscript.md', '---\ntangrow_kind: draft\ntangrow_materials: "[[Other]]"\n---\n\n# Existing draft\n');
    const plugin = new harness.TangrowPlugin(app);
    const original = card.content;
    await plugin.addWritingMaterial(draft.path, card.path);
    await plugin.addWritingMaterial(draft.path, card.path);
    assert.deepEqual(app.metadataCache.getFileCache(draft).frontmatter?.tangrow_materials, ['[[Other]]', `[[${card.path}]]`]);
    assert.ok(draft.content.endsWith('\n# Existing draft\n'));
    assert.equal(card.content, original);
  });
});

test('creating a card uses a stable identity and only records an explicitly selected source', async () => {
  await withEnvironment(async () => {
    const app = harness.createMockApp();
    const source = app.vault.seedFile('40-Resources/Reference.md', '# Reference\n\n## Details\n');
    const plugin = new harness.TangrowPlugin(app);
    const create = app.vault.create.bind(app.vault);
    app.vault.create = async (path, content, options) => {
      const saved = await create(path, content, options);
      if (path === '50-Zettel/First idea.md') throw new Error('Failed after write');
      return saved;
    };
    await plugin.createCard('First idea', 'A specific argument.', { path: source.path, anchor: '#Details' });
    await plugin.createCard('Second idea', 'Another argument.');
    const first = app.vault.getMarkdownFiles().find((file) => file.path === '50-Zettel/First idea.md')!;
    const second = app.vault.getMarkdownFiles().find((file) => file.path === '50-Zettel/Second idea.md')!;
    const firstFields = app.metadataCache.getFileCache(first).frontmatter!;
    const secondFields = app.metadataCache.getFileCache(second).frontmatter!;
    assert.equal(firstFields.tangrow_kind, 'card');
    assert.equal(firstFields.tangrow_stage, 'seed');
    assert.ok(typeof firstFields.tangrow_id === 'string' && typeof secondFields.tangrow_id === 'string');
    assert.notEqual(firstFields.tangrow_id, secondFields.tangrow_id);
    assert.deepEqual(firstFields.tangrow_sources, [`[[${source.path}#Details]]`]);
    assert.equal(secondFields.tangrow_sources, undefined);
    assert.equal(source.content, '# Reference\n\n## Details\n');
    await plugin.updateKnowledgeEnabled(false);
    const report = await plugin.loadReport(30);
    assert.equal(report.cards, undefined);
    assert.equal(report.data.counts.notes, 3);
    await assert.rejects(plugin.createCard('Disabled', ''));
    assert.equal(app.vault.getMarkdownFiles().length, 3);
  });
});

test('editing activity counts focused eligible edits and stores only aggregate hour durations', async () => {
  await withEnvironment(async (advance) => {
    const app = harness.createMockApp();
    const file = app.vault.seedFile('00-Inbox/Unmodified.md', '# Private text never stored in activity\n');
    const view = new harness.MarkdownView();
    view.file = file;
    const doc = { hidden: false, hasFocus: () => true, defaultView: window };
    Object.assign(view.containerEl, { ownerDocument: doc });
    app.workspace.setActiveView(view);
    const plugin = new harness.TangrowPlugin(app);
    await plugin.onload();
    const edit = () => app.workspace.trigger('editor-change', view.editor, view);
    edit();
    advance(2000);
    edit();
    assert.equal((await plugin.loadReport(1)).activity.totalMs, 2000);
    doc.hidden = true;
    advance(5000);
    edit();
    doc.hidden = false;
    advance(2000);
    edit();
    assert.equal((await plugin.loadReport(1)).activity.totalMs, 2000);
    advance(3000);
    edit();
    assert.equal((await plugin.loadReport(1)).activity.totalMs, 5000);
    await plugin.updateReportSettings({ reportExcludedFolders: ['00-Inbox'] });
    advance(2000);
    edit();
    assert.equal((await plugin.loadReport(1)).activity.totalMs, 5000);
    await plugin.updateReportSettings({ trackEditingActivity: false });
    advance(2000);
    edit();
    assert.equal((await plugin.loadReport(1)).activity.totalMs, 5000);
    plugin.onunload();
    await plugin.writes;
    const stored = plugin.savedData as { version: number; activity: EditingActivityState };
    assert.equal(stored.version, 5);
    assert.deepEqual(Object.keys(stored.activity).sort(), ['buckets', 'startedAt', 'version']);
    assert.ok(stored.activity.buckets.every((bucket) => Object.keys(bucket).sort().join(',') === 'ms,start'));
    assert.ok(!JSON.stringify(stored.activity).includes(file.path));
    const reloaded = new harness.TangrowPlugin(app);
    reloaded.savedData = structuredClone(plugin.savedData);
    await reloaded.onload();
    assert.equal((await reloaded.loadReport(1)).activity.totalMs, 5000);
    assert.equal(file.content, '# Private text never stored in activity\n');
    assert.deepEqual(app.vault.createdPaths, []);
    assert.deepEqual(app.vault.processedPaths, []);
    reloaded.onunload();
    await reloaded.writes;
  });
});
