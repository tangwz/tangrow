import { ItemView, Notice, setIcon, setTooltip, type WorkspaceLeaf } from 'obsidian';
import { baseDefinitions } from './bases';
import { renderActivityHeatmaps, type ActivityViewState } from './activity-view';
import { captureCreated } from './capture-data';
import { describeError, translate, type TranslationValues } from './i18n';
import { dayKey, inFolder, recentDays, safeFolder } from './model';
import type { CompletionSummary, EditableReportStatus, ReportData, ReportDestination, ReportEntity, ReportPage, ReportRange, ReportRecord, ReportSnapshot, ReportStatus, ReportStatusChange, ReportTask, ReportTaskStatus } from './report-contract';
import { reportTrendDay } from './report-data';
import { ReportKnowledgeView } from './report-knowledge-view';
import { canonicalEntityNotes, hasReportStatus, reportJournalDay, reportRecordStatus, reportStatusSource, sampleReportNotes } from './report-metrics';
import type { SidebarHost } from './types';

export const REPORT_VIEW_TYPE = 'tangrow-report';
const PAGE_SIZE = 20;
const RANGES = [7, 30, 90, 180, 365] as const;
const TIME_RANGES: ReportRange[] = [1, ...RANGES];
const PAGES: Array<{ id: ReportPage; label: string; icon: string; groupStart?: boolean }> = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { id: 'actions', label: 'Actions', icon: 'list-checks', groupStart: true },
  { id: 'tasks', label: 'Tasks', icon: 'square-check' },
  { id: 'projects', label: 'Projects', icon: 'folder-kanban', groupStart: true },
  { id: 'areas', label: 'Areas', icon: 'layers' },
  { id: 'resources', label: 'Resources', icon: 'library' },
  { id: 'notes', label: 'Notes', icon: 'files', groupStart: true },
  { id: 'time', label: 'Time', icon: 'clock' }
];
const SERIES = [
  { key: 'notes', label: 'Notes' }, { key: 'tasks', label: 'Tasks' },
  { key: 'projects', label: 'Projects' }, { key: 'clips', label: 'Clips' },
  { key: 'captures', label: 'Saved captures' }
] as const;
type SeriesKey = typeof SERIES[number]['key'];
type FilterStatus = ReportStatus | 'cancelled' | 'all';
type ResourceTab = 'items' | 'clips' | 'materials';
type NoteTab = 'all' | 'cards' | 'drafts';
type ReportDays = { from: string; to: string };
type NoteLocation = { path: string; file?: boolean };
interface PageSelection {
  resourceTab?: ResourceTab;
  noteTab?: NoteTab;
  status?: FilterStatus;
  role?: string;
  dates?: ReportDays;
  location?: NoteLocation;
  focus?: string;
}
const TREND_DESTINATIONS: Record<SeriesKey, { page: ReportPage; selection?: PageSelection }> = {
  notes: { page: 'notes' }, tasks: { page: 'tasks' }, projects: { page: 'projects' },
  clips: { page: 'resources', selection: { resourceTab: 'clips' } },
  captures: { page: 'notes', selection: { role: 'captures' } }
};
type ResourceSort = 'modified' | 'notes' | 'name';
const RECORD_STATUSES = [['open', 'Open'], ['done', 'Done'], ['archived', 'Archived']] as const;
const TASK_STATUSES = [[' ', 'Open'], ['/', 'In progress'], ['x', 'Done'], ['-', 'Cancelled']] as const;

export class TangrowReport extends ItemView {
  private readonly instanceId = `tangrow-report-${crypto.randomUUID()}`;
  private unsubscribe?: () => void;
  private refreshTimer?: number;
  private epoch = 0;
  private mounted = false;
  private composing = false;
  private loading = false;
  private snapshot?: ReportSnapshot;
  private page: ReportPage = 'overview';
  private overviewRange: typeof RANGES[number] = 30;
  private timeRange: ReportRange = 30;
  private snapshotRange?: ReportRange;
  private resourceTab: ResourceTab = 'items';
  private resourceSort: ResourceSort = 'modified';
  private noteTab: NoteTab = 'all';
  private dates?: ReportDays;
  private location?: NoteLocation;
  private query = '';
  private statusFilter: FilterStatus = 'all';
  private noteRole = 'all';
  private listPage = 0;
  private visibleSeries = new Set<SeriesKey>(SERIES.map(({ key }) => key));
  private showTrendValues = false;
  private walkPaths: string[] = [];
  private walkIndex = 0;
  private exclusionsDraft?: string;
  private goalDraft?: string;
  private readonly pendingStatuses = new Set<string>();
  private readonly pendingHabits = new Set<string>();
  private readonly activityState: ActivityViewState = { year: new Date().getFullYear(), focusedDays: {}, scrollPositions: {} };
  private readonly knowledge: ReportKnowledgeView;

  constructor(leaf: WorkspaceLeaf, private readonly host: SidebarHost) {
    super(leaf);
    this.knowledge = new ReportKnowledgeView(host, (filter, dates) => this.navigate({ page: 'cards', filter, dates }),
      () => this.selectPage('overview', { focus: '[data-card-trend-destination]' }), () => this.render());
  }
  getViewType(): string { return REPORT_VIEW_TYPE; }
  getDisplayText(): string { return this.t('Vault overview'); }
  getIcon(): string { return 'chart-no-axes-combined'; }

