import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { AI_INPUT_LIMIT, AI_SECRET_ID, agentGuide, buildSuggestionPrompt, parseSuggestion, readAiModel, type AiPrompt, type CaptureSuggestion } from '../src/ai';
import { CLAUDIAN_ID, CLAUDIAN_OPEN_COMMAND, WORKFLOWS, claudianApi, skillFiles, workflowPrompt, type AgentStatus, type SendStatus, type WorkflowId, type WorkflowRun } from '../src/claudian';
import { readSettings } from '../src/model';
import { appendTaskLine, completeTaskLine, taskLine } from '../src/task-tools';
import type { Settings, Snapshot, WritingDraft } from '../src/types';
import type { MockApp, Plugin as MockPlugin, TFile as MockFile, createMockApp as MockAppFactory } from './obsidian-mock';

interface TestPlugin extends MockPlugin {
  settings: Settings;
  aiRunner: (config: { apiKey: string; model: string }, prompt: AiPrompt) => Promise<string>;
  onload(): Promise<void>;
  snapshot(): Snapshot;
  addTask(text: string, options?: { due?: string; target?: 'overview' | 'daily' }): Promise<string>;
  completeTask(path: string, line: number): Promise<void>;
  aiReady(): boolean;
  hasAiKey(): boolean;
  aiKeyProtected(): boolean;
  setAiKey(value: string): Promise<void>;
  updateAiSettings(patch: { aiEnabled?: boolean; aiModel?: string }): Promise<void>;
  agentStatus(): AgentStatus;
  agentRun(): WorkflowRun | null;
  runWorkflow(id: WorkflowId): Promise<void>;
  stopWorkflow(): Promise<void>;
  openAgent(): Promise<void>;
  installAgentSkills(): Promise<void>;
  loadWritingDraft(): WritingDraft;
  updateWritingDraft(patch: Partial<Pick<WritingDraft, 'text' | 'title'>>, expectedRevision: number): boolean;
  submitWritingDraft(expectedRevision: number): Promise<void>;
  suggestCapture(text: string): Promise<CaptureSuggestion>;
  openAiGuide(): Promise<void>;
}
interface TestAiPanel {
  mount(container: Element): void;
  destroy(): void;
  refresh(): void;
}
interface Harness {
  TangrowPlugin: new (app: MockApp) => TestPlugin;
  AiPanel: new (host: TestPlugin, component: object) => TestAiPanel;
  createMockApp: typeof MockAppFactory;
  notices: string[];
}

