import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildWorkbenchCards, type CardFilter } from '../src/card-report-data';
import { createCardReviewQueue, type CardReviewQueue } from '../src/card-review';
import { readSettings } from '../src/model';
import type { ReportRecord } from '../src/report-contract';
import { collectReportResources } from '../src/report-metrics';
import type { WorkbenchProject } from '../src/project-workbench-data';
import type { CaptureSummary, SidebarHost } from '../src/types';
import type { KnowledgeTab } from '../src/workbench-navigation';

interface ElementOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
}

class Element extends EventTarget {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  disabled = false;
  checked = false;
  focused = false;
  value = '';
  textContent: string;
  private readonly attributes: Map<string, string>;
  readonly classes: Set<string>;

  constructor(readonly tag = 'div', options: ElementOptions = {}) {
    super();
    this.attributes = new Map(Object.entries(options.attr ?? {}));
    this.classes = new Set(options.cls?.split(' '));
    this.textContent = options.text ?? '';
  }

  createEl(tag: string, options?: ElementOptions): Element {
    const child = new Element(tag, options);
    this.children.push(child);
    return child;
  }
  createDiv(options?: ElementOptions): Element { return this.createEl('div', options); }
  createSpan(options?: ElementOptions): Element { return this.createEl('span', options); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addClass(name: string): void { this.classes.add(name); }
  empty(): void { this.children = []; }
  all(): Element[] { return [this, ...this.children.flatMap((child) => child.all())]; }
  querySelectorAll(selector: string): Element[] {
    const [tag, cls] = selector.split('.');
    return this.all().slice(1).filter((child) => (!tag || child.tag === tag) && (!cls || child.classes.has(cls)));
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  focus(): void { this.focused = true; }
  get text(): string { return [this.textContent, ...this.children.map((child) => child.text)].join(' '); }
}

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  absWorkingDir: repository,
  stdin: {
    contents: "export { WorkbenchCards } from './src/workbench-cards'; export { SidebarUI } from './src/ui';",
    resolveDir: repository,
    loader: 'ts'
  },
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
  plugins: [{ name: 'mock-workbench-cards-ui', setup(builder) {
    builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(repository, 'tests/obsidian-mock.ts') }));
  } }]
});
const moduleObject: { exports: unknown } = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0]!.text)(moduleObject, moduleObject.exports, createRequire(import.meta.url));
const { WorkbenchCards, SidebarUI } = moduleObject.exports as typeof import('../src/workbench-cards') & typeof import('../src/ui');

const now = new Date(2026, 10, 27, 12).getTime();
function capture(name: string, offset: number, processed = false): CaptureSummary {
  return { name, path: `00-Inbox/${name}.md`, folder: '00-Inbox', created: now - offset, modified: now, processed };
}

