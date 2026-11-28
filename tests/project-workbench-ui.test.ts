import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readSettings } from '../src/model';
import type { WorkbenchArea, WorkbenchLinkCandidate, WorkbenchProject, WorkbenchProjectTask, WorkbenchProjectType } from '../src/project-workbench-data';
import type { NoteSummary, SidebarHost } from '../src/types';

interface ElementOptions { cls?: string; text?: string; attr?: Record<string, string> }
interface MockDocument { activeElement: Element | null }

class Element extends EventTarget {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  readonly classes: Set<string>;
  readonly attributes: Map<string, string>;
  textContent: string;
  disabled = false;
  checked = false;
  readOnly = false;
  value: string | number = '';

  constructor(readonly tag = 'div', readonly ownerDocument: MockDocument = { activeElement: null }, options: ElementOptions = {}) {
    super();
    this.classes = new Set(options.cls?.split(' '));
    this.attributes = new Map(Object.entries(options.attr ?? {}));
    this.textContent = options.text ?? '';
  }

  createEl(tag: string, options?: ElementOptions): Element {
    const child = new Element(tag, this.ownerDocument, options);
    this.children.push(child);
    return child;
  }
  createDiv(options?: ElementOptions): Element { return this.createEl('div', options); }
  createSpan(options?: ElementOptions): Element { return this.createEl('span', options); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addClass(name: string): void { this.classes.add(name); }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
  contains(target: Element | null): boolean { return target !== null && this.all().includes(target); }
  empty(): void {
    if (this.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = null;
    this.children = [];
  }
  focus(): void { this.ownerDocument.activeElement = this; }
  click(): void { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  setSelectionRange(): void {}
  querySelectorAll(selector: string): Element[] {
    if (selector === '[data-tangrow-action]') return this.all().filter((element) => !!element.dataset.tangrowAction);
    return this.all().filter((element) => element.tag === selector);
  }
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  absWorkingDir: repository,
  stdin: {
    contents: "export { ProjectWorkbench } from './src/project-workbench'; export { SidebarUI } from './src/ui';",
    resolveDir: repository,
    loader: 'ts'
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-project-workbench', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const { ProjectWorkbench, SidebarUI } = moduleObject.exports as typeof import('../src/project-workbench') & typeof import('../src/ui');

function project(name: string, data: Partial<WorkbenchProject> = {}): WorkbenchProject {
  const root = `20-Project/${name}`;
  const notePath = `${root}/${name}.md`;
  return { path: root, name, notePath, status: 'open', notes: [], tasks: [], due: null, areaNotePath: notePath, areaPath: null,
    typeNotePath: notePath, projectType: null, references: [], ...data };
}

function fixture(projects: WorkbenchProject[], areas: WorkbenchArea[] = [], candidates: WorkbenchLinkCandidate[] = [],
  options: { types?: WorkbenchProjectType[]; drafts?: NoteSummary[] } = {}) {
  const settings = readSettings({ language: 'en' });
  let drafts = options.drafts ?? [];
  const opened: Array<[string, number | undefined]> = [];
  const added: Array<[string, string]> = [];
  const completed: Array<[string, number, string | undefined]> = [];
  const quickAdd: Array<string | undefined> = [];
  const writes: Array<Array<string | null>> = [];
  const findProject = (path: string) => {
    const selected = projects.find((item) => item.path === path);
    assert.ok(selected);
    return selected;
  };
  const host = {
    settings,
    workbenchProjects: () => projects,
    workbenchProjectTypes: () => options.types ?? [],
    workbenchDrafts: () => drafts,
    workbenchAreas: () => areas,
    workbenchLinkCandidates: () => candidates,
    openNote: async (path, line) => { opened.push([path, line]); },
    openQuickAdd: (kind) => { quickAdd.push(kind); },
    addProjectTask: async (path, text) => { added.push([path, text]); },
    addAreaTask: async (path, text) => { writes.push(['area-task', path, text]); },
    openNewAreaNote: (path) => { writes.push(['new-area-note', path]); },
    revealWorkbenchPath: async (path) => { writes.push(['reveal', path]); },
    setWorkbenchProjectArea: async (path, area) => {
      writes.push(['area', path, area]);
      findProject(path).areaPath = area;
    },
    setWorkbenchProjectType: async (path, type) => {
      writes.push(['type', path, type]);
      findProject(path).projectType = type;
    },
    setWorkbenchProjectStatus: async (path, status) => {
      writes.push(['status', path, status]);
      findProject(path).status = status;
      render();
    },
    linkWorkbenchNote: async (notePath, projectPath) => {
      writes.push(['link', notePath, projectPath]);
      drafts = drafts.filter((draft) => draft.path !== notePath);
      const note = candidates.find((item) => item.path === notePath);
      if (note) findProject(projectPath).references.push(note);
    },
    completeTask: async (path, line, expected) => {
      completed.push([path, line, expected]);
      const entry = projects.flatMap((item) => item.tasks).find((task) => task.path === path && task.line === line);
      if (entry) entry.done = true;
    }
  } satisfies Pick<SidebarHost, 'settings' | 'workbenchProjects' | 'workbenchAreas' | 'workbenchLinkCandidates' | 'workbenchProjectTypes' | 'workbenchDrafts'
    | 'openNote' | 'openQuickAdd' | 'addProjectTask' | 'addAreaTask' | 'openNewAreaNote' | 'revealWorkbenchPath'
    | 'setWorkbenchProjectArea' | 'setWorkbenchProjectType' | 'setWorkbenchProjectStatus' | 'linkWorkbenchNote' | 'completeTask'>;
  const root = new Element();
  const ui = new SidebarUI(() => settings.language);
  let view: 'projects' | 'areas' | 'drafts' = 'projects';
  const pane = root as unknown as HTMLElement;
  const render = () => {
    if (view === 'areas') workbench.renderAreas(pane);
    else if (view === 'drafts') workbench.renderDrafts(pane);
    else workbench.render(pane);
  };
  const workbench = new ProjectWorkbench(host as SidebarHost, ui, render, (path, fromArea) => {
    view = 'projects';
    workbench.showProject(path, fromArea);
    render();
  }, (path) => {
    view = 'areas';
    workbench.showArea(path);
    render();
  }, () => { writes.push(['scratchpad']); });
  render();
  return { workbench, root, opened, added, completed, quickAdd, writes, render,
    showAreas: () => { view = 'areas'; render(); }, showDrafts: () => { view = 'drafts'; render(); } };
}

function control(root: Element, action: string): Element {
  const match = root.all().find((element) => element.dataset.tangrowAction === action);
  assert.ok(match, `Expected ${action}`);
  return match;
}

function primary(root: Element): Element {
  const main = root.all().filter((element) => element.tag === 'button' && element.classes.has('mod-cta'));
  assert.equal(main.length, 1);
  return main[0]!;
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

async function click(button: Element): Promise<void> {
  assert.equal(button.disabled, false);
  button.focus();
  button.dispatchEvent(new Event('click'));
  await flush();
}

function labelledButton(root: Element, label: string): Element {
  const button = root.all().find((entry) => entry.tag === 'button' && entry.getAttribute('aria-label') === label);
  assert.ok(button, `Expected ${label}`);
  return button;
}

function selectOnlyOption(root: Element): void {
  const radios = root.all().filter((entry) => entry.tag === 'input' && entry.getAttribute('name')?.startsWith('tangrow-workbench-picker-'));
  assert.equal(radios.length, 1);
  const radio = radios[0]!;
  radio.checked = true;
  radio.dispatchEvent(new Event('change'));
}

function areaFixture(path = '30-Area/Work', name = 'Work', data: Partial<WorkbenchArea> = {}): WorkbenchArea {
  return { path, name, notePath: `${path}/README.md`, noteCount: 1, modified: null, recent: [], tasks: [], projects: [], ...data };
}

test('an empty project list gives New project as its sole primary action', async () => {
  const { root, quickAdd } = fixture([]);
  assert.equal(primary(root).getAttribute('aria-label'), 'New project');
  assert.equal(root.all().filter((element) => element.classes.has('tangrow-coming-soon')).length, 1);
  await click(primary(root));
  assert.deepEqual(quickAdd, ['project']);
});

test('project detail opens the latest associated note or the project note', async () => {
  const link = { path: '00-Inbox/Manuscript.md', name: 'Manuscript', folder: '00-Inbox', modified: 2, kind: 'draft' };
  const withNotes = project('Story', { notes: [link, { ...link, path: '00-Inbox/Outline.md', name: 'Outline', modified: 1 }] });
  const withoutNotes = project('Video');
  const { root, opened } = fixture([withNotes, withoutNotes]);

  await click(control(root, `project-open-${withNotes.path}`));
  assert.equal(root.ownerDocument.activeElement, control(root, 'project-back'));
  assert.equal(primary(root).getAttribute('aria-label'), 'Continue: Manuscript');
  await click(primary(root));
  await click(control(root, 'project-back'));
  assert.equal(root.ownerDocument.activeElement, control(root, `project-open-${withNotes.path}`));

  await click(control(root, `project-open-${withoutNotes.path}`));
  assert.equal(primary(root).getAttribute('aria-label'), 'Open the project note');
  await click(primary(root));
  assert.deepEqual(opened, [[link.path, undefined], [withoutNotes.notePath, undefined]]);
});

test('the project list ranks open work by task urgency before completed projects', () => {
  const task: WorkbenchProjectTask = {
    path: '20-Project/Outline.md', line: 1, text: 'Review the outline', done: false,
    sourceKind: 'folder', sourceName: 'Outline'
  };
  const overdue = { ...task, text: `${task.text} 📅 2000-01-01` };
  const due = new Date('2000-01-01T00:00:00Z');
  const completed = project('A completed project', { status: 'done', tasks: [overdue], due });
  const open = project('B open project', { tasks: [task] });
  const urgent = project('C urgent project', { tasks: [overdue], due });
  const { root } = fixture([completed, open, urgent]);
  const rows = root.all().filter((element) => element.dataset.tangrowAction?.startsWith('project-open-'));
  assert.deepEqual(rows.map((row) => row.dataset.tangrowAction), [urgent, open, completed].map((item) => `project-open-${item.path}`));
});

test('project tasks show sorted sources, expand beyond five, and preserve raw text for completion', async () => {
  const overview = '10-Life(Meta)/12-Tasks.md';
  const overdue: WorkbenchProjectTask = {
    path: overview, line: 9, text: 'Review terms #work/plan ⏫ 📅 2000-01-01 [[Specs|Spec note]]',
    done: false, sourceKind: 'overview', sourceName: '12-Tasks'
  };
  const items = Array.from({ length: 6 }, (_, line): WorkbenchProjectTask => ({
    path: '20-Project/Story/Outline.md', line, text: `Task ${line + 1}`, done: line === 0,
    sourceKind: 'folder', sourceName: 'Outline'
  }));
  const story = project('Story', { tasks: [...items, overdue] });
  const { workbench, root, opened, completed } = fixture([story]);
  workbench.showProject(story.path);
  const rows = () => root.all().filter((element) => element.dataset.tangrowAction?.startsWith('project-task-note-'));
  const name = (button: Element | undefined) => {
    const id = button?.getAttribute('aria-labelledby');
    assert.ok(id);
    const label = button?.children.find((child) => child.getAttribute('id') === id);
    assert.ok(label);
    assert.equal(label.getAttribute('hidden'), '');
    return label.textContent;
  };
  assert.equal(rows().length, 5);
  assert.equal(root.querySelectorAll('progress')[0]?.getAttribute('aria-label'), '1/7 done');
  assert.match(name(rows()[0]), /Review terms.*Spec note.*#work\/plan.*Task overview/);
  assert.match(name(rows()[1]), /Project folder · Outline/);
  assert.equal(name(control(root, `project-task-check-${overdue.path}:${overdue.line}`)), 'Complete: Review terms');
  await click(control(root, 'project-task-more'));
  assert.equal(rows().length, 6);
  assert.equal(control(root, 'project-task-more').getAttribute('aria-expanded'), 'true');
  await click(control(root, `project-task-note-${overdue.path}:${overdue.line}`));
  await click(control(root, `project-task-check-${overdue.path}:${overdue.line}`));
  assert.equal(root.querySelectorAll('progress')[0]?.getAttribute('aria-label'), '2/7 done');
  assert.deepEqual(opened, [[overdue.path, overdue.line]]);
  assert.deepEqual(completed, [[overdue.path, overdue.line, overdue.text]]);
});

test('the project task form sends Enter to the chosen project and retains focus', async () => {
  const story = project('Story');
  const { workbench, root, added } = fixture([story]);
  workbench.showProject(story.path);
  const input = control(root, 'project-task-add');
  input.focus();
  input.value = 'Review the outline';
  const form = root.querySelectorAll('form')[0]!;
  input.dispatchEvent(new Event('compositionstart'));
  workbench.render(root as unknown as HTMLElement);
  assert.equal(control(root, 'project-task-add'), input);
  form.dispatchEvent(new Event('submit'));
  assert.deepEqual(added, []);
  input.dispatchEvent(new Event('compositionend'));
  form.dispatchEvent(new Event('submit'));
  form.dispatchEvent(new Event('submit'));
  await flush();
  assert.deepEqual(added, [[story.notePath, 'Review the outline']]);
  const next = control(root, 'project-task-add');
  assert.equal(next.value, '');
  assert.equal(next.readOnly, false);
  assert.equal(root.ownerDocument.activeElement, next);
});

test('project area search keeps its query and writes the selected association only on confirmation', async () => {
  const story = project('Story');
  const work = areaFixture();
  const health = areaFixture('30-Area/Health', 'Health');
  const { workbench, root, writes, render } = fixture([story], [work, health]);
  workbench.showProject(story.path);
  await click(control(root, 'project-picker-area'));
  const query = control(root, 'project-picker-search-area');
  query.value = 'health';
  query.dispatchEvent(new Event('input'));
  selectOnlyOption(root);
  assert.deepEqual(writes, []);
  render();
  assert.equal(control(root, 'project-picker-search-area').value, 'health');
  await click(labelledButton(root, 'Confirm selection'));
  assert.deepEqual(writes, [['area', story.path, health.path]]);
  assert.equal(control(root, 'project-picker-area').getAttribute('aria-label'), 'Area · Health');

  workbench.showProject(null);
  const grouping = control(root, 'project-group-mode');
  grouping.value = 'area';
  grouping.dispatchEvent(new Event('change'));
  const group = control(root, `project-group-${health.path}`);
  assert.equal(group.getAttribute('aria-label'), 'Health · 1');
  assert.equal(group.getAttribute('aria-expanded'), 'true');
  await click(group);
  assert.equal(control(root, `project-group-${health.path}`).getAttribute('aria-expanded'), 'false');
  assert.ok(!root.all().some((element) => element.dataset.tangrowAction === `project-open-${story.path}`));

  workbench.showProject(story.path);
  await click(control(root, 'project-picker-area'));
  const clear = control(root, 'project-picker-search-area');
  clear.value = 'clear area';
  clear.dispatchEvent(new Event('input'));
  selectOnlyOption(root);
  await click(labelledButton(root, 'Confirm selection'));
  assert.deepEqual(writes, [['area', story.path, health.path], ['area', story.path, null]]);
});

test('Areas route to related projects and return, with area-scoped note and task actions', async () => {
  const story = project('Story');
  const area = areaFixture('30-Area/Work', 'Work', { projects: [story], tasks: [{
    path: '30-Area/Work/Checklist.md', line: 0, done: false, text: 'Review checklist', sourceKind: 'folder', sourceName: 'Checklist'
  }] });
  const { root, opened, showAreas, writes } = fixture([story], [area]);
  showAreas();
  await click(control(root, `area-open-${area.path}`));
  assert.equal(primary(root).getAttribute('aria-label'), 'Open the area note');
  const task = control(root, 'area-task-note-30-Area/Work/Checklist.md:0');
  const name = task.children.find((child) => child.getAttribute('id') === task.getAttribute('aria-labelledby'));
  assert.match(name?.textContent ?? '', /Area folder · Checklist/);
  await click(primary(root));
  await click(labelledButton(root, 'New note in this area'));
  const input = control(root, 'area-task-add');
  input.value = 'Plan the work';
  root.querySelectorAll('form')[0]!.dispatchEvent(new Event('submit'));
  await flush();
  assert.deepEqual(opened, [[area.notePath, undefined]]);
  assert.deepEqual(writes, [['new-area-note', area.path], ['area-task', area.path, 'Plan the work']]);
  await click(control(root, `area-project-${story.path}`));
  assert.equal(control(root, 'project-back').getAttribute('aria-label'), 'Back to area');
  await click(control(root, 'project-back'));
  assert.equal(root.ownerDocument.activeElement, control(root, `area-project-${story.path}`));
});

test('References link selected material in place and the archive hint only reveals or changes status', async () => {
  const story = project('Story');
  const material: WorkbenchLinkCandidate = {
    path: '40-Resources/Research/Clipping.md', name: 'Clipping', role: 'material', location: 'Research', projectPath: null
  };
  const { workbench, root, writes } = fixture([story], [], [material]);
  workbench.showProject(story.path);
  await click(control(root, 'project-picker-references'));
  assert.equal(labelledButton(root, 'Confirm selection').disabled, true);
  selectOnlyOption(root);
  await click(labelledButton(root, 'Confirm selection'));
  assert.equal(control(root, `project-reference-${material.path}`).getAttribute('aria-label'), 'Clipping · Research · Resource');

  await click(labelledButton(root, 'Mark as done'));
  assert.match(root.all().find((element) => element.getAttribute('role') === 'status')?.textContent ?? '', /90-Archive/);
  await click(labelledButton(root, 'Reveal in file list'));
  await click(labelledButton(root, 'Reopen project'));
  assert.deepEqual(writes, [['link', material.path, story.path], ['status', story.path, 'done'], ['reveal', story.path], ['status', story.path, 'open']]);
  assert.equal(story.status, 'open');
  story.status = 'archived';
  workbench.render(root as unknown as HTMLElement);
  assert.ok(labelledButton(root, 'Reveal in file list'));
});

const declaredTypes = [{ key: 'writing', name: 'Writing', count: 2 }, { key: 'podcast', name: 'Podcast', count: 1 }];

test('the project list groups named types case-insensitively and switches to a flat due-date order', async () => {
  const outline = project('Outline', { projectType: 'writing', due: new Date('2030-05-10T00:00:00Z') });
  const chapter = project('Chapter', { projectType: 'Writing', due: null });
  const episode = project('Episode', { projectType: 'Podcast', due: new Date('2030-04-16T00:00:00Z') });
  const other = project('Other', { projectType: null, due: new Date('2030-03-15T00:00:00Z') });
  const { root } = fixture([outline, chapter, episode, other], [], [], { types: declaredTypes });
  const groups = () => root.all().filter((entry) => entry.dataset.tangrowAction?.startsWith('project-type-group-'));
  assert.deepEqual(groups().map((entry) => entry.getAttribute('aria-label')), ['Writing · 2', 'Podcast · 1', 'Uncategorized · 1']);
  await click(control(root, 'project-type-group-writing'));
  const rows = () => root.all().filter((entry) => entry.dataset.tangrowAction?.startsWith('project-open-'));
  assert.equal(rows().length, 2);

  const mode = control(root, 'project-group-mode');
  mode.value = 'due';
  mode.dispatchEvent(new Event('change'));
  assert.equal(groups().length, 0);
  assert.deepEqual(rows().map((entry) => entry.dataset.tangrowAction), [other, episode, outline, chapter].map((entry) => `project-open-${entry.path}`));
});

test('project type edits save an existing choice, freely entered value, or explicit clear without changing continuation', async () => {
  const story = project('Story', { projectType: 'Writing' });
  const { workbench, root, writes } = fixture([story], [], [], { types: declaredTypes });
  workbench.showProject(story.path);
  await click(control(root, 'project-change-type'));
  const suggestions = root.querySelectorAll('select')[0]!;
  suggestions.value = 'Podcast';
  suggestions.dispatchEvent(new Event('change'));
  assert.equal(control(root, 'project-type-input').value, 'Podcast');
  assert.deepEqual(writes, []);
  await click(labelledButton(root, 'Save type'));
  assert.equal(control(root, 'project-change-type').getAttribute('aria-label'), 'Change project type · Podcast');

  await click(control(root, 'project-change-type'));
  const input = control(root, 'project-type-input');
  input.focus();
  input.dispatchEvent(new Event('compositionstart'));
  input.value = ' Animation ';
  workbench.render(root as unknown as HTMLElement);
  assert.equal(control(root, 'project-type-input'), input);
  await click(labelledButton(root, 'Save type'));
  assert.equal(writes.length, 1);
  input.dispatchEvent(new Event('compositionend'));
  await flush();
  assert.equal(control(root, 'project-type-input').value, ' Animation ');
  await click(labelledButton(root, 'Save type'));
  assert.equal(control(root, 'project-change-type').getAttribute('aria-label'), 'Change project type · Animation');
  await click(control(root, 'project-change-type'));
  control(root, 'project-type-input').value = '';
  await click(labelledButton(root, 'Save type'));
  assert.equal(control(root, 'project-change-type').getAttribute('aria-label'), 'Change project type · Uncategorized');
  assert.equal(primary(root).getAttribute('aria-label'), 'Open the project note');
  assert.deepEqual(writes, [['type', story.path, 'Podcast'], ['type', story.path, 'Animation'], ['type', story.path, null]]);
});

test('Drafts opens the scratchpad and links a chosen manuscript without moving it', async () => {
  const story = project('Editing a story', { projectType: 'Writing' });
  const episode = project('Recording an episode', { projectType: 'Podcast' });
  const draft = { path: '00-Inbox/Outline.md', name: 'Outline', folder: '00-Inbox', modified: 1, kind: 'draft' };
  const { root, opened, showDrafts, writes } = fixture([story, episode], [], [], { drafts: [draft] });
  showDrafts();
  await click(control(root, 'draft-scratchpad'));
  await click(control(root, `draft-open-${draft.path}`));
  await click(control(root, `draft-project-link-${draft.path}`));
  const query = control(root, `draft-project-search-${draft.path}`);
  query.value = 'podcast';
  query.dispatchEvent(new Event('input'));
  selectOnlyOption(root);
  assert.deepEqual(writes, [['scratchpad']]);
  await click(labelledButton(root, 'Confirm selection'));
  assert.deepEqual(opened, [[draft.path, undefined]]);
  assert.deepEqual(writes, [['scratchpad'], ['link', draft.path, episode.path]]);
  assert.ok(!root.all().some((entry) => entry.dataset.tangrowAction === `draft-open-${draft.path}`));
  assert.ok(root.all().some((entry) => entry.textContent === 'No drafts yet'));
  assert.equal(root.ownerDocument.activeElement, control(root, 'draft-scratchpad'));
});
