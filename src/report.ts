import { ItemView, Notice, setIcon, setTooltip, type WorkspaceLeaf } from 'obsidian';
import { baseDefinitions } from './bases';
import { renderActivityHeatmaps, type ActivityViewState } from './activity-view';
import { describeError, translate, type TranslationValues } from './i18n';
import { inFolder, safeFolder } from './model';
import type { CompletionSummary, EditableReportStatus, ReportData, ReportEntity, ReportPage, ReportRange, ReportRecord, ReportSnapshot, ReportStatus, ReportStatusChange, ReportTask, ReportTaskStatus } from './report-contract';
import { canonicalEntityNotes, hasReportStatus, reportJournalDay, reportRecordStatus, reportStatusSource, sampleReportNotes } from './report-metrics';
import type { SidebarHost } from './types';

export const REPORT_VIEW_TYPE = 'tangrow-report';
const PAGE_SIZE = 20;
const RANGES: ReportRange[] = [1, 7, 30, 60, 90, 180, 365];
const PAGES: Array<{ id: ReportPage; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
  { id: 'actions', label: 'Actions', icon: 'list-checks' },
  { id: 'tasks', label: 'Tasks', icon: 'square-check' },
  { id: 'projects', label: 'Projects', icon: 'folder-kanban' },
  { id: 'notes', label: 'Notes', icon: 'files' },
  { id: 'clips', label: 'Clips', icon: 'bookmark' },
  { id: 'areas', label: 'Areas', icon: 'layers' },
  { id: 'time', label: 'Time', icon: 'clock' }
];
const SERIES = [
  { key: 'notes', label: 'Notes' }, { key: 'tasks', label: 'Tasks' },
  { key: 'projects', label: 'Projects' }, { key: 'clips', label: 'Clips' },
  { key: 'captures', label: 'Saved captures' }
] as const;
type SeriesKey = typeof SERIES[number]['key'];
type FilterStatus = ReportStatus | 'cancelled' | 'all';
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
  private range: ReportRange = 30;
  private query = '';
  private statusFilter: FilterStatus = 'all';
  private noteRole = 'all';
  private listPage = 0;
  private visibleSeries = new Set<SeriesKey>(SERIES.map(({ key }) => key));
  private walkPaths: string[] = [];
  private walkIndex = 0;
  private exclusionsDraft?: string;
  private goalDraft?: string;
  private readonly pendingStatuses = new Set<string>();
  private readonly activityState: ActivityViewState = { year: new Date().getFullYear(), focusedDays: {}, scrollPositions: {} };

  constructor(leaf: WorkspaceLeaf, private readonly host: SidebarHost) { super(leaf); }
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
    this.epoch++;
    window.clearTimeout(this.refreshTimer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.contentEl.empty();
  }

  refreshLanguage(): void { this.render(); }
  private t(source: string, values?: TranslationValues): string { return translate(this.host.settings.language, source, values); }
  private number(value: number, decimals = 2): string { return value.toLocaleString(this.host.settings.language, { maximumFractionDigits: decimals }); }
  private date(value: number | null): string { return value !== null && Number.isFinite(value) ? new Date(value).toLocaleDateString(this.host.settings.language) : this.t('Unknown'); }
  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => { void this.refresh(); }, 180);
  }

  private async refresh(): Promise<void> {
    const revision = ++this.epoch;
    this.loading = true;
    if (!this.snapshot) this.contentEl.setText(this.t('Loading your local report...'));
    try {
      const snapshot = await this.host.loadReport(this.range);
      if (!this.mounted || revision !== this.epoch) return;
      this.snapshot = snapshot;
      const paths = new Set(snapshot.data.notes.map((note) => note.path));
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
  private metric(parent: HTMLElement, label: string, value: number | string, icon: string): HTMLElement {
    const card = parent.createDiv({ cls: 'tangrow-report-metric' });
    const heading = card.createDiv({ cls: 'tangrow-report-metric-label' });
    setIcon(heading.createSpan({ cls: 'tangrow-report-icon' }), icon);
    heading.createSpan({ text: this.t(label) });
    card.createEl('strong', { text: typeof value === 'number' ? this.number(value) : value });
    return card;
  }
  private detail(parent: HTMLElement, source: string, values?: TranslationValues): void {
    parent.createEl('p', { cls: 'tangrow-report-metric-detail', text: this.t(source, values) });
  }
  private progress(parent: HTMLElement, ratio: number, label: string): void {
    parent.createEl('progress', { attr: { max: '1', value: String(Math.max(0, Math.min(1, ratio))), 'aria-label': label } });
  }
  private completion(parent: HTMLElement, summary: CompletionSummary): void {
    if (summary.rate === null) this.detail(parent, 'No known completion state');
    else {
      const percent = this.number(summary.rate * 100, 1);
      this.detail(parent, 'Completion: {percent}%', { percent });
      this.progress(parent, summary.rate, this.t('Completion: {percent}%', { percent }));
    }
    if (summary.unknown) this.detail(parent, '{count} unknown states excluded', { count: this.number(summary.unknown) });
    if (summary.archived) this.detail(parent, '{count} archived excluded', { count: this.number(summary.archived) });
    if (summary.cancelled) this.detail(parent, '{count} cancelled excluded', { count: this.number(summary.cancelled) });
    this.detail(parent, 'Known: {done} done, {open} open', { done: this.number(summary.done), open: this.number(summary.open) });
  }

  private render(): void {
    if (!this.mounted || !this.snapshot || this.composing) return;
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
      case 'clips': this.renderClips(body, data); break;
      case 'areas': this.renderEntities(body, data.areas, 'areas'); break;
      case 'time': this.renderTime(body); break;
    }
    const footer = shell.createDiv({ cls: 'tangrow-report-footer' });
    footer.createSpan({ text: this.t('All metrics query current files; notes are never relocated.') });
    footer.createSpan({ text: this.t('Refreshed at {time}', { time: new Date(this.snapshot.generatedAt).toLocaleTimeString(this.host.settings.language) }) });
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
    this.caption(intro, 'Browse your notes and update statuses in their source files.');
    const toolbar = header.createDiv({ cls: 'tangrow-report-toolbar' });
    const refresh = this.control(toolbar, this.loading ? 'Updating report...' : 'Refresh report', 'refresh-cw', () => this.refresh());
    refresh.disabled = this.loading;
    refresh.dataset.reportFocus = 'refresh';
    const nav = parent.createDiv({ cls: 'tangrow-report-nav', attr: { role: 'tablist', 'aria-label': this.t('Report pages') } });
    for (const [index, page] of PAGES.entries()) {
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
    const ranges = parent.createDiv({ cls: 'tangrow-report-range', attr: { role: 'group', 'aria-label': this.t('Report date range') } });
    for (const range of RANGES) {
      const label = range === 1 ? this.t('Today') : this.t('Last {count} days', { count: range });
      const button = this.control(ranges, label, '', async () => { this.range = range; await this.refresh(); }, undefined, true);
      button.addClass('tangrow-report-range-button');
      button.toggleClass('is-active', this.range === range);
      button.setAttribute('aria-pressed', String(this.range === range));
      button.dataset.reportFocus = `range-${range}`;
    }
    this.caption(parent, 'The range controls charts and editing activity. Totals and 90-day gains use their own periods.');
  }

  private selectPage(page: ReportPage): void {
    this.page = page;
    this.query = '';
    this.statusFilter = 'all';
    this.noteRole = 'all';
    this.listPage = 0;
    this.render();
    this.contentEl.querySelector<HTMLElement>(`[data-page="${page}"]`)?.focus({ preventScroll: true });
  }

  private renderOverview(parent: HTMLElement, data: ReportData): void {
    this.renderTrends(parent, data);
    const grid = parent.createDiv({ cls: 'tangrow-report-metrics' });
    const note = this.metric(grid, 'Notes total', data.counts.notes, 'files');
    this.detail(note, 'Created in the last 90 days: +{count}', { count: this.number(data.gains90.notes) });
    const tasks = this.metric(grid, 'Tasks total', data.counts.tasks, 'square-check');
    this.completion(tasks, data.completion.tasks);
    const projects = this.metric(grid, 'Project entities', data.counts.projects, 'folder-kanban');
    this.completion(projects, data.completion.projects);
    this.detail(projects, 'Created in the last 90 days: +{count}', { count: this.number(data.gains90.projects) });
    const clips = this.metric(grid, 'Clips total', data.counts.clips, 'bookmark');
    this.completion(clips, data.completion.clips);
    this.detail(clips, 'Created in the last 90 days: +{count}', { count: this.number(data.gains90.clips) });
    const areas = this.metric(grid, 'Area entities', data.counts.areas, 'layers');
    this.completion(areas, data.completion.areas);
    this.detail(areas, 'Created in the last 90 days: +{count}', { count: this.number(data.gains90.areas) });
    this.renderActivityMetric(grid);
    const words = this.metric(grid, 'Word and character totals', this.t('{count} words', { count: this.number(data.counts.words) }), 'text');
    this.detail(words, '{count} characters excluding whitespace', { count: this.number(data.counts.characters) });
    this.detail(words, 'Support records and configured report exclusions are omitted.');
    const journal = this.metric(grid, 'Journal streak', this.t('{count} consecutive days', { count: this.number(data.streaks.journal.current) }), 'calendar-days');
    this.heatmap(journal, data.streaks.journal.days);
    const captures = this.metric(grid, 'Saved captures', data.counts.captures, 'inbox');
    this.detail(captures, '{count} consecutive days', { count: this.number(data.streaks.captures.current) });
    this.detail(captures, 'Created in the last 90 days: +{count}', { count: this.number(data.gains90.captures) });
    this.heatmap(captures, data.streaks.captures.days);
    const habits = this.metric(grid, 'Habit check-ins', this.t('{done} / {total} today', { done: data.habits.todayCompleted, total: data.habits.target }), 'calendar-check');
    this.heatmap(habits, data.habits.days.map(({ day, completed, target }) => ({ day, count: completed, target })));
    if (!data.habits.target) this.detail(habits, 'No active habits configured');
    const orphans = this.metric(grid, 'Orphan notes', this.snapshot!.quality.linksReady ? data.counts.orphans : this.t('Indexing links...'), 'unlink');
    this.detail(orphans, 'No incoming or outgoing resolved note links.');
    this.randomOrphan(orphans, data);
    this.renderWalk(this.metric(grid, 'Random walk', Math.min(10, this.walkPaths.length), 'shuffle'), data);
  }

  private heatmap(parent: HTMLElement, days: Array<{ day: string; count: number; target?: number }>): void {
    const describe = (day: typeof days[number]): string => day.target === undefined
      ? this.t('{date}: {count} records', { date: day.day, count: this.number(day.count) })
      : this.t('{date}: {done} / {target} habits', { date: day.day, done: this.number(day.count), target: this.number(day.target) });
    const grid = parent.createDiv({ cls: 'tangrow-report-heatmap', attr: { role: 'img', 'aria-label': `${this.t('Fourteen-day history')}: ${days.map(describe).join('; ')}` } });
    for (const day of days) {
      const label = describe(day);
      const complete = day.count > 0 && (day.target === undefined || day.count >= day.target);
      const cell = grid.createSpan({ cls: `tangrow-report-day${complete ? ' is-complete' : day.count > 0 ? ' is-partial' : ''}` });
      setTooltip(cell, label);
    }
    setTooltip(grid, this.t('Oldest to newest, including today.'));
  }

  private renderTrends(parent: HTMLElement, data: ReportData): void {
    const panel = this.panel(parent, 'Creation trends', 'Current records grouped by creation day, not historical inventory snapshots.');
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
    }
    const svg = panel.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.addClass('tangrow-report-trend');
    svg.setAttribute('viewBox', '0 0 600 180');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', this.t('Creation trends'));
    const selected = SERIES.filter(({ key }) => this.visibleSeries.has(key));
    const maximum = Math.max(1, ...data.trends.flatMap((day) => selected.map(({ key }) => day[key])));
    for (const series of selected) {
      const line = panel.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      line.addClass('tangrow-report-series');
      line.dataset.series = series.key;
      line.setAttribute('fill', 'none');
      line.setAttribute('points', data.trends.map((day, index) => `${data.trends.length === 1 ? 300 : 10 + index / (data.trends.length - 1) * 580},${170 - day[series.key] / maximum * 155}`).join(' '));
      svg.appendChild(line);
      if (data.trends.length === 1) {
        const point = panel.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'circle');
        point.addClass('tangrow-report-series');
        point.dataset.series = series.key;
        point.setAttribute('cx', '300');
        point.setAttribute('cy', String(170 - data.trends[0]![series.key] / maximum * 155));
        point.setAttribute('r', '3');
        svg.appendChild(point);
      }
    }
    panel.appendChild(svg);
    const axis = panel.createDiv({ cls: 'tangrow-report-chart-axis' });
    axis.createSpan({ text: data.trends[0]?.day ?? '' });
    axis.createSpan({ text: `0–${this.number(maximum)}` });
    axis.createSpan({ text: data.trends.at(-1)?.day ?? '' });
    this.caption(panel, 'Task points count current checkboxes by the source note creation day.');
    this.caption(panel, 'Dates use available metadata and file timestamps; importing or restoring notes can change file dates.');
    const details = panel.createEl('details', { cls: 'tangrow-report-chart-data' });
    details.createEl('summary', { text: this.t('View chart values') });
    const body = this.table(details, ['Day', ...SERIES.map(({ label }) => label)], 'Creation trends');
    for (const day of data.trends) {
      const row = body.createEl('tr');
      row.createEl('td', { text: day.day });
      for (const { key } of SERIES) row.createEl('td', { text: this.number(day[key]) });
    }
  }

  private renderActivityMetric(parent: HTMLElement): void {
    const activity = this.snapshot!.activity;
    const best = activity.hours.reduce((winner, hour) => hour.minutes > (winner?.minutes ?? 0) ? hour : winner, undefined as typeof activity.hours[number] | undefined);
    const card = this.metric(parent, 'Most active hour', best?.minutes ? `${String(best.hour).padStart(2, '0')}:00–${String((best.hour + 1) % 24).padStart(2, '0')}:00` : this.t('No editing activity recorded yet'), 'clock');
    this.detail(card, '{count} active minutes', { count: this.number(activity.minutes) });
    const goal = this.host.settings.activityGoalMinutes * this.range;
    this.detail(card, '{done} / {target} active minutes', { done: this.number(activity.minutes), target: this.number(goal) });
    this.detail(card, 'Daily target: {count} active minutes', { count: this.number(this.host.settings.activityGoalMinutes) });
    this.progress(card, activity.minutes / Math.max(1, goal), this.t('Period activity target'));
    if (!this.host.settings.trackEditingActivity) this.detail(card, 'Editing activity is disabled');
  }

  private shuffleWalk(): void {
    this.walkPaths = sampleReportNotes(this.snapshot?.data.notes.filter((note) => !inFolder(note.path, this.host.settings.archiveFolder)) ?? [], 10).map((note) => note.path);
    this.walkIndex = 0;
  }
  private renderWalk(parent: HTMLElement, data: ReportData): void {
    const current = data.notes.find((note) => note.path === this.walkPaths[this.walkIndex]);
    this.caption(parent, 'A queue of up to 10 notes from your existing folders.');
    const title = parent.createDiv({ cls: 'tangrow-report-walk-current', text: current?.name ?? this.t('No notes to revisit') });
    if (current) setTooltip(title, current.path);
    this.detail(parent, '{index} / {total} notes', { index: current ? this.walkIndex + 1 : 0, total: this.walkPaths.length });
    const controls = parent.createDiv({ cls: 'tangrow-report-walk-controls' });
    const previous = this.control(controls, 'Previous note', 'chevron-left', () => { this.walkIndex--; this.render(); });
    previous.disabled = this.walkIndex <= 0;
    const next = this.control(controls, 'Next note', 'chevron-right', () => { this.walkIndex++; this.render(); });
    next.disabled = this.walkIndex >= this.walkPaths.length - 1;
    const open = this.control(controls, 'Open selected note', 'arrow-up-right', () => current ? this.host.openNote(current.path) : undefined);
    open.disabled = !current;
    this.control(parent, 'Shuffle 10 notes', 'shuffle', () => { this.shuffleWalk(); this.render(); });
  }
  private randomOrphan(parent: HTMLElement, data: ReportData): void {
    const control = this.control(parent, 'Open a random orphan', 'shuffle', async () => {
      const latest = await this.host.loadReport(this.range);
      if (!this.mounted) return;
      this.snapshot = latest;
      if (!latest.quality.linksReady) { this.render(); return; }
      const note = sampleReportNotes(latest.data.orphanNotes, 1)[0];
      if (note) await this.host.openNote(note.path);
    });
    control.disabled = !data.orphanNotes.length || !this.snapshot?.quality.linksReady;
  }

  private renderActions(parent: HTMLElement, data: ReportData): void {
    const panel = this.panel(parent, 'Actions', 'Actions use your configured folders and existing notes.');
    const grid = panel.createDiv({ cls: 'tangrow-report-base-grid' });
    this.control(grid, 'Review unfinished tasks', 'square', () => { this.selectPage('tasks'); this.statusFilter = 'open'; this.render(); });
    this.control(grid, 'Review orphan notes', 'unlink', () => { this.selectPage('notes'); this.noteRole = 'orphans'; this.render(); });
    this.control(grid, 'Review saved captures', 'inbox', () => { this.selectPage('notes'); this.noteRole = 'captures'; this.render(); });
    for (const [page, label] of [['projects', 'Review projects'], ['areas', 'Review areas'], ['clips', 'Review clips']] as const) this.control(grid, label, 'arrow-right', () => this.selectPage(page));
    this.control(grid, 'Open existing task overview', 'list-checks', () => this.host.action('task-overview'));
    this.control(grid, "Open today's journal", 'calendar-days', () => this.host.action('daily-note'));
    this.control(grid, 'Open shared capture window', 'external-link', () => this.host.openCaptureWindow());
    this.randomOrphan(panel, data);
    this.renderWalk(this.panel(parent, 'Random walk'), data);
    const databases = this.panel(parent, 'Browse the companion Bases', 'These views query notes in their current locations.');
    const bases = databases.createDiv({ cls: 'tangrow-report-base-grid' });
    for (const definition of baseDefinitions(this.host.settings)) this.control(bases, definition.name, 'table', () => this.host.openBase(definition.id), undefined, true);
  }

  private filters(parent: HTMLElement, status = false, roles = false): void {
    const controls = parent.createDiv({ cls: 'tangrow-report-filters' });
    const search = controls.createEl('input', { cls: 'tangrow-report-search', type: 'search', value: this.query, attr: { placeholder: this.t('Search names, paths or task text'), 'aria-label': this.t('Search report records') } });
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
    const panel = this.panel(parent, 'Tasks', 'Checkboxes are counted in their source notes; support and archive folders are excluded.');
    this.completion(panel, data.completion.tasks);
    this.caption(panel, 'Completion excludes cancelled and unknown states.');
    this.filters(panel, true);
    const records = data.taskItems.filter((task) => (this.statusFilter === 'all' || this.taskStatus(task) === this.statusFilter) && this.matches(task.name, task.path, task.text));
    const visible = this.paginate(panel, records);
    const body = this.table(panel, ['Tasks', 'Status', 'Location'], 'Tasks');
    for (const task of visible) {
      const row = body.createEl('tr');
      this.control(row.createEl('td'), task.text || task.name, 'arrow-up-right', () => this.host.openNote(task.path, task.line), undefined, true).dataset.reportFocus = `task-${task.path}-${task.line}`;
      this.statusEditor(row.createEl('td'), `task-${task.path}-${task.line}`, task.text || task.name, task.status === 'X' ? 'x' : task.status, TASK_STATUSES,
        (status) => ({ kind: 'task', task, status: status as ReportTaskStatus }), this.t('Update the checkbox in {path}, line {line}.', { path: task.path, line: task.line + 1 }));
      const source = row.createEl('td', { text: task.path });
      this.caption(source, 'Source note · line {line}', { line: task.line + 1 });
    }
  }

  private renderEntities(parent: HTMLElement, entities: ReportEntity[], kind: 'projects' | 'areas'): void {
    const panel = this.panel(parent, kind === 'projects' ? 'Project entities' : 'Area entities', 'Folders count once; root-level Markdown files count as individual entities.');
    this.completion(panel, this.snapshot!.data.completion[kind]);
    this.caption(panel, 'Entity status comes from its canonical note; missing or conflicting states remain unknown.');
    this.filters(panel, true);
    const records = entities.filter((entity) => (this.statusFilter === 'all' || entity.status === this.statusFilter) && this.matches(entity.name, entity.path));
    const body = this.table(panel, ['Name', 'Status', 'Notes', 'Created', 'Location'], kind === 'projects' ? 'Projects' : 'Areas');
    for (const entity of this.paginate(panel, records)) {
      const row = body.createEl('tr');
      const button = this.control(row.createEl('td'), entity.name, 'folder-open', () => entity.notePath ? this.host.openNote(entity.notePath) : undefined, undefined, true);
      button.dataset.reportFocus = `entity-${entity.path}`;
      button.disabled = !entity.notePath;
      if (!entity.notePath) setTooltip(button, this.t('No canonical note available'));
      this.entityStatus(row.createEl('td'), entity, kind);
      row.createEl('td', { text: this.number(entity.noteCount) });
      row.createEl('td', { text: this.date(entity.created) });
      row.createEl('td', { text: entity.path });
    }
  }

  private renderNotes(parent: HTMLElement, data: ReportData): void {
    renderActivityHeatmaps(parent, this.snapshot?.records ?? [], this.host, this.activityState, (year) => {
      this.activityState.year = year;
      this.activityState.selection = undefined;
      this.activityState.focusedDays = {};
      this.activityState.scrollPositions = {};
      this.render();
    });
    const panel = this.panel(parent, 'Notes', 'Support records and configured report exclusions are omitted.');
    this.caption(panel, '{count} words', { count: this.number(data.counts.words) });
    this.caption(panel, '{count} characters excluding whitespace', { count: this.number(data.counts.characters) });
    this.filters(panel, true, true);
    if (this.noteRole === 'orphans' && !this.snapshot!.quality.linksReady) {
      this.caption(panel, 'Link indexing is still in progress; orphan results may change.');
    } else {
      const orphans = new Set(data.orphanNotes.map((note) => note.path));
      const records = data.notes.filter((note) => (this.statusFilter === 'all' || reportRecordStatus(note) === this.statusFilter) && this.matches(note.name, note.path) && (this.noteRole === 'all' || this.noteRole === 'pins' && note.frontmatter?.tangrow_pin === true || this.noteRole === 'orphans' && orphans.has(note.path) || this.noteRole === 'journals' && reportJournalDay(note, this.host.settings) !== null || this.noteRole === 'captures' && note.frontmatter?.tangrow_kind === 'capture'));
      const body = this.table(panel, ['Name', 'Status', 'Words', 'Characters', 'Created', 'Modified', 'Location'], 'Notes');
      for (const note of this.paginate(panel, records)) {
        const row = body.createEl('tr');
        this.control(row.createEl('td'), note.name, 'file-text', () => this.host.openNote(note.path), undefined, true).dataset.reportFocus = `note-${note.path}`;
        this.noteStatus(row.createEl('td'), note);
        row.createEl('td', { text: note.wordCount === undefined ? this.t('Unknown') : this.number(note.wordCount) });
        row.createEl('td', { text: note.characterCount === undefined ? this.t('Unknown') : this.number(note.characterCount) });
        row.createEl('td', { text: this.date(note.created) });
        row.createEl('td', { text: this.date(note.modified) });
        row.createEl('td', { text: note.path });
      }
    }
    this.renderExclusions(parent);
  }

  private renderClips(parent: HTMLElement, data: ReportData): void {
    const panel = this.panel(parent, 'Clips', 'Clip recognition uses external HTTP(S) sources or explicit clip metadata.');
    this.completion(panel, data.completion.clips);
    this.caption(panel, 'Internal related-note links do not identify a clip.');
    this.filters(panel, true);
    const records = data.clips.filter((note) => (this.statusFilter === 'all' || reportRecordStatus(note) === this.statusFilter) && this.matches(note.name, note.path, String(note.frontmatter?.source ?? '')));
    const body = this.table(panel, ['Name', 'Status', 'Source', 'Created'], 'Clips');
    for (const note of this.paginate(panel, records)) {
      const row = body.createEl('tr');
      this.control(row.createEl('td'), note.name, 'bookmark', () => this.host.openNote(note.path), undefined, true).dataset.reportFocus = `clip-${note.path}`;
      this.noteStatus(row.createEl('td'), note);
      row.createEl('td', { text: String(note.frontmatter?.source ?? '') });
      row.createEl('td', { text: this.date(note.created) });
    }
  }

  private renderTime(parent: HTMLElement): void {
    const { activity, data } = this.snapshot!;
    const metrics = parent.createDiv({ cls: 'tangrow-report-metrics' });
    this.renderActivityMetric(metrics);
    this.metric(metrics, 'Focus timer minutes', data.counts.focusMinutes, 'timer');
    const notes = this.panel(parent, 'Editing activity', 'Collection begins with this version; earlier activity is unavailable.');
    this.caption(notes, 'Recording since {date}', { date: this.date(activity.startedAt) });
    this.caption(notes, 'Only editing event times are counted. Note text and keyboard contents are not stored.');
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
    const focus = this.panel(parent, 'Focus timer minutes', 'Saved focus sessions are separate from editing activity.');
    this.control(focus, 'Browse saved focus records', 'table', () => this.host.openBase('focus'));
  }

  private renderActivitySettings(parent: HTMLElement): void {
    const form = parent.createEl('form', { cls: 'tangrow-report-filters' });
    const label = form.createEl('label');
    const enabled = label.createEl('input', { type: 'checkbox' });
    enabled.checked = this.host.settings.trackEditingActivity;
    enabled.dataset.reportFocus = 'tracking';
    label.createSpan({ text: this.t('Enable local editing activity') });
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
    const panel = this.panel(parent, 'Report definitions', 'Support records and configured report exclusions are omitted.');
    this.caption(panel, 'Exclusions change this report only; they never move or edit notes.');
    this.caption(panel, 'Pinned notes and saved focus or habit records retain their own scope.');
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
    this.caption(panel, 'A streak may continue from yesterday when today has no record yet.');
    this.caption(panel, 'Completion excludes cancelled and unknown states.');
  }
}