class Element extends EventTarget {
  children: Element[] = [];
  textContent = '';
  value = '';
  disabled = false;
  parentElement?: Element;
  attributes = new Map<string, string>();
  constructor(readonly tag = 'div') { super(); }
  createEl(tag: string, options: { text?: string; attr?: Record<string, string> } = {}): Element {
    const child = new Element(tag);
    child.textContent = options.text ?? '';
    child.attributes = new Map(Object.entries(options.attr ?? {}));
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  createDiv(options = {}): Element { return this.createEl('div', options); }
  createSpan(options = {}): Element { return this.createEl('span', options); }
  addClass(): void {}
  empty(): void { this.children = []; }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); }
  setAttribute(key: string, value: string): void { this.attributes.set(key, value); }
  getAttribute(key: string): string | null { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string): void { this.attributes.delete(key); }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap((child) => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]);
  }
}
async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function click(root: Element, label: string): Promise<void> {
  const button = root.querySelectorAll('button').find((element) => element.getAttribute('aria-label') === label);
  assert.ok(button, `Missing button: ${label}`);
  assert.equal(button.disabled, false);
  button.dispatchEvent(new Event('click'));
  await flush();
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
  absWorkingDir: repository,
  stdin: { contents: "export { default as TangrowPlugin } from './src/main'; export { AiPanel } from './src/ai-panel'; export * from './tests/obsidian-mock';", resolveDir: repository, sourcefile: 'assistant-entry.ts', loader: 'ts' },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-obsidian', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundled.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const harness = moduleObject.exports as Harness;

const TASKS = '10-Life(Meta)/12-Tasks.md';
async function loaded(): Promise<{ plugin: TestPlugin; app: MockApp; calls: { config: { apiKey: string; model: string }; prompt: AiPrompt }[] }> {
  const app = harness.createMockApp();
  const plugin = new harness.TangrowPlugin(app);
  const globals = globalThis as unknown as { window?: unknown };
  // Inert timers: these tests never wait on debounced saves, and live intervals would keep the process open.
  globals.window ??= { setTimeout: () => 0, clearTimeout: () => undefined, setInterval: () => 0, clearInterval: () => undefined };
  await plugin.onload();
  const calls: { config: { apiKey: string; model: string }; prompt: AiPrompt }[] = [];
  plugin.aiRunner = async (config, prompt) => { calls.push({ config, prompt }); return '{"kind":"capture","title":"","due":null,"project":null,"reason":""}'; };
  return { plugin, app, calls };
}
function content(app: MockApp, file: string): string { return (app.vault.getAbstractFileByPath(file) as MockFile).content; }

test('task lines are single-line checkboxes with an optional ISO due date', () => {
  assert.equal(taskLine('  Send the draft\n to the editor '), '- [ ] Send the draft to the editor');
  assert.equal(taskLine('Renew the domain', '2026-11-20'), '- [ ] Renew the domain 📅 2026-11-20');
  assert.throws(() => taskLine('   '));
  assert.throws(() => taskLine('x'.repeat(241)));
  assert.throws(() => taskLine('Call', 'next friday'));
});

test('appending a task keeps existing content and line endings', () => {
  assert.equal(appendTaskLine('', '- [ ] a'), '- [ ] a\n');
  assert.equal(appendTaskLine('# Tasks\n\n```tasks\nnot done\n```', '- [ ] a'), '# Tasks\n\n```tasks\nnot done\n```\n- [ ] a\n');
  assert.equal(appendTaskLine('one\r\n', '- [ ] a'), 'one\r\n- [ ] a\r\n');
});

test('completing a task only touches an open checkbox that still matches', () => {
  const note = '# Plan\n- [ ] first\n  * [/] second\n- [x] done\ntext';
  assert.equal(completeTaskLine(note, 1, 'first'), '# Plan\n- [x] first\n  * [/] second\n- [x] done\ntext');
  assert.equal(completeTaskLine(note, 2), '# Plan\n- [ ] first\n  * [x] second\n- [x] done\ntext');
  assert.throws(() => completeTaskLine(note, 3));
  assert.throws(() => completeTaskLine(note, 4));
  assert.throws(() => completeTaskLine(note, 1, 'a different task'));
  assert.throws(() => completeTaskLine(note, 40));
});

test('completing a task requires the entire indexed label, including CRLF and formatted labels', () => {
  for (const marker of ['- [ ]', '  * [/]', '1. [ ]']) {
    const note = `${marker} Call lawyer\r\n${marker} **Send** [draft](Draft.md)  \r\n`;
    for (const label of ['Call', 'lawyer', '', '[ ] Call lawyer', 'CALL LAWYER']) {
      assert.throws(() => completeTaskLine(note, 0, label), /changed in its note/);
    }
    assert.equal(completeTaskLine(note, 0, 'Call lawyer'), note.replace('[ ]', '[x]').replace('[/]', '[x]'));
    assert.equal(completeTaskLine(note, 1, '**Send** [draft](Draft.md)  '), note.replace(/(\r\n.*?\[)[ /](\])/, '$1x$2'));
  }
});

test('suggestion prompts carry the whole capture and refuse empty or oversized input instead of truncating', () => {
  const prompt = buildSuggestionPrompt('Call Ana on Friday', ['20-Project/Book/Book.md'], 'zh-CN', '2026-11-12');
  assert.match(prompt.user, /<capture>\nCall Ana on Friday\n<\/capture>/);
  assert.match(prompt.user, /- 20-Project\/Book\/Book\.md/);
  assert.match(prompt.system, /Simplified Chinese/);
  assert.match(prompt.system, /2026-11-12/);
  assert.ok(prompt.schema);
  assert.throws(() => buildSuggestionPrompt('  ', [], 'en', '2026-11-12'), /Write something/);
  assert.throws(() => buildSuggestionPrompt('a'.repeat(AI_INPUT_LIMIT + 1), [], 'en', '2026-11-12'), /too long/);
});

test('capture suggestions are validated before they reach the dialog', () => {
  const projects = ['20-Project/Book/Book.md'];
  const prompt = buildSuggestionPrompt('Send chapter three by Friday', projects, 'en', '2026-11-12');
  assert.match(prompt.user, /20-Project\/Book\/Book\.md/);
  assert.ok(prompt.schema);
  assert.deepEqual(parseSuggestion('```json\n{"kind":"task","title":" Send chapter three ","due":"2026-11-13","project":"20-Project/Book/Book.md","reason":"Has a deadline."}\n```', projects),
    { kind: 'task', title: 'Send chapter three', due: '2026-11-13', project: '20-Project/Book/Book.md', reason: 'Has a deadline.' });
  const unsafe = parseSuggestion('{"kind":"delete","title":"A/B: [draft]#1.","due":"Friday","project":"../secret.md","reason":7}', projects);
  assert.deepEqual(unsafe, { kind: 'capture', title: 'A B draft 1', due: null, project: null, reason: '' });
  assert.throws(() => parseSuggestion('not json', projects), /could not be read/);
});

test('AI stays off by default and unsafe persisted values fall back', () => {
  const defaults = readSettings(undefined);
  assert.equal(defaults.aiEnabled, false);
  assert.equal(defaults.aiApiKey, '');
  assert.equal(defaults.aiModel, 'claude-opus-5-5');
  assert.equal(readSettings({ aiEnabled: 'yes', aiModel: 'bad model name' }).aiEnabled, false);
  assert.equal(readAiModel('bad model name'), 'claude-opus-5-5');
  assert.equal(readAiModel(' claude-haiku-5-5 '), 'claude-haiku-5-5');
});

test('the agent guide describes the configured folders in the interface language', () => {
  const settings = readSettings({ inboxFolder: 'Inbox', projectFolder: 'Work' });
  assert.match(agentGuide(settings), /协作约定[\s\S]*`Inbox`[\s\S]*`Work`/);
  assert.match(agentGuide({ ...settings, language: 'en' }), /Working with Tangrow[\s\S]*`Inbox`/);
});

test('quick tasks append to the existing overview and never create a parallel task note', async () => {
  const { plugin, app } = await loaded();
  await assert.rejects(plugin.addTask('Orphan'), /existing Tasks note/);
  assert.equal(app.vault.getAbstractFileByPath(TASKS), null);
  app.vault.seedFile(TASKS, '# Tasks\n\n```tasks\nnot done\n```\n');
  assert.equal(await plugin.addTask('Renew the domain', { due: '2026-11-20' }), TASKS);
  assert.equal(content(app, TASKS), '# Tasks\n\n```tasks\nnot done\n```\n- [ ] Renew the domain 📅 2026-11-20\n');
  await assert.rejects(plugin.addTask('  '));
  assert.equal(plugin.snapshot().tasks.length, 1);
});

test('a task for today lands in the daily note, creating it once', async () => {
  const { plugin, app } = await loaded();
  const daily = await plugin.addTask('Water the plants', { target: 'daily' });
  assert.match(daily, /^10-Life\(Meta\)\/13-Journal\//);
  await plugin.addTask('Stretch', { target: 'daily' });
  assert.match(content(app, daily), /- \[ \] Water the plants\n- \[ \] Stretch\n$/);
});

test('checking a task from the sidebar edits only that line in its note', async () => {
  const { plugin, app } = await loaded();
  app.vault.seedFile('20-Project/Book/Book.md', '# Book\n- [ ] Outline\n- [ ] Draft\n');
  const task = plugin.snapshot().tasks.find((entry) => entry.line === 2)!;
  await plugin.completeTask(task.path, task.line);
  assert.equal(content(app, '20-Project/Book/Book.md'), '# Book\n- [ ] Outline\n- [x] Draft\n');
  await assert.rejects(plugin.completeTask(task.path, task.line), /changed in its note/);
  await assert.rejects(plugin.completeTask('missing.md', 0), /no longer exists/);
  assert.equal(plugin.snapshot().tasks.length, 1);
});

test('a stale sidebar task cannot complete a different task whose label contains the old one', async () => {
  const { plugin, app } = await loaded();
  const note = app.vault.seedFile('20-Project/Plan.md', '# Plan\n- [ ] Call\n- [ ] Call lawyer\n');
  plugin.snapshot();
  await flush();
  const stale = plugin.snapshot().tasks.find((task) => task.text === 'Call')!;
  assert.ok(stale);
  note.content = '# Plan\n- [ ] Call lawyer\n';
  await assert.rejects(plugin.completeTask(stale.path, stale.line), /changed in its note/);
  assert.equal(note.content, '# Plan\n- [ ] Call lawyer\n');
});

test('quoted sidebar tasks display their labels and complete without changing quote markers or line endings', async () => {
  const { plugin, app } = await loaded();
  const note = app.vault.seedFile('20-Project/Plan.md', '> [!todo] Next\r\n> - [ ] Call\r\n> > 1. [/] Call lawyer\r\n');
  const getFileCache = app.metadataCache.getFileCache;
  app.metadataCache.getFileCache = (file) => file === note ? { ...getFileCache(file), listItems: [
    { task: ' ', position: { start: { line: 1 } } },
    { task: '/', position: { start: { line: 2 } } }
  ] } : getFileCache(file);
  plugin.snapshot();
  await flush();
  const tasks = plugin.snapshot().tasks;
  assert.deepEqual(tasks.map((task) => task.text), ['Call', 'Call lawyer']);
  const task = tasks[1]!;
  await plugin.completeTask(task.path, task.line);
  assert.equal(note.content, '> [!todo] Next\r\n> - [ ] Call\r\n> > 1. [x] Call lawyer\r\n');
});

test('quoted task completion rejects a stale label even when the replacement contains it', () => {
  assert.throws(() => completeTaskLine('> - [ ] Call lawyer\r\n', 0, 'Call'), /changed in its note/);
  assert.equal(completeTaskLine('  > >\t2) [/] Call\r\n', 0, 'Call'), '  > >\t2) [x] Call\r\n');
});

test('nothing is sent until AI is enabled and a key exists', async () => {
  const { plugin, app, calls } = await loaded();
  assert.equal(plugin.aiReady(), false);
  await assert.rejects(plugin.suggestCapture('idea'), /Turn on AI/);
  await plugin.updateAiSettings({ aiEnabled: true });
  assert.equal(plugin.aiReady(), false);
  await assert.rejects(plugin.suggestCapture('idea'), /API key/);
  assert.equal(calls.length, 0);
  await plugin.setAiKey('test-key-123');
  assert.equal(plugin.aiReady(), true);
  plugin.aiRunner = async (config, prompt) => { calls.push({ config, prompt }); return '{"kind":"task","title":"Try it","due":null,"project":null,"reason":"r"}'; };
  assert.equal((await plugin.suggestCapture('idea')).kind, 'task');
  assert.deepEqual(calls[0]!.config, { apiKey: 'test-key-123', model: 'claude-opus-5-5' });
  assert.match(calls[0]!.prompt.user, /idea/);
  await assert.rejects(plugin.updateAiSettings({ aiModel: 'not a model' }), /model name/);
  await plugin.setAiKey('');
  assert.equal(plugin.aiReady(), false);
  assert.equal(app.vault.getFiles().length, 0);
});

test('the key prefers host secret storage and is then kept out of plugin data', async () => {
  const { plugin, app } = await loaded();
  const secrets = new Map<string, string>();
  (app as unknown as { secretStorage: unknown }).secretStorage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } };
  await plugin.updateAiSettings({ aiEnabled: true });
  await plugin.setAiKey('test-key-456');
  assert.equal(secrets.get(AI_SECRET_ID), 'test-key-456');
  assert.equal(plugin.settings.aiApiKey, '');
  assert.equal(JSON.stringify(plugin.savedData).includes('test-key-456'), false);
  assert.equal(plugin.aiReady(), true);
  assert.equal(plugin.aiKeyProtected(), true);
});

