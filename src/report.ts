import { ItemView, Notice, setIcon, setTooltip, type WorkspaceLeaf } from 'obsidian';
import { baseDefinitions } from './bases';
import { aggregateReport, type ReportData, type ReportRecord } from './report-data';
import { describeError, translate, type TranslationValues } from './i18n';
import type { BaseId, SidebarHost } from './types';

export const REPORT_VIEW_TYPE = 'tangrow-report';

interface MetricSpec {
  key: keyof ReportData['counts'];
  label: string;
  icon: string;
  base?: BaseId;
}

const METRICS: MetricSpec[] = [
  { key: 'notes', label: 'Markdown notes', icon: 'files', base: 'notes' },
  { key: 'projectNotes', label: 'Notes in project folders', icon: 'folder-kanban', base: 'projects' },
  { key: 'areaNotes', label: 'Notes in area folders', icon: 'layers', base: 'areas' },
  { key: 'resourceNotes', label: 'Notes in resource folders', icon: 'library', base: 'resources' },
  { key: 'sourceNotes', label: 'Notes with sources', icon: 'link', base: 'sources' },
  { key: 'captures', label: 'Saved captures', icon: 'inbox', base: 'captures' },
  { key: 'pins', label: 'Pinned notes total', icon: 'pin', base: 'pins' },
  { key: 'drafts', label: 'Saved writing drafts', icon: 'pen-line', base: 'drafts' },
  { key: 'openTasks', label: 'Unfinished checkboxes', icon: 'square' },
  { key: 'completedTasks', label: 'Completed checkboxes', icon: 'square-check' },
  { key: 'focusMinutes', label: 'Recorded focus minutes', icon: 'timer', base: 'focus' },
  { key: 'habitCheckinsToday', label: 'Habit check-ins today', icon: 'calendar-check', base: 'habits' }
];

export class TangrowReport extends ItemView {
  private unsubscribe?: () => void;
  private refreshTimer?: number;
  private epoch = 0;
  private mounted = false;

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
    this.epoch++;
    window.clearTimeout(this.refreshTimer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.contentEl.empty();
  }

  refreshLanguage(): void { void this.refresh(); }