  async onOpen(): Promise<void> {
    this.mounted = true;
    this.contentEl.addClass('tangrow-report');
    this.unsubscribe = this.host.subscribe(() => this.scheduleRefresh());
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.mounted = false;
    this.composing = false;
    this.knowledge.composing = false;
    this.epoch++;
    window.clearTimeout(this.refreshTimer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.contentEl.empty();
  }

  refreshLanguage(): void { this.render(); }
  navigate(destination: ReportDestination): void {
    if (destination.page === 'cards' && this.host.settings.knowledgeEnabled) {
      this.knowledge.selectCards(destination.filter, destination.dates);
      const focus = destination.dates || destination.filter && destination.filter !== 'all' ? '[data-card-list-destination]' : '[data-card-destination]';
      this.selectPage('notes', { noteTab: 'cards', focus });
    } else this.selectPage('overview');
  }

  private t(source: string, values?: TranslationValues): string { return translate(this.host.settings.language, source, values); }
  private number(value: number, decimals = 2): string { return value.toLocaleString(this.host.settings.language, { maximumFractionDigits: decimals }); }
  private date(value: number | null): string { return value !== null && Number.isFinite(value) ? new Date(value).toLocaleDateString(this.host.settings.language) : this.t('Unknown'); }
  private get range(): ReportRange { return this.page === 'time' ? this.timeRange : this.overviewRange; }
  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => { void this.refresh(); }, 180);
  }

  private async refresh(): Promise<void> {
    const revision = ++this.epoch;
    this.loading = true;
    const range = this.range;
    if (!this.snapshot) this.contentEl.setText(this.t('Loading your local report...'));
    else this.render();
    try {
      const snapshot = await this.host.loadReport(range);
      if (!this.mounted || revision !== this.epoch) return;
      this.snapshot = snapshot;
      this.snapshotRange = range;
      const paths = new Set(snapshot.data.notes.filter((note) => !inFolder(note.path, this.host.settings.archiveFolder)).map((note) => note.path));
      this.walkPaths = this.walkPaths.filter((path) => paths.has(path));
      this.walkIndex = Math.max(0, Math.min(this.walkIndex, this.walkPaths.length - 1));
      if (!this.walkPaths.length) this.shuffleWalk();
      this.loading = false;
      this.render();
    } catch (error) {
      if (!this.mounted || revision !== this.epoch) return;
      this.loading = false;
      new Notice(describeError(this.host.settings.language, error));
      if (this.snapshot) this.render();
      else {
        this.contentEl.empty();
        this.contentEl.createEl('p', { text: this.t('Could not load the report.') });
        this.control(this.contentEl, 'Retry report', 'refresh-cw', () => this.refresh());
      }
    }
  }

  private control(parent: HTMLElement, source: string, icon: string, run: () => void | Promise<void>, values?: TranslationValues, userText = false): HTMLButtonElement {
    const text = userText ? source : this.t(source, values);
    const button = parent.createEl('button', { cls: 'tangrow-report-control', attr: { type: 'button', 'aria-label': text } });
    button.dataset.reportFocus = `control-${source}`;
    if (icon) setIcon(button.createSpan({ cls: 'tangrow-report-icon' }), icon);
    button.createSpan({ text });
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      void Promise.resolve().then(run).catch((error: unknown) => new Notice(describeError(this.host.settings.language, error))).finally(() => { button.disabled = false; });
    });
    return button;
  }

  private panel(parent: HTMLElement, title: string, detail?: string): HTMLElement {
    const panel = parent.createEl('section', { cls: 'tangrow-report-panel' });
    panel.createEl('h2', { text: this.t(title) });
    if (detail) this.caption(panel, detail);
    return panel;
  }
  private caption(parent: HTMLElement, source: string, values?: TranslationValues): HTMLElement {
    return parent.createEl('p', { cls: 'tangrow-report-caption', text: this.t(source, values) });
  }
  private metric(parent: HTMLElement, label: string, value: number | string, icon: string, open?: () => void | Promise<void>): HTMLElement {
    const card = parent.createDiv({ cls: 'tangrow-report-metric' });
    const heading = card.createDiv({ cls: 'tangrow-report-metric-label' });
    setIcon(heading.createSpan({ cls: 'tangrow-report-icon' }), icon);
    heading.createSpan({ text: this.t(label) });
    const text = typeof value === 'number' ? this.number(value) : value;
    const count = card.createEl('strong', open ? undefined : { text });
    if (open) this.countLink(count, text, label, open);
    return card;
  }
  private countLink(parent: HTMLElement, text: string, label: string, open: () => void | Promise<void>): HTMLButtonElement {
    const button = this.control(parent, text, '', open, undefined, true);
    button.addClass('tangrow-report-count-link');
    button.dataset.reportFocus = `count-${label}`;
    button.setAttribute('aria-label', `${this.t(label)} · ${text}`);
    return button;
  }
  private detail(parent: HTMLElement, source: string, values?: TranslationValues): HTMLElement {
    return parent.createEl('p', { cls: 'tangrow-report-metric-detail', text: this.t(source, values) });
  }
  private hint(target: HTMLElement, source: string, values?: TranslationValues): void {
    setTooltip(target, this.t(source, values));
  }
  private progress(parent: HTMLElement, ratio: number, label: string): void {
    parent.createEl('progress', { attr: { max: '1', value: String(Math.max(0, Math.min(1, ratio))), 'aria-label': label } });
  }
  private completion(parent: HTMLElement, summary: CompletionSummary, rateInHeading = false): void {
    const excluded = [
      summary.unknown ? this.t('{count} unknown states excluded', { count: this.number(summary.unknown) }) : '',
      summary.archived ? this.t('{count} archived excluded', { count: this.number(summary.archived) }) : '',
      summary.cancelled ? this.t('{count} cancelled excluded', { count: this.number(summary.cancelled) }) : ''
    ].filter(Boolean).join('\n');
    let line: HTMLElement | undefined;
    if (summary.rate === null) {
      if (!rateInHeading) line = this.detail(parent, 'No known completion state');
    } else {
      const percent = this.number(summary.rate * 100, 1);
      const ratio = `${this.number(summary.done)} / ${this.number(summary.denominator)}`;
      line = parent.createEl('p', { cls: 'tangrow-report-metric-detail', text: rateInHeading ? ratio : `${this.t('Completion: {percent}%', { percent })} · ${ratio}` });
      this.progress(parent, summary.rate, this.t('Completion: {percent}%', { percent }));
    }
    if (line && excluded) setTooltip(line, excluded);
  }

  private render(): void {
    if (!this.mounted || !this.snapshot || this.composing || this.knowledge.composing) return;
    if (this.page === 'notes' && this.noteTab === 'cards' && !this.host.settings.knowledgeEnabled) {
      this.page = 'overview';
      this.noteTab = 'all';
      this.contentEl.scrollTop = 0;
    }
    const active = this.contentEl.ownerDocument.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
    const focusKey = this.contentEl.contains(active) ? active?.dataset.reportFocus : undefined;
    const activityFocus = this.contentEl.contains(active) ? active?.dataset.activityFocus : undefined;
    const selection = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA'
      ? { start: (active as HTMLInputElement).selectionStart, end: (active as HTMLInputElement).selectionEnd } : null;
    const scrollTop = this.contentEl.scrollTop;
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: 'tangrow-report-shell' });
    this.renderHeader(shell);
    const body = shell.createDiv({ cls: 'tangrow-report-page', attr: { role: 'tabpanel', id: `${this.instanceId}-pane`, 'aria-labelledby': `${this.instanceId}-${this.page}` } });
    const { data } = this.snapshot;
    switch (this.page) {
      case 'overview': this.renderOverview(body, data); break;
      case 'actions': this.renderActions(body, data); break;
      case 'tasks': this.renderTasks(body, data); break;
      case 'projects': this.renderEntities(body, data.projects, 'projects'); break;
      case 'notes': this.renderNotes(body, data); break;
      case 'resources': this.renderResources(body, data); break;
      case 'areas': this.renderEntities(body, data.areas, 'areas'); break;
      case 'time':
        if (this.snapshotRange === this.timeRange) this.renderTime(body);
        else this.renderPendingRange(body);
        this.renderFocusRecords(body, data);
        break;
    }
    const footer = shell.createDiv({ cls: 'tangrow-report-footer' });
    if (this.snapshot.quality.unreadable) this.caption(footer, '{count} notes could not be read; word totals may be incomplete.', { count: this.number(this.snapshot.quality.unreadable) });
    if (!this.snapshot.quality.linksReady) this.caption(footer, 'Link indexing is still in progress; orphan results may change.');
    this.contentEl.scrollTop = scrollTop;
    if (activityFocus) {
      const replacement = Array.from(this.contentEl.querySelectorAll<HTMLElement>('[data-activity-focus]')).find((element) => element.dataset.activityFocus === activityFocus);
      replacement?.focus({ preventScroll: true });
    }
    if (focusKey) {
      const replacement = Array.from(this.contentEl.querySelectorAll<HTMLElement>('[data-report-focus]')).find((element) => element.dataset.reportFocus === focusKey);
      replacement?.focus({ preventScroll: true });
      if (replacement?.dataset.cardTrendDestination !== undefined) replacement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (selection && replacement && (replacement.tagName === 'INPUT' || replacement.tagName === 'TEXTAREA')) {
        const input = replacement as HTMLInputElement;
        if (selection.start !== null && selection.end !== null && input.type !== 'number') input.setSelectionRange(selection.start, selection.end);
      }
    }
  }

  private renderHeader(parent: HTMLElement): void {
    const header = parent.createDiv({ cls: 'tangrow-report-header' });
    const intro = header.createDiv();
    intro.createSpan({ cls: 'tangrow-report-eyebrow', text: this.t('LOCAL REPORT') });
    intro.createEl('h1', { text: this.t('Vault overview') });
    const toolbar = header.createDiv({ cls: 'tangrow-report-toolbar' });
    toolbar.createSpan({ cls: 'tangrow-report-updated', text: this.t('Refreshed at {time}', { time: new Date(this.snapshot!.generatedAt).toLocaleTimeString(this.host.settings.language, { hour: '2-digit', minute: '2-digit' }) }) });
    const refresh = this.control(toolbar, this.loading ? 'Updating report...' : 'Refresh report', 'refresh-cw', () => this.refresh());
    refresh.disabled = this.loading;
    refresh.dataset.reportFocus = 'refresh';
    refresh.addClass('tangrow-report-refresh');
    refresh.setAttribute('aria-busy', String(this.loading));
    setTooltip(refresh, this.t(this.loading ? 'Updating report...' : 'Refresh report'));
    const nav = parent.createDiv({ cls: 'tangrow-report-nav', attr: { role: 'tablist', 'aria-label': this.t('Report pages') } });
    for (const [index, page] of PAGES.entries()) {
      if (page.groupStart) nav.createSpan({ cls: 'tangrow-report-nav-separator', attr: { 'aria-hidden': 'true' } });
      const button = this.control(nav, page.label, page.icon, () => this.selectPage(page.id));
      button.addClass('tangrow-report-nav-item');
      button.toggleClass('is-active', this.page === page.id);
      button.dataset.page = page.id;
      button.dataset.reportFocus = `tab-${page.id}`;
      button.id = `${this.instanceId}-${page.id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', `${this.instanceId}-pane`);
      button.setAttribute('aria-selected', String(this.page === page.id));
      button.tabIndex = this.page === page.id ? 0 : -1;
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? PAGES.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + PAGES.length) % PAGES.length;
        const target = PAGES[next];
        if (target) { this.selectPage(target.id); this.contentEl.querySelector<HTMLElement>(`[data-page="${target.id}"]`)?.focus(); }
      });
    }
  }

  private renderRangeHeading(parent: HTMLElement): void {
    const heading = parent.createDiv({ cls: 'tangrow-report-panel-heading' });
    heading.createEl('h2', { text: this.t(this.page === 'time' ? 'Editing activity' : 'Creation trends') });
    this.renderRanges(heading);
  }

  private renderRanges(parent: HTMLElement): void {
    const ranges = parent.createDiv({ cls: 'tangrow-report-range', attr: { role: 'group', 'aria-label': this.t(this.page === 'time' ? 'Editing activity date range' : 'Overview date range') } });
    for (const range of this.page === 'time' ? TIME_RANGES : RANGES) {
      const label = range === 1 ? this.t('Today') : this.t('Last {count} days', { count: range });
      const button = this.control(ranges, range === 365 ? this.t('1 year') : range === 1 ? label : this.t('{count} days', { count: range }), '', async () => {
        if (this.page === 'time') this.timeRange = range;
        else if (range !== 1) this.overviewRange = range;
        await this.refresh();
      }, undefined, true);
      button.setAttribute('aria-label', label);
      button.addClass('tangrow-report-range-button');
      button.toggleClass('is-active', this.range === range);
      button.setAttribute('aria-pressed', String(this.range === range));
      button.dataset.reportFocus = `range-${range}`;
    }
  }

  private selectPage(page: ReportPage, selection: PageSelection = {}): void {
    const previousRange = this.range;
    this.page = page;
    if (page === 'resources') this.resourceTab = selection.resourceTab ?? 'items';
    if (page === 'notes') this.noteTab = selection.noteTab ?? 'all';
    const refreshInterrupted = previousRange !== this.range && this.loading;
    if (previousRange !== this.range) {
      this.epoch++;
      this.loading = false;
    }
    this.query = '';
    this.statusFilter = selection.status ?? 'all';
    this.noteRole = selection.role ?? 'all';
    this.dates = selection.dates;
    this.location = selection.location;
    this.listPage = 0;
    this.contentEl.scrollTop = 0;
    this.render();
    const focus = selection.focus ?? (selection.dates || selection.location || selection.role || selection.status ? '[data-report-focus="search"]' : undefined);
    const target = (focus && this.contentEl.querySelector<HTMLElement>(focus)) || this.contentEl.querySelector<HTMLElement>(`[data-page="${page}"]`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (this.mounted && !this.loading && (refreshInterrupted || this.snapshotRange !== this.range)) void this.refresh();
  }

  private renderOverview(parent: HTMLElement, data: ReportData): void {
    const rangeReady = this.snapshotRange === this.overviewRange;
    if (rangeReady) this.renderTrends(parent, data);
    else this.renderPendingRange(parent.createEl('section', { cls: 'tangrow-report-panel' }));
    const inventory = this.overviewGroup(parent, 'Notes and actions');
    const note = this.metric(inventory, 'Notes total', data.counts.notes, 'files', () => this.selectPage('notes'));
    this.gain(note, data.gains90.notes, 'notes');
    const tasks = this.metric(inventory, 'Tasks total', data.counts.tasks, 'square-check', () => this.selectPage('tasks'));
    this.completion(tasks, data.completion.tasks);
    const projects = this.metric(inventory, 'Project entities', data.counts.projects, 'folder-kanban', () => this.selectPage('projects'));
    this.completion(projects, data.completion.projects);
    this.gain(projects, data.gains90.projects, 'projects');
    const areas = this.metric(inventory, 'Area entities', data.counts.areas, 'layers', () => this.selectPage('areas'));
    this.completion(areas, data.completion.areas);
    this.gain(areas, data.gains90.areas, 'areas');
    const clips = this.metric(inventory, 'Clips total', data.counts.clips, 'bookmark', () => this.selectPage('resources', { resourceTab: 'clips' }));
    this.completion(clips, data.completion.clips);
    this.gain(clips, data.gains90.clips, 'resources', { resourceTab: 'clips' });
    const resources = this.metric(inventory, 'Resource entries', data.resources.length, 'library', () => this.selectPage('resources'));
    const location = { path: this.host.settings.resourcesFolder };
    this.countLink(this.detail(resources, ''), this.t('{count} resource notes', { count: this.number(data.counts.resourceNotes) }), 'Resource notes', () => this.selectPage('notes', { location }));
    this.gain(resources, data.gains90.resourceNotes, 'notes', { location });
    this.metric(inventory, 'Manuscripts', data.counts.drafts, 'file-pen-line', () => this.selectPage('notes', { noteTab: 'drafts' }));
    const words = this.metric(inventory, 'Word and character totals', this.t('{count} words', { count: this.number(data.counts.words) }), 'text', () => this.selectPage('notes'));
    this.detail(words, '{count} characters excluding whitespace', { count: this.number(data.counts.characters) });

    const records = this.overviewGroup(parent, 'Records and time');
    const openTime = (): void => this.selectPage('time');
    const activity = rangeReady ? this.renderActivityMetric(records, openTime)
      : this.metric(records, 'Most active hour', this.t(this.loading ? 'Updating...' : 'Could not load editing activity.'), 'clock', openTime);
    const focusRecords = '[data-report-focus="focus-records"]';
    this.countLink(this.detail(activity, ''), this.t('Saved focus time: {count} minutes', { count: this.number(data.counts.focusMinutes) }), 'Browse saved focus records', () => this.selectPage('time', { focus: focusRecords }));
    const journal = this.metric(records, 'Journal streak', this.t('{count} consecutive days', { count: this.number(data.streaks.journal.current) }), 'calendar-days', () => this.selectPage('notes', { role: 'journals' }));
    this.detail(journal, 'Longest streak: {count} days', { count: this.number(data.streaks.journal.longest) });
    this.heatmap(journal, data.streaks.journal.days, 'journals');
    const captures = this.metric(records, 'Saved captures', data.counts.captures, 'inbox', () => this.selectPage('notes', { role: 'captures' }));
    this.detail(captures, '{count} consecutive days', { count: this.number(data.streaks.captures.current) });
    this.gain(captures, data.gains90.captures, 'notes', { role: 'captures' });
    this.heatmap(captures, data.streaks.captures.days, 'captures');
    const habits = this.metric(records, 'Habit check-ins today', this.t('{done} / {total}', { done: this.number(data.habits.todayCompleted), total: this.number(data.habits.target) }), 'calendar-check', () => this.selectPage('actions', { focus: '[data-report-focus="today-habits"]' }));
    this.heatmap(habits, data.habits.days.map(({ day, completed, target }) => ({ day, count: completed, target })));
    if (!data.habits.target) this.detail(habits, 'No active habits configured');

    const discovery = this.overviewGroup(parent, 'Review and discovery');
    discovery.addClass('tangrow-report-discovery');
    const orphans = this.snapshot!.quality.linksReady
      ? this.metric(discovery, 'Orphan notes', data.counts.orphans, 'unlink', () => this.selectPage('notes', { role: 'orphans' }))
      : this.metric(discovery, 'Orphan notes', this.t('Pending confirmation'), 'unlink');
    this.hint(orphans, 'No incoming or outgoing resolved note links.');
    this.randomOrphan(orphans, data);
    const walkIndex = this.walkPaths.length ? this.walkIndex + 1 : 0;
    this.renderWalk(this.metric(discovery, 'Random walk', this.t('{index} / {total}', { index: this.number(walkIndex), total: this.number(this.walkPaths.length) }), 'shuffle'), data);

    if (this.host.settings.knowledgeEnabled) this.knowledge.renderOverview(parent, this.snapshot!, this.overviewRange);
  }

  private overviewGroup(parent: HTMLElement, title: string): HTMLElement {
    const group = parent.createEl('section', { cls: 'tangrow-report-overview-group' });
    group.createEl('h2', { text: this.t(title) });
    return group.createDiv({ cls: 'tangrow-report-metrics' });
  }

  private renderPendingRange(parent: HTMLElement): void {
    this.renderRangeHeading(parent);
    this.caption(parent, this.loading ? 'Loading your local report...' : 'Could not load the report.');
    if (!this.loading) this.control(parent, 'Retry report', 'refresh-cw', () => this.refresh());
  }

  private gain(parent: HTMLElement, count: number, page: ReportPage, selection: PageSelection = {}): void {
    const days = recentDays(90, this.snapshot!.generatedAt);
    const dates = { from: days[0]!, to: days.at(-1)! };
    const text = this.t('Created in the last 90 days: +{count}', { count: this.number(count) });
    const button = this.countLink(this.detail(parent, ''), text, 'Creation trends', () => this.selectPage(page, { ...selection, dates }));
    button.dataset.reportFocus = `gain-${page}-${selection.resourceTab ?? selection.role ?? selection.location?.path ?? ''}`;
  }

  private heatmap(parent: HTMLElement, days: Array<{ day: string; count: number; target?: number }>, role?: 'journals' | 'captures'): void {
    this.detail(parent, 'Fourteen-day history');
    const describe = (day: typeof days[number]): string => day.target === undefined
      ? this.t('{date}: {count} records', { date: day.day, count: this.number(day.count) })
      : this.t('{date}: {done} / {target} habits', { date: day.day, done: this.number(day.count), target: this.number(day.target) });
    const grid = parent.createDiv({ cls: 'tangrow-report-heatmap', attr: {
      role: role ? 'group' : 'img', 'aria-label': role ? this.t('Fourteen-day history') : `${this.t('Fourteen-day history')}: ${days.map(describe).join('; ')}`
    } });
    for (const day of days) {
      const label = describe(day);
      const complete = day.count > 0 && (day.target === undefined || day.count >= day.target);
      const cls = `tangrow-report-day${complete ? ' is-complete' : day.count > 0 ? ' is-partial' : ''}`;
      if (role && day.count) {
        const button = grid.createEl('button', { cls, attr: { type: 'button', 'aria-label': label } });
        button.dataset.reportFocus = `history-${role}-${day.day}`;
        button.addEventListener('click', () => this.selectPage('notes', { role, dates: { from: day.day, to: day.day } }));
        setTooltip(button, label);
      } else setTooltip(grid.createSpan({ cls, attr: role ? { role: 'img', 'aria-label': label } : undefined }), label);
    }
    setTooltip(grid, this.t('Oldest to newest, including today.'));
  }

  private renderTrends(parent: HTMLElement, data: ReportData): void {
    const panel = parent.createEl('section', { cls: 'tangrow-report-panel' });
    this.renderRangeHeading(panel);
    const legend = panel.createDiv({ cls: 'tangrow-report-legend' });
    for (const series of SERIES) {
      const count = data.trends.reduce((sum, day) => sum + day[series.key], 0);
      const button = this.control(legend, `${this.t(series.label)} · ${this.number(count)}`, '', () => {
        if (this.visibleSeries.has(series.key)) this.visibleSeries.delete(series.key); else this.visibleSeries.add(series.key);
        this.render();
      }, undefined, true);
      button.dataset.series = series.key;
      button.dataset.reportFocus = `series-${series.key}`;
      button.setAttribute('aria-pressed', String(this.visibleSeries.has(series.key)));
      button.disabled = this.visibleSeries.size === 1 && this.visibleSeries.has(series.key);
      if (series.key === 'tasks') this.hint(button, 'Tasks are grouped by the creation date of their source notes.');
    }
    const svg = panel.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.addClass('tangrow-report-trend');
    svg.setAttribute('viewBox', '0 0 600 180');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', this.t('Creation trends'));
    const selected = SERIES.filter(({ key }) => this.visibleSeries.has(key));
    const maximum = Math.max(1, ...data.trends.flatMap((day) => selected.map(({ key }) => day[key])));
    const y = (value: number): number => 170 - value / maximum * 155;
    for (let tick = 0; tick <= 4; tick++) {
      const gridline = panel.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
      const position = String(y(maximum * tick / 4));
      gridline.addClass('tangrow-report-gridline');
      gridline.setAttribute('x1', '10');
      gridline.setAttribute('x2', '590');
      gridline.setAttribute('y1', position);
      gridline.setAttribute('y2', position);
      gridline.setAttribute('aria-hidden', 'true');
      svg.appendChild(gridline);
    }
    for (const series of selected) {
      const line = panel.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.addClass('tangrow-report-series');
      line.dataset.series = series.key;
      line.setAttribute('fill', 'none');
      line.setAttribute('points', data.trends.map((day, index) => `${data.trends.length === 1 ? 300 : 10 + index / (data.trends.length - 1) * 580},${y(day[series.key])}`).join(' '));
      svg.appendChild(line);
      if (data.trends.length === 1) {
        const point = panel.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
        point.addClass('tangrow-report-series');
        point.dataset.series = series.key;
        point.setAttribute('cx', '300');
        point.setAttribute('cy', String(y(data.trends[0]![series.key])));
        point.setAttribute('r', '3');
        svg.appendChild(point);
      }
    }
    const chart = panel.createDiv({ cls: 'tangrow-report-trend-wrap' });
    chart.createSpan({ cls: 'tangrow-report-trend-max', text: this.number(maximum), attr: { 'aria-hidden': 'true' } });
    chart.appendChild(svg);
    const axis = panel.createDiv({ cls: 'tangrow-report-chart-axis' });
    axis.createSpan({ text: data.trends[0]?.day ?? '' });
    axis.createSpan({ text: data.trends.at(-1)?.day ?? '' });
    const details = panel.createEl('details', { cls: 'tangrow-report-chart-data' });
    details.createEl('summary', { text: this.t('View daily values') }).dataset.reportFocus = 'daily-values';
    details.open = this.showTrendValues;
    let populated = false;
    const populate = (): void => {
      if (populated) return;
      populated = true;
      const body = this.table(details, ['Day', ...SERIES.map(({ label }) => label)], 'Creation trends');
      for (const day of data.trends) {
        const row = body.createEl('tr');
        row.createEl('td', { text: day.day });
        const dates = { from: day.day, to: day.day };
        for (const { key, label } of SERIES) {
          const count = this.number(day[key]);
          const cell = row.createEl('td', day[key] ? undefined : { text: count });
          if (!day[key]) continue;
          const { page, selection } = TREND_DESTINATIONS[key];
          const link = this.countLink(cell, count, label, () => this.selectPage(page, { ...selection, dates }));
          link.dataset.reportFocus = `trend-${key}-${day.day}`;
          link.setAttribute('aria-label', this.t('{series}, {date}: {count}', { series: this.t(label), date: day.day, count }));
        }
      }
    };
    if (details.open) populate();
    details.addEventListener('toggle', () => {
      if (!this.contentEl.contains(details)) return;
      this.showTrendValues = details.open;
      if (details.open) populate();
    });
  }

  private renderActivityMetric(parent: HTMLElement, open?: () => void): HTMLElement {
    const activity = this.snapshot!.activity;
    const best = activity.hours.reduce((winner, hour) => hour.minutes > (winner?.minutes ?? 0) ? hour : winner, undefined as typeof activity.hours[number] | undefined);
    const card = this.metric(parent, 'Most active hour', best?.minutes ? `${String(best.hour).padStart(2, '0')}:00–${String((best.hour + 1) % 24).padStart(2, '0')}:00` : this.t('No editing activity recorded yet'), 'clock', open);
    const goal = this.host.settings.activityGoalMinutes * this.range;
    this.hint(this.detail(card, '{done} / {target} active minutes', { done: this.number(activity.minutes), target: this.number(goal) }),
      'Daily target: {count} active minutes', { count: this.number(this.host.settings.activityGoalMinutes) });
    this.progress(card, activity.minutes / Math.max(1, goal), this.t('Period activity target'));
    if (!this.host.settings.trackEditingActivity) this.detail(card, 'Editing activity is disabled');
    return card;
  }

  private shuffleWalk(): void {
    this.walkPaths = sampleReportNotes(this.snapshot?.data.notes.filter((note) => !inFolder(note.path, this.host.settings.archiveFolder)) ?? [], 10).map((note) => note.path);
    this.walkIndex = 0;
  }
  private renderWalk(parent: HTMLElement, data: ReportData): void {
    const current = data.notes.find((note) => note.path === this.walkPaths[this.walkIndex]);
    if (current) {
      const note = this.control(parent, current.name, 'arrow-up-right', () => this.host.openNote(current.path), undefined, true);
      note.addClass('tangrow-report-walk-current');
      note.dataset.reportFocus = 'walk-open';
      setTooltip(note, current.path);
    } else this.detail(parent, 'No notes to revisit');
    const controls = parent.createDiv({ cls: 'tangrow-report-walk-controls' });
    const previous = this.control(controls, 'Previous note', 'chevron-left', () => { this.walkIndex--; this.render(); });
    previous.disabled = this.walkIndex <= 0;
    const next = this.control(controls, 'Next note', 'chevron-right', () => { this.walkIndex++; this.render(); });
    next.disabled = this.walkIndex >= this.walkPaths.length - 1;
    const shuffle = this.control(controls, 'Shuffle 10 notes', 'shuffle', () => { this.shuffleWalk(); this.render(); });
    shuffle.disabled = this.walkPaths.length === 0;
  }
  private randomOrphan(parent: HTMLElement, data: ReportData): void {
    const control = this.control(parent, 'Open a random orphan', 'shuffle', async () => {
      const page = this.page;
      const revision = this.epoch;
      const latest = await this.host.loadReport(this.range);
      if (!this.mounted || page !== this.page || revision !== this.epoch) return;
      if (!latest.quality.linksReady) { await this.refresh(); return; }
      const note = sampleReportNotes(latest.data.orphanNotes, 1)[0];
      if (note) await this.host.openNote(note.path);
      else await this.refresh();
    });
    control.disabled = !data.orphanNotes.length || !this.snapshot?.quality.linksReady;
  }

  private renderActions(parent: HTMLElement, data: ReportData): void {
    const panel = this.panel(parent, 'Actions');
    const grid = panel.createDiv({ cls: 'tangrow-report-base-grid' });
    this.control(grid, 'Review unfinished tasks', 'square', () => this.selectPage('tasks', { status: 'open' }));
    this.control(grid, 'Review orphan notes', 'unlink', () => this.selectPage('notes', { role: 'orphans' })).disabled = !this.snapshot!.quality.linksReady;
    this.control(grid, 'Review saved captures', 'inbox', () => this.selectPage('notes', { role: 'captures' }));
    for (const [page, label] of [['projects', 'Review projects'], ['areas', 'Review areas']] as const) this.control(grid, label, 'arrow-right', () => this.selectPage(page));
    this.control(grid, 'Review clips', 'arrow-right', () => this.selectPage('resources', { resourceTab: 'clips' }));
    this.control(grid, 'Open existing task overview', 'list-checks', () => this.host.action('task-overview'));
    this.control(grid, "Open today's journal", 'calendar-days', () => this.host.action('daily-note'));
    this.control(grid, 'Open shared capture window', 'external-link', () => this.host.openCaptureWindow());
    this.randomOrphan(panel, data);
    this.renderTodayHabits(parent);
    this.renderWalk(this.panel(parent, 'Random walk'), data);
    const databases = this.panel(parent, 'Browse the companion Bases');
    const bases = databases.createDiv({ cls: 'tangrow-report-base-grid' });
    for (const definition of baseDefinitions(this.host.settings)) this.control(bases, definition.name, 'table', () => this.host.openBase(definition.id), undefined, true);
  }

  private renderTodayHabits(parent: HTMLElement): void {
    const panel = parent.createEl('section', { cls: 'tangrow-report-panel' });
    panel.createEl('h2', { text: this.t('Habit check-ins today'), attr: { tabindex: '-1' } }).dataset.reportFocus = 'today-habits';
    const today = dayKey(this.snapshot!.generatedAt);
    const completed = new Set(this.snapshot!.records.flatMap(({ frontmatter }) => frontmatter?.tangrow_kind === 'habit' && frontmatter.tangrow_day === today ? [frontmatter.tangrow_habit_id] : []));
    if (!this.host.settings.habits.length) this.caption(panel, 'No active habits configured');
    const list = panel.createDiv({ cls: 'tangrow-report-habits' });
    for (const habit of this.host.settings.habits) {
      const label = list.createEl('label');
      const check = label.createEl('input', { type: 'checkbox' });
      label.createSpan({ text: habit.name });
      const pending = this.pendingHabits.has(habit.id);
      check.checked = completed.has(habit.id) || pending;
      check.disabled = check.checked;
      check.dataset.reportFocus = `habit-${habit.id}`;
      check.addEventListener('change', () => {
        if (!check.checked || completed.has(habit.id) || this.pendingHabits.has(habit.id)) return;
        this.pendingHabits.add(habit.id);
        check.disabled = true;
        void this.host.checkHabit(habit.id).catch((error: unknown) => new Notice(describeError(this.host.settings.language, error))).finally(async () => {
          this.pendingHabits.delete(habit.id);
          if (this.mounted) await this.refresh();
        });
      });
    }
  }

  private filters(parent: HTMLElement, status = false, roles = false, searchHint = 'Search names, paths or task text'): HTMLElement {
    this.renderScope(parent);
    const controls = parent.createDiv({ cls: 'tangrow-report-filters' });
    const search = controls.createEl('input', { cls: 'tangrow-report-search', type: 'search', value: this.query, attr: { placeholder: this.t(searchHint), 'aria-label': this.t('Search report records') } });
    search.dataset.reportFocus = 'search';
    const updateQuery = (): void => { this.query = search.value; this.listPage = 0; this.render(); };
    search.addEventListener('compositionstart', () => { this.composing = true; });
    search.addEventListener('compositionend', () => { this.composing = false; updateQuery(); });
    search.addEventListener('input', () => { if (!this.composing) updateQuery(); });
    if (status) this.select(controls, 'Record status', this.statusFilter, [
      ['all', 'All statuses'], ['open', 'Open'], ['done', 'Done'],
      this.page === 'tasks' ? ['cancelled', 'Cancelled'] : ['archived', 'Archived'], ['unknown', 'Unknown']
    ], (value) => { this.statusFilter = value as FilterStatus; this.listPage = 0; this.render(); }, 'status');
    if (roles) this.select(controls, 'Note role', this.noteRole, [['all', 'All note roles'], ['pins', 'Pinned only'], ['orphans', 'Orphans only'], ['journals', 'Journals only'], ['captures', 'Captures only']], (value) => { this.noteRole = value; this.listPage = 0; this.render(); }, 'role');
    return controls;
  }
  private renderScope(parent: HTMLElement): void {
    if (!this.dates && !this.location) return;
    const scope = parent.createDiv({ cls: 'tangrow-report-scope' });
    if (this.location) this.caption(scope, 'Location: {path}', { path: this.location.path });
    if (this.dates) {
      const { from, to } = this.dates;
      if (from === to) {
        const label = this.page === 'tasks' ? 'Source notes created on {date}' : this.noteRole === 'journals' ? 'Journal entries on {date}' : 'Created on {date}';
        this.caption(scope, label, { date: from });
      }
      else this.caption(scope, 'Created from {from} to {to}', { from, to });
    }
    this.control(scope, 'Clear drill-down filters', 'x', () => {
      this.dates = undefined;
      this.location = undefined;
      this.listPage = 0;
      this.render();
      this.contentEl.querySelector<HTMLElement>('[data-report-focus="search"]')?.focus();
    });
  }

  private matchesDay(day: string | null): boolean {
    return !this.dates || day !== null && this.dates.from <= day && day <= this.dates.to;
  }
  private select(parent: HTMLElement, label: string, value: string, options: string[][], change: (value: string) => void, key: string): void {
    const wrapper = parent.createEl('label', { text: this.t(label) });
    const select = wrapper.createEl('select', { cls: 'tangrow-report-select', attr: { 'aria-label': this.t(label) } });
    select.dataset.reportFocus = key;
    for (const [id, text] of options) if (id && text) select.createEl('option', { value: id, text: this.t(text) });
    select.value = value;
    select.addEventListener('change', () => change(select.value));
  }
  private matches(...values: string[]): boolean { const query = this.query.trim().toLocaleLowerCase(this.host.settings.language); return !query || values.some((value) => value.toLocaleLowerCase(this.host.settings.language).includes(query)); }
  private table(parent: HTMLElement, columns: string[], label: string): HTMLTableSectionElement {
    const table = parent.createDiv({ cls: 'tangrow-report-table-wrap' }).createEl('table', { cls: 'tangrow-report-table', attr: { 'aria-label': this.t(label) } });
    const row = table.createEl('thead').createEl('tr');
    for (const column of columns) row.createEl('th', { text: this.t(column), attr: { scope: 'col' } });
    return table.createEl('tbody');
  }
  private paginate<T>(parent: HTMLElement, records: T[]): T[] {
    const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    this.listPage = Math.max(0, Math.min(this.listPage, pages - 1));
    const controls = parent.createDiv({ cls: 'tangrow-report-pagination' });
    controls.createSpan({ text: this.t('{count} matching records', { count: this.number(records.length) }), attr: { 'aria-live': 'polite' } });
    const previous = this.control(controls, 'Previous page', 'chevron-left', () => { this.listPage--; this.render(); });
    previous.disabled = this.listPage === 0;
    controls.createSpan({ text: this.t('Page {page} of {pages}', { page: this.listPage + 1, pages }) });
    const next = this.control(controls, 'Next page', 'chevron-right', () => { this.listPage++; this.render(); });
    next.disabled = this.listPage >= pages - 1;
    if (!records.length) this.caption(parent, 'No matching records');
    return records.slice(this.listPage * PAGE_SIZE, (this.listPage + 1) * PAGE_SIZE);
  }
  private statusEditor(parent: HTMLElement, key: string, name: string, current: string, options: readonly (readonly [string, string])[], change: (status: string) => ReportStatusChange, hint: string): void {
    const select = parent.createEl('select', { cls: 'tangrow-report-status tangrow-report-status-editor', attr: { 'aria-label': this.t('Change status for {name}', { name }) } });
    select.dataset.reportFocus = `status-${key}`;
    select.dataset.status = current === ' ' || current === '/' ? 'open' : current === 'x' ? 'done' : current === '-' ? 'cancelled' : current;
    if (!options.some(([value]) => value === current)) select.createEl('option', { value: current, text: this.t('Unknown') }).disabled = true;
    for (const [value, text] of options) select.createEl('option', { value, text: this.t(text) });
    select.value = current;
    select.disabled = this.pendingStatuses.has(key);
    setTooltip(select, hint);
    select.addEventListener('change', () => {
      if (this.pendingStatuses.has(key) || select.value === current) return;
      const next = select.value;
      this.pendingStatuses.add(key);
      select.disabled = true;
      select.setAttribute('aria-busy', 'true');
      void Promise.resolve().then(() => this.host.updateReportStatus(change(next))).catch((error: unknown) => {
        new Notice(describeError(this.host.settings.language, error));
      }).finally(async () => {
        this.pendingStatuses.delete(key);
        if (this.mounted) await this.refresh();
      });
    });
  }

  private noteStatus(parent: HTMLElement, note: ReportRecord): void {
    this.statusEditor(parent, `note-${note.path}`, note.name, reportRecordStatus(note), RECORD_STATUSES,
      (status) => ({ kind: 'note', source: reportStatusSource(note), status: status as EditableReportStatus }),
      this.t('Save status to {path}.', { path: note.path }));
  }

  private entityStatus(parent: HTMLElement, entity: ReportEntity, collection: 'projects' | 'areas'): void {
    const rootNote = this.snapshot!.data.notes.find((note) => note.path === entity.path);
    if (rootNote) { this.noteStatus(parent, rootNote); return; }
    const sources = canonicalEntityNotes(this.snapshot!.data.notes, entity.path);
    const targets = sources.filter((source, index) => index === 0 || hasReportStatus(source));
    const hint = targets.length > 1 ? this.t('Save status to {count} canonical notes in {path}.', { count: targets.length, path: entity.path })
      : targets.length ? this.t('Save status to {path}.', { path: targets[0]!.path })
      : this.t('A README note will be created in {path} to save this status.', { path: entity.path });
    this.statusEditor(parent, `entity-${entity.path}`, entity.name, entity.status, RECORD_STATUSES,
      (status) => ({ kind: 'entity', collection, path: entity.path, sources: sources.map(reportStatusSource), status: status as EditableReportStatus }), hint);
  }
  private taskStatus(task: ReportTask): FilterStatus { return task.status === ' ' || task.status === '/' ? 'open' : task.status.toLowerCase() === 'x' ? 'done' : task.status === '-' ? 'cancelled' : 'unknown'; }

  private renderTasks(parent: HTMLElement, data: ReportData): void {
    const panel = this.panel(parent, 'Tasks');
    this.completion(panel, data.completion.tasks);
    this.filters(panel, true);
    const sourceDays = this.dates ? new Map(data.notes.map((note) => [note.path, reportTrendDay(note, 'tasks', this.snapshot!.generatedAt)])) : undefined;
    const records = data.taskItems.filter((task) => this.matchesDay(sourceDays?.get(task.path) ?? null) && (this.statusFilter === 'all' || this.taskStatus(task) === this.statusFilter) && this.matches(task.name, task.path, task.text));
    const visible = this.paginate(panel, records);
    const body = this.table(panel, ['Tasks', 'Status', 'Location'], 'Tasks');
    for (const task of visible) {
      const row = body.createEl('tr');
      this.control(row.createEl('td'), task.text || task.name, 'arrow-up-right', () => this.host.openNote(task.path, task.line), undefined, true).dataset.reportFocus = `task-${task.path}-${task.line}`;
      this.statusEditor(row.createEl('td'), `task-${task.path}-${task.line}`, task.text || task.name, task.status === 'X' ? 'x' : task.status, TASK_STATUSES,
        (status) => ({ kind: 'task', task, status: status as ReportTaskStatus }), this.t('Update the checkbox in {path}, line {line}.', { path: task.path, line: task.line + 1 }));
      row.createEl('td', { text: `${task.path}:${task.line + 1}` });
    }
  }

  private renderEntities(parent: HTMLElement, entities: ReportEntity[], kind: 'projects' | 'areas'): void {
    const panel = this.panel(parent, kind === 'projects' ? 'Project entities' : 'Area entities');
    this.completion(panel, this.snapshot!.data.completion[kind]);
    this.filters(panel, true);
    const records = entities.filter((entity) => (!this.dates || this.matchesDay(entity.created === null ? null : dayKey(entity.created))) && (this.statusFilter === 'all' || entity.status === this.statusFilter) && this.matches(entity.name, entity.path));
    const body = this.table(panel, ['Name', 'Status', 'Notes', 'Created', 'Location'], kind === 'projects' ? 'Projects' : 'Areas');
    for (const entity of this.paginate(panel, records)) {
      const row = body.createEl('tr');
      const button = this.control(row.createEl('td'), entity.name, 'folder-open', () => entity.notePath ? this.host.openNote(entity.notePath) : undefined, undefined, true);
      button.dataset.reportFocus = `entity-${entity.path}`;
      button.disabled = !entity.notePath;
      if (!entity.notePath) setTooltip(button, this.t('No canonical note available'));
      this.entityStatus(row.createEl('td'), entity, kind);
      this.renderMemberCount(row, entity);
      row.createEl('td', { text: this.date(entity.created) });
      row.createEl('td', { text: entity.path });
    }
  }

  private renderNotes(parent: HTMLElement, data: ReportData): void {
    const snapshot = this.snapshot!;
    const choices: Array<{ id: NoteTab; label: string; count?: number }> = [{ id: 'all', label: 'All notes', count: data.counts.notes }];
    if (this.host.settings.knowledgeEnabled) choices.push({ id: 'cards', label: 'Card notes', count: snapshot.cards?.counts.all });
    choices.push({ id: 'drafts', label: 'Manuscripts', count: data.counts.drafts });
    const content = this.renderSubtabs(parent, 'note', 'Note views', choices, this.noteTab, (noteTab) => {
      if (noteTab === 'cards') this.knowledge.selectCards();
      this.selectPage('notes', { noteTab, focus: `[data-report-focus="note-tab-${noteTab}"]` });
    });
    if (this.noteTab === 'cards') { this.knowledge.renderCards(content, snapshot); return; }
    if (this.noteTab === 'drafts') { this.knowledge.renderDrafts(content, snapshot); return; }
    this.knowledge.renderCaptureCoverage(content, snapshot);
    const panel = this.panel(content, 'Notes');
    panel.createEl('p', { cls: 'tangrow-report-caption', text: `${this.t('{count} words', { count: this.number(data.counts.words) })} · ${this.t('{count} characters excluding whitespace', { count: this.number(data.counts.characters) })}` });
    this.filters(panel, true, true);
    if (this.noteRole === 'orphans' && !this.snapshot!.quality.linksReady) {
      this.caption(panel, 'Link indexing is still in progress; orphan results may change.');
    } else {
      const orphans = new Set(data.orphanNotes.map((note) => note.path));
      const records = data.notes.filter((note) => {
        if (this.location && (this.location.file ? note.path !== this.location.path : !inFolder(note.path, this.location.path))) return false;
        if (this.statusFilter !== 'all' && reportRecordStatus(note) !== this.statusFilter || !this.matches(note.name, note.path)) return false;
        const journalDay = this.noteRole === 'journals' ? reportJournalDay(note, this.host.settings) : null;
        if (this.dates && !this.matchesDay(this.noteRole === 'journals' ? journalDay : reportTrendDay(note, this.noteRole === 'captures' ? 'captures' : 'notes', snapshot.generatedAt))) return false;
        switch (this.noteRole) {
          case 'pins': return note.frontmatter?.tangrow_pin === true;
          case 'orphans': return orphans.has(note.path);
          case 'journals': return journalDay !== null;
          case 'captures': return note.frontmatter?.tangrow_kind === 'capture';
          default: return true;
        }
      });
      const body = this.table(panel, ['Name', 'Status', 'Words', 'Characters', this.noteRole === 'journals' ? 'Journal date' : 'Created', 'Modified', 'Location'], 'Notes');
      for (const note of this.paginate(panel, records)) {
        const row = body.createEl('tr');
        this.control(row.createEl('td'), note.name, 'file-text', () => this.host.openNote(note.path), undefined, true).dataset.reportFocus = `note-${note.path}`;
        this.noteStatus(row.createEl('td'), note);
        row.createEl('td', { text: note.wordCount === undefined ? this.t('Unknown') : this.number(note.wordCount) });
        row.createEl('td', { text: note.characterCount === undefined ? this.t('Unknown') : this.number(note.characterCount) });
        const captureDate = this.noteRole === 'captures' ? captureCreated(note.frontmatter?.created, note.created, note.modified) : undefined;
        row.createEl('td', { text: this.noteRole === 'journals' ? reportJournalDay(note, this.host.settings)! : this.date(captureDate ?? note.created) });
        row.createEl('td', { text: this.date(note.modified) });
        row.createEl('td', { text: note.path });
      }
    }
    renderActivityHeatmaps(content, snapshot.records, this.host, this.activityState, (year) => {
      this.activityState.year = year;
      this.activityState.selection = undefined;
      this.activityState.focusedDays = {};
      this.activityState.scrollPositions = {};
      this.render();
    });
    this.renderExclusions(content);
  }

  private renderResources(parent: HTMLElement, data: ReportData): void {
    const metrics = parent.createDiv({ cls: 'tangrow-report-metrics tangrow-report-resource-metrics' });
    const entries = this.metric(metrics, 'Resource entries', data.resources.length, 'library');
    this.hint(entries, 'Direct child folders and root-level Markdown in {folder}.', { folder: this.host.settings.resourcesFolder });
    const notes = this.metric(metrics, 'Resource notes', data.counts.resourceNotes, 'files');
    this.detail(notes, 'Created in the last 90 days: +{count}', { count: this.number(data.gains90.resourceNotes) });
    const clips = this.metric(metrics, 'Clips total', data.counts.clips, 'bookmark');
    const outside = data.clips.reduce((count, note) => count + Number(!inFolder(note.path, this.host.settings.resourcesFolder)), 0);
    if (outside) this.detail(clips, '{count} clips are outside the resource folder.', { count: this.number(outside) });
    const summary = data.completion.clips;
    const completion = this.metric(metrics, 'Clip completion rate', summary.rate === null ? this.t('No known completion state') : `${this.number(summary.rate * 100, 1)}%`, 'circle-check');
    this.completion(completion, summary, true);

    const choices: Array<{ id: ResourceTab; label: string; count?: number }> = [
      { id: 'items', label: 'Resource entries', count: data.resources.length },
      { id: 'clips', label: 'Clips', count: data.clips.length },
      { id: 'materials', label: 'Material extraction' }
    ];
    const content = this.renderSubtabs(parent, 'resource', 'Resource views', choices, this.resourceTab, (resourceTab) => {
      this.selectPage('resources', { resourceTab, focus: `[data-report-focus="resource-tab-${resourceTab}"]` });
    });
    if (this.resourceTab === 'clips') {
      this.renderClips(content, data);
      return;
    }
    if (this.resourceTab === 'materials') {
      this.knowledge.renderMaterials(content, this.snapshot!);
      return;
    }
    const panel = this.panel(content, 'Resource entries');
    const filters = this.filters(panel, false, false, 'Search names or paths');
    const sort = filters.createDiv({ cls: 'tangrow-report-resource-sort', attr: { role: 'group', 'aria-label': this.t('Sort resources') } });
    for (const [key, label] of [['modified', 'Last updated'], ['notes', 'Note count'], ['name', 'Name']] as const) {
      const button = this.control(sort, label, '', () => { this.resourceSort = key; this.listPage = 0; this.render(); });
      button.dataset.reportFocus = `resource-sort-${key}`;
      button.setAttribute('aria-pressed', String(this.resourceSort === key));
    }
    const records = data.resources.filter((entry) => this.matches(entry.name, entry.path));
    records.sort((left, right) => {
      const primary = this.resourceSort === 'modified' ? (right.modified ?? -1) - (left.modified ?? -1)
        : this.resourceSort === 'notes' ? right.noteCount - left.noteCount : left.name.localeCompare(right.name, this.host.settings.language);
      return primary || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    });
    const visible = this.paginate(panel, records);
    const body = this.table(panel, ['Name', 'Notes', 'Last updated', 'Created', 'Location'], 'Resource entries');
    const relativeTime = new Intl.RelativeTimeFormat(this.host.settings.language, { numeric: 'auto' });
    for (const entry of visible) {
      const row = body.createEl('tr');
      const standalone = entry.notePath === entry.path;
      const name = standalone ? entry.path.slice(entry.path.lastIndexOf('/') + 1) : entry.name;
      const button = this.control(row.createEl('td'), name, standalone ? 'file-text' : 'library', () => entry.notePath ? this.host.openNote(entry.notePath) : undefined, undefined, true);
      button.dataset.reportFocus = `resource-${entry.path}`;
      button.disabled = !entry.notePath;
      if (!entry.notePath) setTooltip(button, this.t('This resource folder has no notes to open.'));
      this.renderMemberCount(row, entry);
      let updated = this.t('Unknown');
      if (entry.modified !== null) {
        const days = Math.floor((this.snapshot!.generatedAt - entry.modified) / 86_400_000);
        const unit = days < 7 ? 'day' : days < 30 ? 'week' : days < 365 ? 'month' : 'year';
        const count = unit === 'day' ? days : Math.floor(days / (unit === 'week' ? 7 : unit === 'month' ? 30 : 365));
        updated = relativeTime.format(-count, unit);
      }
      const modified = row.createEl('td', { text: updated });
      if (entry.modified !== null) setTooltip(modified, new Date(entry.modified).toLocaleString(this.host.settings.language));
      row.createEl('td', { text: this.date(entry.created) });
      row.createEl('td', { text: entry.path });
    }
  }

  private renderMemberCount(row: HTMLTableRowElement, entry: Pick<ReportEntity, 'path' | 'notePath' | 'noteCount'>): void {
    const count = this.number(entry.noteCount);
    const cell = row.createEl('td', entry.noteCount ? undefined : { text: count });
    if (!entry.noteCount) return;
    const location = { path: entry.path, file: entry.notePath === entry.path };
    const link = this.countLink(cell, count, 'Note count', () => this.selectPage('notes', { location }));
    link.dataset.reportFocus = `note-count-${entry.path}`;
    link.setAttribute('aria-label', this.t('{count} notes in {path}', { count, path: entry.path }));
  }

  private renderSubtabs<T extends string>(parent: HTMLElement, scope: string, label: string, choices: Array<{ id: T; label: string; count?: number }>, current: T, select: (tab: T) => void): HTMLElement {
    const tabs = parent.createDiv({ cls: 'tangrow-report-subtabs', attr: { role: 'tablist', 'aria-label': this.t(label) } });
    const prefix = `${this.instanceId}-${scope}`;
    for (const [index, choice] of choices.entries()) {
      const title = this.t(choice.label);
      const text = choice.count === undefined ? title : `${title} · ${this.number(choice.count)}`;
      const button = this.control(tabs, text, '', () => select(choice.id), undefined, true);
      button.dataset.reportFocus = `${scope}-tab-${choice.id}`;
      button.id = `${prefix}-${choice.id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(current === choice.id));
      button.setAttribute('aria-controls', `${prefix}-pane`);
      button.tabIndex = current === choice.id ? 0 : -1;
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const shift = event.key === 'ArrowLeft' ? -1 : 1;
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + shift + choices.length) % choices.length;
        select(choices[next]!.id);
      });
    }
    return parent.createDiv({ attr: { role: 'tabpanel', id: `${prefix}-pane`, 'aria-labelledby': `${prefix}-${current}` } });
  }

  private renderClips(parent: HTMLElement, data: ReportData): void {
    const panel = this.panel(parent, 'Clips');
    this.completion(panel, data.completion.clips);
    this.filters(panel, true);
    const records = data.clips.filter((note) => (!this.dates || this.matchesDay(reportTrendDay(note, 'clips', this.snapshot!.generatedAt))) && (this.statusFilter === 'all' || reportRecordStatus(note) === this.statusFilter) && this.matches(note.name, note.path, String(note.frontmatter?.source ?? '')));
    const body = this.table(panel, ['Name', 'Status', 'Source', 'Created', 'Location'], 'Clips');
    for (const note of this.paginate(panel, records)) {
      const row = body.createEl('tr');
      this.control(row.createEl('td'), note.name, 'bookmark', () => this.host.openNote(note.path), undefined, true).dataset.reportFocus = `clip-${note.path}`;
      this.noteStatus(row.createEl('td'), note);
      row.createEl('td', { text: String(note.frontmatter?.source ?? '') });
      row.createEl('td', { text: this.date(note.created) });
      row.createEl('td', { text: note.path });
    }
  }

  private renderTime(parent: HTMLElement): void {
    this.renderRangeHeading(parent);
    const { activity, data } = this.snapshot!;
    const metrics = parent.createDiv({ cls: 'tangrow-report-metrics' });
    this.renderActivityMetric(metrics);
    this.metric(metrics, 'Focus timer minutes', data.counts.focusMinutes, 'timer', () => this.selectPage('time', { focus: '[data-report-focus="focus-records"]' }));
    const notes = this.panel(parent, 'Editing activity');
    this.caption(notes, 'Recording since {date}', { date: this.date(activity.startedAt) });
    this.renderActivitySettings(notes);
    const daily = this.panel(parent, 'Daily editing minutes');
    const dayTable = this.table(daily, ['Day', 'Editing activity'], 'Daily editing minutes');
    for (const day of activity.days) {
      const row = dayTable.createEl('tr');
      row.createEl('td', { text: day.day });
      row.createEl('td', { text: this.t('{count} active minutes', { count: this.number(day.minutes) }) });
    }
    const hourly = this.panel(parent, 'Editing by hour');
    const hours = hourly.createDiv({ cls: 'tangrow-report-hours' });
    const maximum = Math.max(1, ...activity.hours.map((hour) => hour.minutes));
    for (const hour of activity.hours) {
      const label = this.t('{hour}:00: {minutes} active minutes', { hour: String(hour.hour).padStart(2, '0'), minutes: this.number(hour.minutes) });
      const slot = hours.createDiv({ cls: 'tangrow-report-hour', attr: { 'aria-label': label } });
      slot.createSpan({ text: String(hour.hour).padStart(2, '0') });
      slot.createDiv({ cls: 'tangrow-report-hour-bar' }).style.height = `${hour.minutes ? Math.max(2, hour.minutes / maximum * 100) : 1}%`;
      slot.createSpan({ text: this.number(hour.minutes) });
      setTooltip(slot, label);
    }
  }

  private renderFocusRecords(parent: HTMLElement, data: ReportData): void {
    const focus = this.panel(parent, 'Saved focus sessions');
    const heading = focus.querySelector('h2');
    if (heading) { heading.tabIndex = -1; heading.dataset.reportFocus = 'focus-records'; }
    const rows = this.paginate(focus, data.focusSessions);
    if (!rows.length) return;
    const table = this.table(focus, ['Name', 'Day', 'Focus timer minutes'], 'Saved focus sessions');
    for (const { note, minutes } of rows) {
      const row = table.createEl('tr');
      this.control(row.createEl('td'), note.name, 'timer', () => this.host.openNote(note.path), undefined, true).dataset.reportFocus = `focus-${note.path}`;
      row.createEl('td', { text: typeof note.frontmatter?.tangrow_day === 'string' ? note.frontmatter.tangrow_day : this.date(note.created) });
      row.createEl('td', { text: this.number(minutes) });
    }
  }

  private renderActivitySettings(parent: HTMLElement): void {
    const form = parent.createEl('form', { cls: 'tangrow-report-filters' });
    const label = form.createEl('label');
    const enabled = label.createEl('input', { type: 'checkbox' });
    enabled.checked = this.host.settings.trackEditingActivity;
    enabled.dataset.reportFocus = 'tracking';
    label.createSpan({ text: this.t('Enable local editing activity') });
    this.hint(label, 'Only editing event times are counted. Note text and keyboard contents are not stored.');
    enabled.addEventListener('change', () => { void this.host.updateReportSettings({ trackEditingActivity: enabled.checked }).then(() => this.refresh()).catch((error: unknown) => { enabled.checked = this.host.settings.trackEditingActivity; new Notice(describeError(this.host.settings.language, error)); }); });
    const targetLabel = form.createEl('label', { text: this.t('Daily activity target') });
    const goal = targetLabel.createEl('input', { type: 'number', value: this.goalDraft ?? String(this.host.settings.activityGoalMinutes), attr: { min: '1', max: '1440', step: '1', 'aria-label': this.t('Daily activity target') } });
    goal.dataset.reportFocus = 'goal';
    goal.addEventListener('input', () => { this.goalDraft = goal.value; });
    const save = this.control(form, 'Apply activity goal', 'check', async () => {
      const submittedDraft = this.goalDraft;
      const minutes = Number(goal.value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Use an activity goal from 1 to 1440 whole minutes.');
      await this.host.updateReportSettings({ activityGoalMinutes: minutes });
      if (this.goalDraft === submittedDraft) this.goalDraft = undefined;
      await this.refresh();
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); save.click(); });
  }

  private renderExclusions(parent: HTMLElement): void {
    const panel = this.panel(parent, 'Report exclusions');
    const label = panel.createEl('label', { text: this.t('Excluded folders, one per line') });
    const editor = label.createEl('textarea', { cls: 'tangrow-textarea', attr: { rows: '3', 'aria-label': this.t('Excluded folders, one per line') } });
    editor.value = this.exclusionsDraft ?? this.host.settings.reportExcludedFolders.join('\n');
    editor.dataset.reportFocus = 'exclusions';
    editor.addEventListener('compositionstart', () => { this.composing = true; });
    editor.addEventListener('compositionend', () => { this.composing = false; this.exclusionsDraft = editor.value; this.render(); });
    editor.addEventListener('input', () => { this.exclusionsDraft = editor.value; });
    this.control(panel, 'Apply report exclusions', 'check', async () => {
      const submittedDraft = this.exclusionsDraft;
      const folders = [...new Set(editor.value.split(/\r?\n/).map((folder) => folder.trim()).filter(Boolean).map(safeFolder))];
      await this.host.updateReportSettings({ reportExcludedFolders: folders });
      if (this.exclusionsDraft === submittedDraft) this.exclusionsDraft = undefined;
      await this.refresh();
    });
  }
}
