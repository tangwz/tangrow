import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readSettings } from '../src/model';
import type { WorkbenchProject, WorkbenchProjectTask } from '../src/project-workbench-data';
import type { SidebarHost } from '../src/types';

interface ElementOptions { cls?: string; text?: string; attr?: Record<string, string> }
interface MockDocument { activeElement: Element | null }

class Element extends EventTarget {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  readonly classes: Set<string>;
  readonly attributes: Map<string, string>;
  textContent: string;
  disabled = false;
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
  return { path: root, name, notePath: `${root}/${name}.md`, status: 'open', notes: [], tasks: [], due: null, ...data };
}

function fixture(projects: WorkbenchProject[]) {
  const settings = readSettings({ language: 'en' });
  const opened: Array<[string, number | undefined]> = [];
  const added: Array<[string, string]> = [];
  const completed: Array<[string, number, string | undefined]> = [];
  const quickAdd: Array<string | undefined> = [];
  const host = {
    settings,
    workbenchProjects: () => projects,
    openNote: async (path, line) => { opened.push([path, line]); },
    openQuickAdd: (kind) => { quickAdd.push(kind); },
    addProjectTask: async (path, text) => { added.push([path, text]); },
    completeTask: async (path, line, expected) => {
      completed.push([path, line, expected]);
      const entry = projects.flatMap((item) => item.tasks).find((task) => task.path === path && task.line === line);
      if (entry) entry.done = true;
    }
  } satisfies Pick<SidebarHost, 'settings' | 'workbenchProjects' | 'openNote' | 'openQuickAdd' | 'addProjectTask' | 'completeTask'>;
  const root = new Element();
  const ui = new SidebarUI(() => settings.language);
  const render = () => workbench.render(root as unknown as HTMLElement);
  const workbench = new ProjectWorkbench(host as SidebarHost, ui, render);
  render();
  return { workbench, root, opened, added, completed, quickAdd };
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
