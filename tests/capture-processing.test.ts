import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { CaptureRequest, Settings, Snapshot } from '../src/types';
import type { MockApp, Plugin as MockPlugin, TFile as MockFile, createMockApp as MockAppFactory } from './obsidian-mock';

interface TestPlugin extends MockPlugin {
  settings: Settings;
  snapshot(): Snapshot;
  processCapture(path: string, request: CaptureRequest): Promise<string | null>;
}
interface Harness {
  TangrowPlugin: new (app: MockApp) => TestPlugin;
  createMockApp: typeof MockAppFactory;
  parseYaml(content: string): Record<string, unknown>;
  getFrontMatterInfo(content: string): { frontmatter: string; contentStart: number };
}
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  absWorkingDir: repository,
  stdin: { contents: "export { default as TangrowPlugin } from './src/main'; export * from './tests/obsidian-mock';", resolveDir: repository, loader: 'ts' },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-capture-processing', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as Harness;

function setup() {
  const app = harness.createMockApp();
  const plugin = new harness.TangrowPlugin(app);
  plugin.settings.language = 'en';
  const source = app.vault.seedFile('00-Inbox/Capture.md', '---\ntangrow_kind: "capture"\ntangrow_status: "active"\ncustom: ["preserve", "these"]\n---\n\n# Original thought\r\n\r\nKeep **all** of this text and [[Existing]].\r\n');
  return { app, plugin, source };
}
function fields(file: MockFile): Record<string, unknown> {
  return harness.parseYaml(harness.getFrontMatterInfo(file.content).frontmatter);
}
function body(file: MockFile): string { return file.content.slice(harness.getFrontMatterInfo(file.content).contentStart); }
function notes(app: MockApp): MockFile[] { return app.vault.getMarkdownFiles().filter((file) => fields(file).tangrow_capture_action_id); }

test('turning a capture into a note preserves the source body and unknown properties with two-way links', async () => {
  const { app, plugin, source } = setup();
  const originalBody = body(source);
  assert.equal(plugin.snapshot().captures[0]?.processed, false);
  const destination = await plugin.processCapture(source.path, { action: 'note', title: 'A lasting idea' });
  const result = notes(app)[0]!;
  assert.equal(result.path, '00-Inbox/A lasting idea.md');
  assert.equal(destination, result.path);
  assert.ok(body(result).includes(originalBody.trim()));
  assert.equal(body(source), originalBody);
  assert.deepEqual(fields(source).custom, ['preserve', 'these']);
  assert.equal(fields(source).tangrow_status, 'active');
  assert.equal(fields(result).tangrow_source, `[[${source.path}]]`);
  assert.equal(fields(source).tangrow_capture_result, `[[${result.path}]]`);
  assert.equal(fields(source).tangrow_capture_processing, undefined);
  assert.ok(Number.isFinite(Date.parse(String(fields(source).tangrow_processed_at))));
  assert.equal(plugin.snapshot().captures[0]?.processed, true);
  await plugin.processCapture(source.path, { action: 'note', title: 'A lasting idea' });
  assert.equal(notes(app).length, 1);
});

test('a converted note can use an existing project directory without changing the project or moving the source', async () => {
  const { app, plugin, source } = setup();
  const project = app.vault.seedFile('20-Project/Launch/Launch.md', '# Project content stays.\n');
  await plugin.processCapture(source.path, { action: 'note', title: 'Launch insight', projectPath: project.path });
  const result = notes(app)[0]!;
  assert.equal(result.path, '20-Project/Launch/Launch insight.md');
  assert.equal(fields(result).tangrow_project, `[[${project.path}]]`);
  assert.equal(project.content, '# Project content stays.\n');
  assert.equal(source.path, '00-Inbox/Capture.md');
});