test('adding host secret storage does not mark a persisted plaintext key as protected', async () => {
  const { plugin, app, calls } = await loaded();
  await plugin.updateAiSettings({ aiEnabled: true });
  await plugin.setAiKey('test-legacy-key');
  assert.equal(plugin.aiKeyProtected(), false);
  const secrets = new Map<string, string>();
  (app as unknown as { secretStorage: unknown }).secretStorage = {
    getSecret: (id: string) => secrets.get(id) ?? null,
    setSecret: (id: string, value: string) => { secrets.set(id, value); }
  };
  assert.equal(plugin.hasAiKey(), true);
  assert.equal(plugin.aiKeyProtected(), false);
  await plugin.suggestCapture('Body');
  assert.equal(calls.at(-1)!.config.apiKey, 'test-legacy-key');
  assert.equal((plugin.savedData as { settings: Settings }).settings.aiApiKey, 'test-legacy-key');
  secrets.set(AI_SECRET_ID, 'test-secret-key');
  assert.equal(plugin.aiKeyProtected(), false);
  await plugin.suggestCapture('Body');
  assert.equal(calls.at(-1)!.config.apiKey, 'test-secret-key');
  await plugin.setAiKey('test-replacement-key');
  assert.equal(plugin.aiKeyProtected(), true);
  assert.equal(plugin.settings.aiApiKey, '');
  assert.equal((plugin.savedData as { settings: Settings }).settings.aiApiKey, '');
});