  private t(source: string, values?: TranslationValues): string {
    return translate(this.host.settings.language, source, values);
  }

  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => { void this.refresh(); }, 180);
  }

  private async refresh(): Promise<void> {
    const revision = ++this.epoch;
    const records: ReportRecord[] = this.host.app.vault.getMarkdownFiles().map((file) => {
      const cache = this.host.app.metadataCache.getFileCache(file);
      return {
        path: file.path,
        name: file.basename,
        created: file.stat.ctime,
        modified: file.stat.mtime,
        frontmatter: cache?.frontmatter,
        tasks: cache?.listItems?.flatMap((item) => item.task === undefined ? [] : [item.task])
      };
    });
    const data = aggregateReport(records, this.host.settings);
    await Promise.resolve();
    if (!this.mounted || revision !== this.epoch) return;
    this.render(data, records);
  }

  private control(parent: HTMLElement, label: string, icon: string, run: () => void | Promise<void>, localize = true): HTMLButtonElement {
    const text = localize ? this.t(label) : label;
    const button = parent.createEl('button', { cls: 'tangrow-report-control', attr: { type: 'button', 'aria-label': text } });
    const symbol = button.createSpan({ cls: 'tangrow-report-icon' });
    setIcon(symbol, icon);
    button.createSpan({ text });
    button.addEventListener('click', () => {
      if (button.disabled) return;
      button.disabled = true;
      Promise.resolve().then(run).catch((error: unknown) => new Notice(describeError(this.host.settings.language, error))).finally(() => { button.disabled = false; });
    });
    return button;
  }

  private heading(parent: HTMLElement, title: string, detail?: string): void {
    parent.createEl('h2', { text: this.t(title) });
    if (detail) parent.createEl('p', { cls: 'tangrow-report-caption', text: this.t(detail) });
  }

  private render(data: ReportData, records: ReportRecord[]): void {
    const scrollTop = this.contentEl.scrollTop;
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: 'tangrow-report-shell' });
    const header = shell.createDiv({ cls: 'tangrow-report-header' });
    const introduction = header.createDiv();
    introduction.createSpan({ cls: 'tangrow-report-eyebrow', text: this.t('LOCAL REPORT') });
    introduction.createEl('h1', { text: this.t('Vault overview') });
    introduction.createEl('p', { cls: 'tangrow-report-caption', text: this.t('A read-only view of the notes already in your folders.') });
    const actions = header.createDiv({ cls: 'tangrow-report-toolbar' });
    this.control(actions, 'Refresh report', 'refresh-cw', () => this.refresh());
    this.control(actions, 'Browse all notes', 'table', () => this.host.openBase('notes'));

    const metrics = shell.createDiv({ cls: 'tangrow-report-metrics', attr: { 'aria-label': this.t('Vault totals') } });
    for (const metric of METRICS) {
      const card = metrics.createDiv({ cls: 'tangrow-report-metric' });
      const row = card.createDiv({ cls: 'tangrow-report-metric-label' });
      const icon = row.createSpan({ cls: 'tangrow-report-icon' });
      setIcon(icon, metric.icon);
      row.createSpan({ text: this.t(metric.label) });
      const value = data.counts[metric.key];
      card.createEl('strong', { text: value.toLocaleString(this.host.settings.language, { maximumFractionDigits: 2 }) });
      if (metric.base) {
        const base = metric.base;
        const control = this.control(card, 'Browse records', 'arrow-up-right', () => this.host.openBase(base));
        control.addClass('tangrow-report-metric-link');
      }
    }

    const columns = shell.createDiv({ cls: 'tangrow-report-columns' });
    const activity = columns.createDiv({ cls: 'tangrow-report-panel' });
    this.heading(activity, 'Files created per day (30 days)', 'Based on file creation timestamps, which can change when notes are imported or restored.');
    const total = data.days.reduce((sum, item) => sum + item.count, 0);
    const chart = activity.createDiv({ cls: 'tangrow-report-chart', attr: { role: 'img', 'aria-label': this.t('{count} notes created across the last 30 days.', { count: total }) } });
    const maximum = Math.max(1, ...data.days.map((item) => item.count));
    for (const item of data.days) {
      const slot = chart.createDiv({ cls: 'tangrow-report-bar-slot' });
      const bar = slot.createDiv({ cls: `tangrow-report-bar${item.count ? ' has-notes' : ''}` });
      bar.style.height = `${item.count ? Math.max(4, item.count / maximum * 100) : 2}%`;
      setTooltip(slot, this.t('{day}: {count} notes', { day: item.day, count: item.count }));
    }
    const axis = activity.createDiv({ cls: 'tangrow-report-chart-axis' });
    axis.createSpan({ text: data.days[0]?.day ?? '' });
    axis.createSpan({ text: this.t('{count} notes created', { count: total }) });
    axis.createSpan({ text: data.days.at(-1)?.day ?? '' });

    const recent = columns.createDiv({ cls: 'tangrow-report-panel' });
    this.heading(recent, 'Recently edited notes', 'Support records are excluded from the note list.');
    if (!data.recent.length) recent.createEl('p', { cls: 'tangrow-report-caption', text: this.t('No notes are available yet.') });
    for (const note of data.recent) {
      const control = this.control(recent, note.name, 'file-text', () => this.host.openNote(note.path), false);
      control.addClass('tangrow-report-note-row');
      setTooltip(control, note.path);
      control.createSpan({ cls: 'tangrow-report-note-time', text: new Date(note.modified).toLocaleDateString(this.host.settings.language) });
    }

    const tasks = shell.createDiv({ cls: 'tangrow-report-panel' });
    this.heading(tasks, 'Checkboxes in your notes', 'Pending and in-progress checkboxes stay in their source notes. They are not rows in the task-note Base.');
    const summary = tasks.createDiv({ cls: 'tangrow-report-task-summary' });
    summary.createSpan({ text: this.t('{count} unfinished', { count: data.counts.openTasks }) });
    summary.createSpan({ text: this.t('{count} completed', { count: data.counts.completedTasks }) });
    summary.createSpan({ text: this.t('{count} cancelled', { count: data.counts.cancelledTasks }) });
    const taskFiles = records.filter((record) => !this.within(record.path, this.host.settings.supportFolder) && !this.within(record.path, this.host.settings.archiveFolder) && record.tasks?.some((state) => state === ' ' || state === '/'))
      .sort((left, right) => right.modified - left.modified).slice(0, 6);
    if (!taskFiles.length) tasks.createEl('p', { cls: 'tangrow-report-caption', text: this.t('There are no unfinished checkboxes in the indexed notes.') });
    const taskList = tasks.createDiv({ cls: 'tangrow-report-task-sources' });
    for (const record of taskFiles) {
      const control = this.control(taskList, record.name, 'list-checks', () => this.host.openNote(record.path), false);
      const count = record.tasks?.filter((state) => state === ' ' || state === '/').length ?? 0;
      control.createSpan({ cls: 'tangrow-report-task-count', text: this.t('{count} pending', { count }) });
      setTooltip(control, record.path);
    }

    const databases = shell.createDiv({ cls: 'tangrow-report-panel' });
    this.heading(databases, 'Browse the companion Bases', 'These views query notes in their current locations.');
    const grid = databases.createDiv({ cls: 'tangrow-report-base-grid' });
    for (const definition of baseDefinitions(this.host.settings)) {
      const control = this.control(grid, definition.name, 'table', () => this.host.openBase(definition.id), false);
      setTooltip(control, definition.description);
    }
    const footer = shell.createDiv({ cls: 'tangrow-report-footer' });
    footer.createSpan({ text: this.t('Focus minutes come from saved sessions, not keyboard or editing activity.') });
    footer.createSpan({ text: this.t('Refreshed at {time}', { time: new Date().toLocaleTimeString(this.host.settings.language) }) });
    this.contentEl.scrollTop = scrollTop;
  }

  private within(path: string, folder: string): boolean { return path.startsWith(`${folder}/`); }
}