function card(name: string, linkedTo?: ReportRecord): ReportRecord {
  return {
    path: `50-Zettel/${name}.md`, name, created: now, modified: now, frontmatter: { tangrow_kind: 'card' },
    knowledge: {
      body: linkedTo ? [{ path: linkedTo.path, raw: linkedTo.path, anchor: '' }] : [],
      sources: [], legacySources: [], parent: [], materials: [], captureResults: []
    }
  };
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

function fixture(options: { captures?: CaptureSummary[]; records?: ReportRecord[]; completed?: boolean; projects?: WorkbenchProject[] } = {}) {
  const settings = readSettings({ language: 'en' });
  const { workspace: knowledge, report, materials, hubs } = buildWorkbenchCards(options.records ?? [], settings, true, now);
  const events: string[][] = [];
  const projectLinks = new Map<string, string>();
  let queue: CardReviewQueue | null = options.completed ? createCardReviewQueue(knowledge) : null;
  if (queue) queue.completed = queue.entries.map(({ path }) => path);
  const host = {
    settings,
    snapshot: () => ({ captures: options.captures ?? [] }),
    loadWorkbenchCards: async () => ({ knowledge, report, materials, hubs }),
    workbenchResources: () => collectReportResources(options.records ?? [], settings.resourcesFolder, [], now),
    workbenchProjects: () => options.projects ?? [],
    workbenchLinkCandidates: () => materials.map(({ note }) => ({ path: note.path, projectPath: projectLinks.get(note.path) })),
    linkWorkbenchNote: async (notePath: string, projectPath: string) => {
      projectLinks.set(notePath, projectPath);
      events.push(['link', notePath, projectPath]);
    },
    readCapture: async (path: string) => `---\ntangrow_kind: capture\n---\n\nCapture body for ${options.captures?.find((entry) => entry.path === path)?.name ?? path}.`,
    openQuickAdd: (kind: string) => { events.push(['quick-add', kind]); },
    openCardFromCapture: async (path: string) => { events.push(['distill', path]); return true; },
    openNewHub: () => { events.push(['new-hub']); },
    openCardReport: async (filter: CardFilter) => { events.push(['report', filter]); },
    loadCardReview: () => queue,
    saveCardReview: async (next: CardReviewQueue) => queue = structuredClone(next),
    markCardReviewed: async (path: string, day: string, entry: string) => {
      if (queue?.day === day) queue.completed.push(entry);
      events.push(['reviewed', path]);
    }
  } as unknown as SidebarHost;
  const root = new Element();
  let view: KnowledgeTab = 'cards';
  const renderCurrent = () => workbench.renderKnowledge(root as unknown as HTMLElement, view);
  const workbench = new WorkbenchCards(host, new SidebarUI(() => settings.language), renderCurrent,
    (tab) => { events.push(['knowledge', tab]); }, () => undefined, () => undefined, () => { events.push(['captures']); });
  return {
    root, events,
    async render(tab: KnowledgeTab) {
      view = tab;
      workbench.refresh(tab === 'review');
      await flush();
    }
  };
}

function button(root: Element, label: string | RegExp): Element {
  const control = root.all().find((element) => element.tag === 'button'
    && (typeof label === 'string' ? element.getAttribute('aria-label') === label : label.test(element.text)));
  assert.ok(control, `Expected a ${label} button`);
  return control;
}

function primary(root: Element): Element {
  const controls = root.all().filter((element) => element.tag === 'button' && element.classes.has('mod-cta'));
  assert.equal(controls.length, 1);
  return controls[0]!;
}

async function click(control: Element): Promise<void> {
  assert.equal(control.disabled, false);
  control.dispatchEvent(new Event('click'));
  await flush();
}

test('empty Cards with captures offers distillation for the two most recent sources and a blank card', async () => {
  const captures = [capture('Most recent thought', 0, true), capture('Second thought', 1), capture('Older thought', 2)];
  const { root, events, render } = fixture({ captures: [...captures].reverse() });
  await render('cards');
  assert.match(root.text, /Write your first card/);
  assert.match(root.text, /Capture body for Most recent thought/);
  assert.doesNotMatch(root.text, /Older thought|tangrow_kind/);

  const newest = button(root, /Most recent thought/);
  const second = button(root, /Second thought/);
  assert.match(newest.getAttribute('aria-label') ?? '', /^Distill capture: Most recent thought/);
  assert.match(second.getAttribute('aria-label') ?? '', /^Distill capture: Second thought/);
  await click(newest);
  await click(second);
  await click(button(root, 'Blank card'));
  assert.deepEqual(events, [['distill', captures[0]?.path], ['distill', captures[1]?.path], ['quick-add', 'card']]);
});

test('Materials groups resource notes and links a single note using a searchable project picker', async () => {
  const material = { path: '40-Resources/Methods/Reference.md', name: 'Reference', created: now, modified: now };
  const projects = ['First project', 'Second project'].map((name): WorkbenchProject => ({
    path: `20-Project/${name}`, name, notePath: `20-Project/${name}/${name}.md`, status: 'open',
    notes: [], tasks: [], due: null, areaPath: null, references: []
  }));
  const { root, events, render } = fixture({ records: [material], projects });
  await render('materials');
  assert.match(root.text, /Methods/);
  await click(button(root, 'Use in project'));
  const search = root.querySelector('input.tangrow-material-project-search');
  assert.ok(search?.focused);
  search.value = 'Second';
  search.dispatchEvent(new Event('input'));
  const [option] = root.querySelectorAll('input').filter((input) => input !== search);
  assert.ok(option);
  option.checked = true;
  option.dispatchEvent(new Event('change'));
  await click(button(root, 'Confirm selection'));
  assert.deepEqual(events, [['link', material.path, projects[1]!.path]]);
  assert.ok(button(root, 'Use in project').focused);
  assert.match(root.text, /Currently in Second project/);
});

test('empty Cards without captures leads to Captures and still offers a blank card', async () => {
  const { root, events, render } = fixture();
  await render('cards');
  assert.match(root.text, /Write your first card/);

  assert.equal(primary(root).getAttribute('aria-label'), 'Capture your first thought');
  await click(button(root, 'Capture your first thought'));
  await click(button(root, 'Blank card'));
  assert.deepEqual(events, [['captures'], ['quick-add', 'card']]);
});

test('empty Hubs guides users to Cards below three cards and offers a new hub at three', async () => {
  const records = [card('One'), card('Two'), card('Three')];
  const belowThreshold = fixture({ records: records.slice(0, 2) });
  await belowThreshold.render('hubs');
  assert.match(belowThreshold.root.text, /No hubs yet/);
  await click(primary(belowThreshold.root));
  assert.deepEqual(belowThreshold.events, [['knowledge', 'cards']]);

  const atThreshold = fixture({ records });
  await atThreshold.render('hubs');
  await click(primary(atThreshold.root));
  assert.deepEqual(atThreshold.events, [['new-hub']]);
});

test('empty Review leads to the latest capture or to Captures', async () => {
  const latest = capture('Latest thought', 0);
  const withCaptures = fixture({ captures: [latest, capture('Earlier thought', 1)] });
  await withCaptures.render('review');
  assert.match(withCaptures.root.text, /Review starts with cards/);
  assert.equal(primary(withCaptures.root).getAttribute('aria-label'), 'Distill your first card');
  await click(primary(withCaptures.root));
  assert.deepEqual(withCaptures.events, [['distill', latest.path]]);

  const fresh = fixture();
  await fresh.render('review');
  await click(primary(fresh.root));
  assert.deepEqual(fresh.events, [['captures']]);
});

test('completing Review acknowledges the result and opens the unlinked-card report when available', async () => {
  const only = card('My first card');
  const { root, events, render } = fixture({ records: [only] });
  await render('review');
  await click(button(root, 'Mark reviewed'));
  const status = root.all().find((element) => element.getAttribute('role') === 'status');
  assert.match(status?.text ?? '', /review (?:is )?(?:done|complete)/i);
  await click(button(root, /unlinked|awaiting connections/i));
  assert.deepEqual(events, [['reviewed', only.path], ['report', 'isolated']]);

  const linked = fixture({ records: [only, card('Connected card', only)], completed: true });
  await linked.render('review');
  assert.match(linked.root.text, /review (?:is )?(?:done|complete)/i);
  assert.equal(linked.root.all().some((element) => element.tag === 'button' && /unlinked|awaiting connections/i.test(element.text)), false);
});