test('a failed secret read reports an existing plaintext fallback as unprotected', async () => {
  const { plugin, app, calls } = await loaded();
  await plugin.updateAiSettings({ aiEnabled: true });
  await plugin.setAiKey('test-legacy-key');
  (app as unknown as { secretStorage: unknown }).secretStorage = {
    getSecret: () => { throw new Error('Secret storage unavailable'); }, setSecret: () => undefined
  };
  assert.equal(plugin.hasAiKey(), true);
  assert.equal(plugin.aiKeyProtected(), false);
  await plugin.suggestCapture('Body');
  assert.equal(calls.at(-1)!.config.apiKey, 'test-legacy-key');
});

test('an empty key field describes secret storage when it is available for the next key', async () => {
  const { plugin, app } = await loaded();
  (app as unknown as { secretStorage: unknown }).secretStorage = { getSecret: () => null, setSecret: () => undefined };
  assert.equal(plugin.hasAiKey(), false);
  assert.equal(plugin.aiKeyProtected(), true);
});

test('suggestions can only point at project notes that exist', async () => {
  const { plugin, app } = await loaded();
  app.vault.seedFile('20-Project/Book/Book.md', '---\ntangrow_kind: "project"\n---\n# Book\n');
  await plugin.updateAiSettings({ aiEnabled: true });
  await plugin.setAiKey('test-key-123');
  plugin.aiRunner = async () => '{"kind":"note","title":"Chapter notes","due":null,"project":"20-Project/Other/Other.md","reason":"r"}';
  assert.equal((await plugin.suggestCapture('notes on chapter three')).project, null);
});