test('project conversion rebases relative Markdown links and images without changing the source body', async () => {
  const { app, plugin, source } = setup();
  const project = app.vault.seedFile('20-Project/Launch/Launch.md', '# Project content stays.\n');
  source.content += '\r\n![sketch](./assets/sketch.png)\r\n[Plan](./Plan.md#Next "The plan")\r\n[Guide](../40-Resources/Guide.md)\r\n[ref]: <./assets/my sketch.png>\r\n';
  const original = body(source);
  await plugin.processCapture(source.path, { action: 'note', title: 'Launch insight', projectPath: project.path });
  const result = notes(app)[0]!;
  assert.match(body(result), /!\[sketch\]\(\.\.\/\.\.\/00-Inbox\/assets\/sketch\.png\)/);
  assert.match(body(result), /\[Plan\]\(\.\.\/\.\.\/00-Inbox\/Plan\.md#Next "The plan"\)/);
  assert.match(body(result), /\[Guide\]\(\.\.\/\.\.\/40-Resources\/Guide\.md\)/);
  assert.match(body(result), /\[ref\]: <\.\.\/\.\.\/00-Inbox\/assets\/my sketch\.png>/);
  assert.equal(body(source), original);
  assert.equal(project.content, '# Project content stays.\n');
});

test('a resumed project conversion rebases the current body only once', async () => {
  const { app, plugin, source } = setup();
  const project = app.vault.seedFile('20-Project/Launch/Launch.md', '# Launch');
  source.content += '\n![sketch](./assets/first.png)\n';
  app.vault.failCreates = 1;
  await assert.rejects(plugin.processCapture(source.path, { action: 'note', title: 'Retry insight', projectPath: project.path }), /write failure/);
  source.content += '\n[Later](./Plan.md#Next)\n';
  const original = body(source);
  await plugin.processCapture(source.path, { action: 'resume' });
  const result = notes(app)[0]!;
  assert.match(body(result), /!\[sketch\]\(\.\.\/\.\.\/00-Inbox\/assets\/first\.png\)/);
  assert.match(body(result), /\[Later\]\(\.\.\/\.\.\/00-Inbox\/Plan\.md#Next\)/);
  assert.equal(body(source), original);
  await plugin.processCapture(source.path, { action: 'resume' });
  assert.equal(notes(app).length, 1);
});

test('project conversion respects Obsidian vault-root and shortest-path resolution', async () => {
  const { app, plugin, source } = setup();
  const project = app.vault.seedFile('20-Project/Launch/Launch.md', '# Launch');
  const root = app.vault.seedFile('40-Resources/Guide.md', '# Guide');
  const near = app.vault.seedFile('00-Inbox/Plan.md', '# Inbox plan');
  const other = app.vault.seedFile('20-Project/Launch/Plan.md', '# Project plan');
  app.metadataCache.getFirstLinkpathDest = (linkpath, sourcePath) => linkpath === root.path ? root
    : linkpath === 'Plan.md' ? sourcePath === source.path ? near : other : null;
  source.content += '\n[Guide](40-Resources/Guide.md)\n[Plan](Plan.md#Next)\n';
  const original = body(source);
  await plugin.processCapture(source.path, { action: 'note', title: 'Linked insight', projectPath: project.path });
  const result = notes(app)[0]!;
  assert.match(body(result), /\[Guide\]\(40-Resources\/Guide\.md\)/);
  assert.match(body(result), /\[Plan\]\(\.\.\/\.\.\/00-Inbox\/Plan\.md#Next\)/);
  assert.equal(body(source), original);
});

test('task conversion appends a single checkbox and source link without rewriting existing queries', async () => {
  const { app, plugin, source } = setup();
  const content = '---\ncustom: "keep"\n---\n\n# Existing tasks\n\n```tasks\nnot done\n```\n';
  const overview = app.vault.seedFile(plugin.settings.taskOverviewPath, content);
  const request: CaptureRequest = { action: 'task', title: 'Follow up on the idea' };
  await Promise.all([plugin.processCapture(source.path, request), plugin.processCapture(source.path, request)]);
  assert.ok(overview.content.startsWith(content));
  assert.equal((overview.content.match(/^- \[ \]/gm) ?? []).length, 1);
  assert.ok(overview.content.includes(`Follow up on the idea [[${source.path}]]`));
  assert.match(overview.content, /<!-- tangrow-capture:[\da-f-]+ -->/);
  assert.equal(fields(source).tangrow_capture_result, `[[${overview.path}]]`);
  assert.equal(app.vault.getMarkdownFiles().length, 2);
});

test('linking a project and marking processed only update the selected capture properties', async () => {
  for (const action of ['project', 'done'] as const) {
    const { app, plugin, source } = setup();
    const original = body(source);
    const project = app.vault.seedFile('20-Project/Existing.md', '# Existing project.');
    await plugin.processCapture(source.path, action === 'project' ? { action, projectPath: project.path } : { action });
    assert.equal(body(source), original);
    assert.equal(project.content, '# Existing project.');
    assert.deepEqual(fields(source).custom, ['preserve', 'these']);
    assert.equal(fields(source).tangrow_project, action === 'project' ? `[[${project.path}]]` : undefined);
    assert.equal(plugin.snapshot().captures[0]?.processed, true);
    assert.deepEqual(app.vault.createdPaths, []);
  }
});

test('invalid destinations and titles cannot prepare an action or create a parallel task note', async () => {
  const { app, plugin, source } = setup();
  const outside = app.vault.seedFile('40-Resources/Not a project.md', '# Resource.');
  const original = source.content;
  for (const request of [
    { action: 'task', title: 'Missing existing task overview' },
    { action: 'task', title: 'Invalid\nsecond line' },
    { action: 'note', title: '../escape' },
    { action: 'project', projectPath: outside.path },
    { action: 'resume' }
  ] as CaptureRequest[]) {
    await assert.rejects(plugin.processCapture(source.path, request));
    assert.equal(source.content, original);
    assert.deepEqual(app.vault.createdPaths, []);
  }
  plugin.settings.taskOverviewPath = source.path;
  await assert.rejects(plugin.processCapture(source.path, { action: 'task', title: 'Self target' }), /different/);
  await assert.rejects(plugin.processCapture(outside.path, { action: 'done' }), /no longer exists/);
  assert.equal(source.content, original);
});

test('restoring pending status preserves the converted note and source provenance', async () => {
  const { app, plugin, source } = setup();
  await plugin.processCapture(source.path, { action: 'note', title: 'Keep this saved result' });
  const result = notes(app)[0]!;
  const content = result.content;
  const sourceBody = body(source);
  await plugin.processCapture(source.path, { action: 'pending' });
  assert.equal(plugin.snapshot().captures[0]?.processed, false);
  assert.equal(result.content, content);
  assert.equal(body(source), sourceBody);
  assert.equal(fields(source).tangrow_capture_result, `[[${result.path}]]`);
  assert.equal(notes(app).length, 1);
});

test('failed preparation cannot create a result or change the original capture', async () => {
  const { app, plugin, source } = setup();
  const original = source.content;
  const update = app.fileManager.processFrontMatter;
  app.fileManager.processFrontMatter = async () => { throw new Error('Preparation failed'); };
  await assert.rejects(plugin.processCapture(source.path, { action: 'note', title: 'Prepared safely' }), /Preparation failed/);
  assert.equal(source.content, original);
  assert.equal(notes(app).length, 0);
  app.fileManager.processFrontMatter = update;
  await plugin.processCapture(source.path, { action: 'note', title: 'Prepared safely' });
  assert.equal(notes(app).length, 1);
});

test('a failed result write retains the durable action and resumes it after a fresh plugin instance', async () => {
  const { app, plugin, source } = setup();
  app.vault.failCreates = 1;
  await assert.rejects(plugin.processCapture(source.path, { action: 'note', title: 'A retryable note' }), /write failure/);
  const receipt = fields(source).tangrow_capture_processing as { id: string; target: string };
  assert.ok(receipt.id);
  assert.equal(plugin.snapshot().captures[0]?.processing, true);
  assert.equal(plugin.snapshot().captures[0]?.processed, false);
  await assert.rejects(plugin.processCapture(source.path, { action: 'task', title: 'A conflicting action' }), /unfinished/);
  const restarted = new harness.TangrowPlugin(app);
  await restarted.processCapture(source.path, { action: 'resume' });
  assert.equal(notes(app).length, 1);
  assert.equal(notes(app)[0]!.path, receipt.target);
  assert.equal(fields(notes(app)[0]!).tangrow_capture_action_id, receipt.id);
});

for (const action of ['note', 'task'] as const) {
  test(`${action}: failed completion can find a moved result without a metadata index or duplicate writes`, async () => {
    const { app, plugin, source } = setup();
    const overview = app.vault.seedFile(plugin.settings.taskOverviewPath, '# Existing tasks.\n');
    const update = app.fileManager.processFrontMatter;
    let calls = 0;
    app.fileManager.processFrontMatter = async (file, change) => {
      if (++calls === 2) throw new Error('Completion state failed');
      await update(file, change);
    };
    const original = body(source);
    await assert.rejects(plugin.processCapture(source.path, { action, title: 'Write once' }), /Completion state failed/);
    assert.ok(fields(source).tangrow_capture_processing);
    assert.equal(body(source), original);
    const result = action === 'note' ? notes(app)[0]! : overview;
    const savedContent = result.content;
    const freshApp = harness.createMockApp();
    for (const file of app.vault.getMarkdownFiles()) freshApp.vault.seedFile(file === result ? `Moved/${file.name}` : file.path, file.content);
    freshApp.metadataCache.getFileCache = () => ({ frontmatter: undefined, listItems: [] });
    const restarted = new harness.TangrowPlugin(freshApp);
    await restarted.processCapture(source.path, { action: 'resume' });
    const recoveredSource = freshApp.vault.getAbstractFileByPath(source.path) as MockFile;
    const recoveredResult = freshApp.vault.getAbstractFileByPath(`Moved/${result.name}`) as MockFile;
    assert.equal(recoveredResult.content, savedContent);
    assert.equal(fields(recoveredSource).tangrow_capture_result, `[[Moved/${result.name}]]`);
    assert.equal(fields(recoveredSource).tangrow_capture_processing, undefined);
    assert.equal(freshApp.vault.getMarkdownFiles().length, app.vault.getMarkdownFiles().length);
  });
}

test('a create error after writing cannot produce a duplicate converted note', async () => {
  const { app, plugin, source } = setup();
  const create = app.vault.create.bind(app.vault);
  app.vault.create = async (path, content) => { await create(path, content); throw new Error('Error after creating the result'); };
  await plugin.processCapture(source.path, { action: 'note', title: 'Created once' });
  assert.equal(notes(app).length, 1);
  assert.ok(fields(source).tangrow_processed_at);
});

test('occupied retry destinations preserve unrelated content and the pending source action', async () => {
  const { app, plugin, source } = setup();
  app.vault.failCreates = 1;
  await assert.rejects(plugin.processCapture(source.path, { action: 'note', title: 'Occupied destination' }));
  const job = fields(source).tangrow_capture_processing as { target: string };
  const unrelated = app.vault.seedFile(job.target, '# User content.');
  await assert.rejects(plugin.processCapture(source.path, { action: 'resume' }), /Occupied/);
  assert.equal(unrelated.content, '# User content.');
  assert.ok(fields(source).tangrow_capture_processing);
  assert.equal(fields(source).tangrow_processed_at, undefined);
  assert.equal(notes(app).length, 0);
});
