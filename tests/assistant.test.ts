import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { AI_INPUT_LIMIT, AI_SECRET_ID, agentGuide, buildPrompt, buildSuggestionPrompt, parseSuggestion, readAiModel, type AiActionId, type AiContext, type AiPrompt, type AiRequest, type AiSource, type CaptureSuggestion } from '../src/ai';
import { readSettings } from '../src/model';
import { appendTaskLine, completeTaskLine, extractTasks, taskLine } from '../src/task-tools';
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
  runAi(request: AiRequest): Promise<string>;
  aiContext(source: AiSource): Promise<AiContext>;
  loadWritingDraft(): WritingDraft;
  updateWritingDraft(patch: Partial<Pick<WritingDraft, 'text' | 'title'>>, expectedRevision: number): boolean;
  submitWritingDraft(expectedRevision: number): Promise<void>;
  suggestCapture(text: string): Promise<CaptureSuggestion>;
  openAiGuide(): Promise<void>;
  appendToActiveNote(text: string): Promise<void>;
}
interface TestAiPanel {
  mount(container: Element): void;
  destroy(): void;
  setSource(source: AiSource): void;
  run(action: AiActionId): Promise<void>;
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
  plugin.aiRunner = async (config, prompt) => { calls.push({ config, prompt }); return 'reply'; };
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

test('generated checklists become distinct task candidates', () => {
  assert.deepEqual(extractTasks('Next steps:\n- [ ] Email Ana\n- [x] Email Ana\n* Book the room\n1. Draft agenda\nplain text'), ['Email Ana', 'Book the room', 'Draft agenda']);
});

test('prompts carry the whole selection and refuse empty or oversized input instead of truncating', () => {
  const prompt = buildPrompt({ action: 'summarize', context: { title: 'Plan "A"', text: 'Body text.' } }, 'zh-CN', '2026-11-12');
  assert.match(prompt.user, /<note title="Plan \\"A\\"">\nBody text\.\n<\/note>/);
  assert.match(prompt.system, /Simplified Chinese/);
  assert.match(prompt.system, /2026-11-12/);
  assert.equal(prompt.schema, undefined);
  assert.throws(() => buildPrompt({ action: 'summarize', context: { title: 'x', text: '  ' } }, 'en', '2026-11-12'), /no text to send/);
  assert.throws(() => buildPrompt({ action: 'polish', context: { title: 'x', text: 'a'.repeat(AI_INPUT_LIMIT + 1) } }, 'en', '2026-11-12'), /too long/);
  assert.throws(() => buildPrompt({ action: 'ask', context: { title: 'x', text: 'a' } }, 'en', '2026-11-12'), /question/);
  assert.match(buildPrompt({ action: 'ask', context: { title: 'x', text: 'a' }, question: 'Why?' }, 'en', '2026-11-12').user, /Question: Why\?$/);
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

test('nothing is sent until AI is enabled and a key exists', async () => {
  const { plugin, app, calls } = await loaded();
  const request: AiRequest = { action: 'summarize', context: { title: 'Note', text: 'Body' } };
  assert.equal(plugin.aiReady(), false);
  assert.throws(() => plugin.runAi(request), /Turn on AI/);
  await plugin.updateAiSettings({ aiEnabled: true });
  assert.equal(plugin.aiReady(), false);
  assert.throws(() => plugin.runAi(request), /API key/);
  await assert.rejects(plugin.suggestCapture('idea'), /API key/);
  assert.equal(calls.length, 0);
  await plugin.setAiKey('test-key-123');
  assert.equal(plugin.aiReady(), true);
  assert.equal(await plugin.runAi(request), 'reply');
  assert.deepEqual(calls[0]!.config, { apiKey: 'test-key-123', model: 'claude-opus-5-5' });
  assert.match(calls[0]!.prompt.user, /Body/);
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
  await plugin.runAi({ action: 'summarize', context: { title: 'Note', text: 'Body' } });
  assert.equal(calls.at(-1)!.config.apiKey, 'test-legacy-key');
  assert.equal((plugin.savedData as { settings: Settings }).settings.aiApiKey, 'test-legacy-key');
  secrets.set(AI_SECRET_ID, 'test-secret-key');
  assert.equal(plugin.aiKeyProtected(), false);
  await plugin.runAi({ action: 'summarize', context: { title: 'Note', text: 'Body' } });
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
  await plugin.runAi({ action: 'summarize', context: { title: 'Note', text: 'Body' } });
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

test('assistant context reads the active note, the draft or a period log without writing', async () => {
  const { plugin, app } = await loaded();
  await assert.rejects(plugin.aiContext('note'), /Markdown note/);
  await assert.rejects(plugin.aiContext('draft'), /draft is empty/);
  const note = app.vault.seedFile('00-Inbox/Idea.md', '# Idea\n- [ ] Try it\n');
  app.workspace.setActiveFile(note);
  assert.deepEqual(await plugin.aiContext('note'), { title: 'Idea', text: '# Idea\n- [ ] Try it\n' });
  const log = await plugin.aiContext('today');
  assert.match(log.text, /## Open tasks \(1\)\n- .*\(in \[\[Idea\]\]\)/);
  assert.match(log.text, /## Notes created \(1\)\n- \[\[Idea\]\] in 00-Inbox/);
  await plugin.appendToActiveNote('## Summary\nShort.');
  assert.equal(note.content, '# Idea\n- [ ] Try it\n\n## Summary\nShort.\n');
});

test('draft context retains the revision of the submitted text', async () => {
  const { plugin } = await loaded();
  plugin.updateWritingDraft({ text: 'Original body', title: 'Original title' }, plugin.loadWritingDraft().revision);
  const original = plugin.loadWritingDraft();
  const pending = plugin.aiContext('draft');
  plugin.updateWritingDraft({ text: 'Newer body' }, original.revision);
  assert.deepEqual(await pending, { title: original.title, text: original.text, draftRevision: original.revision });
});

for (const changed of [false, true]) {
  for (const succeeds of [false, true]) {
    const behavior = changed ? 'preserves the next question across remounts' : succeeds ? 'clears the submitted question' : 'keeps the submitted question for retry';
    test(`asking ${succeeds ? 'success' : 'failure'} ${behavior}`, async () => {
      const { plugin, app, calls } = await loaded();
      plugin.settings.language = 'en';
      await plugin.updateAiSettings({ aiEnabled: true });
      await plugin.setAiKey('test-key-123');
      app.workspace.setActiveFile(app.vault.seedFile('00-Inbox/Idea.md', 'The original context.'));
      let finish!: () => void;
      const runner = plugin.aiRunner;
      plugin.aiRunner = async (config, prompt) => {
        await new Promise<void>((resolve) => { finish = resolve; });
        if (!succeeds) throw new Error('Simulated request failure');
        return runner(config, prompt);
      };
      const panel = new harness.AiPanel(plugin, {});
      const root = new Element();
      panel.mount(root);
      let input = root.querySelectorAll('textarea')[0]!;
      input.value = 'The submitted question?';
      input.dispatchEvent(new Event('input'));
      const pending = panel.run('ask');
      await flush();
      input = root.querySelectorAll('textarea')[0]!;
      if (changed) { input.value = 'The next unsent question?'; input.dispatchEvent(new Event('input')); }
      panel.destroy();
      panel.mount(root);
      assert.equal(root.querySelectorAll('textarea')[0]!.value, changed ? 'The next unsent question?' : 'The submitted question?');
      finish();
      await pending;
      assert.equal(root.querySelectorAll('textarea')[0]!.value, changed ? 'The next unsent question?' : succeeds ? '' : 'The submitted question?');
      if (succeeds) assert.match(calls.at(-1)!.prompt.user, /Question: The submitted question\?$/);
    });
  }
}

test('asking captures the submitted question before awaiting its context', async () => {
  const { plugin, calls } = await loaded();
  plugin.settings.language = 'en';
  await plugin.updateAiSettings({ aiEnabled: true });
  await plugin.setAiKey('test-key-123');
  let finish!: (context: AiContext) => void;
  plugin.aiContext = () => new Promise<AiContext>((resolve) => { finish = resolve; });
  const panel = new harness.AiPanel(plugin, {});
  const root = new Element();
  panel.mount(root);
  const input = root.querySelectorAll('textarea')[0]!;
  input.value = 'The submitted question?';
  input.dispatchEvent(new Event('input'));
  const pending = panel.run('ask');
  input.value = 'A newer question while context loads?';
  input.dispatchEvent(new Event('input'));
  finish({ title: 'Idea', text: 'The original context.' });
  await pending;
  assert.match(calls.at(-1)!.prompt.user, /Question: The submitted question\?$/);
  assert.equal(root.querySelectorAll('textarea')[0]!.value, 'A newer question while context loads?');
});

for (const action of ['polish', 'continue'] as const) {
  const label = action === 'polish' ? 'Replace draft' : 'Add to draft';
  test(`${action}: a reply survives remounts and applies to its unchanged draft only once`, async () => {
    const { plugin } = await loaded();
    plugin.settings.language = 'en';
    await plugin.updateAiSettings({ aiEnabled: true });
    await plugin.setAiKey('test-key-123');
    plugin.updateWritingDraft({ text: 'Original body' }, plugin.loadWritingDraft().revision);
    const panel = new harness.AiPanel(plugin, {});
    const root = new Element();
    panel.mount(root);
    panel.setSource('draft');
    await panel.run(action);
    panel.destroy();
    panel.mount(root);
    await click(root, label);
    const applied = plugin.loadWritingDraft();
    assert.equal(applied.text, action === 'polish' ? 'reply' : 'Original body\n\nreply');
    await click(root, label);
    assert.deepEqual(plugin.loadWritingDraft(), applied);
    assert.match(harness.notices.at(-1)!, /changed in another view/);
  });

  for (const change of ['edit', 'save', 'revert'] as const) {
    test(`${action}: ${change} after the request prevents a stale reply from updating the draft`, async () => {
      const { plugin } = await loaded();
      plugin.settings.language = 'en';
      await plugin.updateAiSettings({ aiEnabled: true });
      await plugin.setAiKey('test-key-123');
      plugin.updateWritingDraft({ text: 'Original body', title: 'Original title' }, plugin.loadWritingDraft().revision);
      const original = plugin.loadWritingDraft();
      let finish!: (text: string) => void;
      plugin.aiRunner = () => new Promise<string>((resolve) => { finish = resolve; });
      const panel = new harness.AiPanel(plugin, {});
      const root = new Element();
      panel.mount(root);
      panel.setSource('draft');
      const pending = panel.run(action);
      await flush();
      if (change === 'save') await plugin.submitWritingDraft(original.revision);
      else {
        plugin.updateWritingDraft({ text: 'Newer body', title: 'Newer title' }, original.revision);
        if (change === 'revert') plugin.updateWritingDraft(original, plugin.loadWritingDraft().revision);
      }
      const latest = plugin.loadWritingDraft();
      finish('Rewritten old body');
      await pending;
      panel.destroy();
      panel.setSource('note');
      panel.mount(root);
      await click(root, label);
      assert.deepEqual(plugin.loadWritingDraft(), latest);
      assert.match(harness.notices.at(-1)!, /changed in another view/);
    });
  }
}

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