interface FakeClaudian {
  sent: { sessionId: string; text?: string; mode?: string }[];
  commands: string[];
  session: string | null;
  reply: string;
  status: SendStatus;
  files: Map<string, string>;
  folders: Set<string>;
}
/** Installs a stand-in for Claudian's documented plugin API, its open command and the vault adapter. */
function withClaudian(app: MockApp, version: unknown = 1): FakeClaudian {
  const fake: FakeClaudian = { sent: [], commands: [], session: 'session-1', reply: 'Done.', status: 'started', files: new Map(), folders: new Set() };
  const host = app as unknown as Record<string, unknown>;
  host.plugins = { getPlugin: (id: string) => id === CLAUDIAN_ID ? { api: {
    version,
    getActiveSessionId: () => fake.session,
    send: async (sessionId: string, options: { text?: string; mode?: string }) => { fake.sent.push({ sessionId, ...options }); return options.text ? fake.status : 'interrupted'; },
    read: async () => fake.reply
  } } : null };
  host.commands = { executeCommandById: (id: string) => { fake.commands.push(id); return true; } };
  (app.vault as unknown as Record<string, unknown>).adapter = {
    exists: async (target: string) => fake.files.has(target) || fake.folders.has(target),
    mkdir: async (target: string) => { fake.folders.add(target); },
    write: async (target: string, data: string) => { fake.files.set(target, data); }
  };
  return fake;
}
function endTurn(app: MockApp, sessionId: string): Promise<void> {
  (app.workspace as unknown as { trigger(name: string, event: unknown): void }).trigger('claudian:turn-ended', { sessionId });
  return flush();
}

