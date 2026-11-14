import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { EditingActivityState } from '../src/activity';
import type { ReportPreferences, ReportRange, ReportSnapshot } from '../src/report-contract';
import type { Settings } from '../src/types';
import type { MarkdownView, MockApp, Plugin as MockPlugin, createMockApp as AppFactory } from './obsidian-mock';

interface ReportPlugin extends MockPlugin {
  settings: Settings;
  writes: Promise<void>;
  onload(): Promise<void>;
  onunload(): void;
  loadReport(range: ReportRange): Promise<ReportSnapshot>;
  updateReportSettings(patch: Partial<ReportPreferences>): Promise<void>;
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  absWorkingDir: repository,
  stdin: { contents: "export {default as TangrowPlugin} from './src/main'; export * from './tests/obsidian-mock';", resolveDir: repository, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node22',
  plugins: [{ name: 'mock-obsidian', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundled.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as {
  TangrowPlugin: new (app: MockApp) => ReportPlugin;
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