test('workflow prompts name files by path, follow the configured folders and state whether they may write', () => {
  const settings = readSettings({ language: 'en', inboxFolder: 'Inbox', taskOverviewPath: 'Tasks.md', supportFolder: 'Meta' });
  const context = { today: '2026-11-12', weeklyNote: 'Journal/2026-W46.md', activeNote: 'Projects/Book/Book.md' };
  const inbox = workflowPrompt('inbox', settings, context);
  assert.match(inbox, /Today is 2026-11-12/);
  assert.match(inbox, /Read `Meta\/AGENTS\.md` first/);
  assert.match(inbox, /pending capture in `Inbox`/);
  assert.match(inbox, /end of `Tasks\.md`/);
  assert.match(inbox, /wait for my reply before writing/);
  assert.match(inbox, /Do not move, rename or delete/);
  assert.match(workflowPrompt('weekly', settings, context), /`Journal\/2026-W46\.md`/);
  assert.match(workflowPrompt('tasks', settings, context), /read-only/);
  assert.match(workflowPrompt('connect', settings, context), /`Projects\/Book\/Book\.md`/);
  assert.throws(() => workflowPrompt('project-plan', settings, { today: '2026-11-12', weeklyNote: 'w.md' }), /Markdown note/);
  assert.match(workflowPrompt('inbox', readSettings({}), context), /等我确认/);
  for (const item of WORKFLOWS) assert.equal(workflowPrompt(item.id, settings, context).includes('undefined'), false);
});

test('queued workflows never consume an earlier turn reply or interrupt it when dismissed', async () => {
  const { plugin, app } = await loaded();
  const fake = withClaudian(app);
  fake.status = 'queued';
  fake.reply = 'An earlier request finished.';
  await plugin.runWorkflow('tasks');
  assert.equal(plugin.agentRun()?.state, 'delegated');
  await endTurn(app, 'session-1');
  assert.equal(plugin.agentRun()?.state, 'delegated');
  assert.equal(plugin.agentRun()?.reply, '');
  fake.reply = 'Another queued request finished.';
  await endTurn(app, 'session-1');
  assert.equal(plugin.agentRun()?.state, 'delegated');
  assert.equal(plugin.agentRun()?.reply, '');
  await plugin.stopWorkflow();
  assert.equal(plugin.agentRun(), null);
  assert.equal(fake.sent.length, 1);
});

test('a queued workflow shows chat follow-up instead of completion or a stop control', async () => {
  const { plugin, app } = await loaded();
  plugin.settings.language = 'en';
  const fake = withClaudian(app);
  fake.status = 'queued';
  await plugin.runWorkflow('tasks');
  const panel = new harness.AiPanel(plugin, {});
  const root = new Element();
  panel.mount(root);
  const labels = root.querySelectorAll('button').map((button) => button.getAttribute('aria-label'));
  assert.ok(labels.includes('Continue in Claudian'));
  assert.ok(labels.includes('Dismiss'));
  assert.equal(labels.includes('Stop'), false);
  assert.equal(labels.includes('Copy'), false);
  assert.equal(root.querySelectorAll('span').some((element) => element.textContent === 'Latest reply'), false);
  panel.destroy();
});

test('vault skills cover every workflow with valid front matter and no session-specific paths', () => {
  const files = skillFiles(readSettings({ language: 'en' }));
  assert.deepEqual(files.map((file) => file.path), WORKFLOWS.map((item) => `.claude/skills/tangrow-${item.id}/SKILL.md`));
  for (const file of files) {
    assert.match(file.content, /^---\nname: tangrow-[a-z-]+\ndescription: ".+"\n---\n/);
    assert.match(file.content, /## Ground rules/);
    assert.equal(file.content.includes('undefined'), false);
  }
  assert.match(files.find((file) => file.path.includes('connect'))!.content, /the note I name/);
  assert.match(skillFiles(readSettings({}))[0]!.content, /## 步骤/);
});

test('the bridge reports a missing, incompatible, idle or ready Claudian', async () => {
  const { plugin, app } = await loaded();
  assert.equal(claudianApi(app as never), 'missing');
  assert.equal(plugin.agentStatus(), 'missing');
  await assert.rejects(plugin.runWorkflow('tasks'), /Install and enable the Claudian plugin/);
  withClaudian(app, 2);
  assert.equal(plugin.agentStatus(), 'incompatible');
  await assert.rejects(plugin.runWorkflow('tasks'), /not compatible/);
  const fake = withClaudian(app);
  assert.equal(plugin.agentStatus(), 'ready');
  fake.session = null;
  assert.equal(plugin.agentStatus(), 'idle');
  await assert.rejects(plugin.runWorkflow('tasks'), /Open a chat in Claudian/);
  assert.deepEqual(fake.commands, [CLAUDIAN_OPEN_COMMAND]);
  assert.equal(fake.sent.length, 0);
});

test('a workflow goes to the focused session once, creates the guide, and shows the reply when its turn ends', async () => {
  const { plugin, app } = await loaded();
  const fake = withClaudian(app);
  await assert.rejects(plugin.runWorkflow('connect'), /Markdown note/);
  assert.equal(fake.sent.length, 0);
  const note = app.vault.seedFile('00-Inbox/Idea.md', '# Idea\n');
  app.workspace.setActiveFile(note);
  await plugin.runWorkflow('connect');
  assert.equal(fake.sent.length, 1);
  assert.equal(fake.sent[0]!.sessionId, 'session-1');
  assert.match(fake.sent[0]!.text!, /`00-Inbox\/Idea\.md`/);
  assert.match(content(app, '99-Tangrow/AGENTS.md'), /协作约定/);
  assert.equal(note.content, '# Idea\n');
  assert.deepEqual(plugin.agentRun(), { workflow: 'connect', sessionId: 'session-1', state: 'running', reply: '' });
  await assert.rejects(plugin.runWorkflow('tasks'), /already running/);
  await endTurn(app, 'another-session');
  assert.equal(plugin.agentRun()!.state, 'running');
  fake.reply = '  Linked three notes.  ';
  await endTurn(app, 'session-1');
  assert.deepEqual(plugin.agentRun(), { workflow: 'connect', sessionId: 'session-1', state: 'done', reply: 'Linked three notes.' });
  await plugin.stopWorkflow();
  assert.equal(plugin.agentRun(), null);
  assert.equal(fake.sent.length, 1);
});

test('stopping a running workflow interrupts only its own session', async () => {
  const { plugin, app } = await loaded();
  const fake = withClaudian(app);
  await plugin.runWorkflow('tasks');
  await plugin.stopWorkflow();
  assert.deepEqual(fake.sent[1], { sessionId: 'session-1', mode: 'interrupt' });
  assert.equal(plugin.agentRun(), null);
  await endTurn(app, 'session-1');
  assert.equal(plugin.agentRun(), null);
});

test('installing skills writes each file once and leaves an existing skill unchanged', async () => {
  const { plugin, app } = await loaded();
  const fake = withClaudian(app);
  fake.files.set('.claude/skills/tangrow-inbox/SKILL.md', 'my own version');
  await plugin.installAgentSkills();
  assert.equal(fake.files.get('.claude/skills/tangrow-inbox/SKILL.md'), 'my own version');
  assert.equal(fake.files.size, WORKFLOWS.length);
  assert.match(fake.files.get('.claude/skills/tangrow-weekly/SKILL.md')!, /name: tangrow-weekly/);
  assert.ok(fake.folders.has('.claude') && fake.folders.has('.claude/skills/tangrow-weekly'));
  assert.match(harness.notices.at(-1)!, /5.*1/);
  assert.equal(app.vault.getFiles().map((file) => file.path).join(), '99-Tangrow/AGENTS.md');
});

test('the panel offers workflows only when Claudian can take them and reports a run', async () => {
  const { plugin, app } = await loaded();
  const globals = globalThis as unknown as { window: { open?: (url: string) => void } };
  const opened: string[] = [];
  globals.window.open = (url) => { opened.push(url); };
  const root = new Element();
  const panel = new harness.AiPanel(plugin, {});
  panel.mount(root);
  const labels = (): string[] => root.querySelectorAll('strong').map((element) => element.textContent);
  assert.ok(labels().some((label) => /Claudian/.test(label)));
  assert.equal(root.querySelectorAll('button').some((button) => button.getAttribute('aria-label') === null), false);
  await click(root, plugin.settings.language === 'zh-CN' ? '在社区插件中查找 Claudian' : 'Find Claudian in Community plugins');
  assert.deepEqual(opened, [`obsidian://show-plugin?id=${CLAUDIAN_ID}`]);
  const fake = withClaudian(app);
  panel.refresh();
  const workflows = (): Element[] => root.querySelectorAll('button').filter((button) => button.getAttribute('aria-label') === null);
  assert.equal(workflows().length, WORKFLOWS.length);
  assert.deepEqual(workflows().map((button) => button.disabled), WORKFLOWS.map((item) => item.needsNote));
  workflows()[2]!.dispatchEvent(new Event('click'));
  await flush();
  await flush();
  assert.equal(fake.sent.length, 1);
  panel.refresh();
  assert.ok(workflows().every((button) => button.disabled));
  await endTurn(app, 'session-1');
  panel.refresh();
  assert.equal(workflows().filter((button) => button.disabled).length, WORKFLOWS.filter((item) => item.needsNote).length);
  panel.destroy();
});

test('the agent guide is created once and an edited copy is left alone', async () => {
  const { plugin, app } = await loaded();
  await plugin.openAiGuide();
  const guide = app.vault.getAbstractFileByPath('99-Tangrow/AGENTS.md') as MockFile;
  assert.match(guide.content, /协作约定/);
  guide.content = 'my own rules';
  await plugin.openAiGuide();
  assert.equal(guide.content, 'my own rules');
  assert.deepEqual(app.workspace.rootOpenedFiles.slice(-1), ['99-Tangrow/AGENTS.md']);
});
