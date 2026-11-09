import { Notice, setIcon, setTooltip } from 'obsidian';
import { captureCalendar, captureDay, groupCapturesByDay, shiftCaptureMonth } from './capture-data';
import { capturePreview } from './capture-preview';
import { CaptureProcessingModal } from './capture-processing-modal';
import { describeError, translate } from './i18n';
import type { TranslationValues } from './i18n';
import type { CaptureSummary, SidebarHost } from './types';

const PAGE_SIZE = 12;
const PREVIEW_CONCURRENCY = 3;
const PREVIEW_CACHE_SIZE = 200;

interface CapturePanelOptions { allowPopout?: boolean }
interface PreviewJob { key: string; path: string; targets: Set<HTMLElement> }

export class CapturePanel {
  private readonly instanceId = `tangrow-capture-${crypto.randomUUID()}`;
  private root?: HTMLElement;
  private editor?: HTMLTextAreaElement;
  private saveButton?: HTMLButtonElement;
  private count?: HTMLElement;
  private destination?: HTMLElement;
  private calendarTitle?: HTMLElement;
  private monthCount?: HTMLElement;
  private weekdays?: HTMLElement;
  private calendarGrid?: HTMLElement;
  private timelineTitle?: HTMLElement;
  private timelineCount?: HTMLElement;
  private statusFilter?: HTMLSelectElement;
  private captureFilter: 'pending' | 'processed' | 'all' = 'pending';
  private timeline?: HTMLElement;
  private footer?: HTMLElement;
  private allDaysButton?: HTMLButtonElement;
  private labels: Array<{ element: HTMLElement; source: string; values?: TranslationValues }> = [];
  private buttonLabels = new Map<HTMLButtonElement, { source: string; values?: TranslationValues }>();
  private unsubscribe?: () => void;
  private unsubscribeComposer?: () => void;
  private selectedDay: string | null = null;
  private focusedDay = captureDay(Date.now());
  private year = new Date().getFullYear();
  private monthIndex = new Date().getMonth();
  private limit = PAGE_SIZE;
  private calendarSignature = '';
  private timelineSignature = '';
  private language = '';
  private submitting = false;
  private composing = false;
  private mounted = false;
  private dayButtons = new Map<string, HTMLButtonElement>();
  private previewCache = new Map<string, string | null>();
  private previewJobs = new Map<string, PreviewJob>();
  private previewQueue: PreviewJob[] = [];
  private activeReads = 0;

  constructor(private readonly host: SidebarHost, private readonly options: CapturePanelOptions = {}) {}

  mount(container: HTMLElement): void {
    if (this.mounted) this.destroy();
    this.mounted = true;
    this.root = container.createDiv({ cls: 'tangrow-capture-panel' });
    this.labels = [];
    this.buttonLabels.clear();
    this.label(this.root, 'h3', 'Capture a thought', 'tangrow-section-title');
    this.label(this.root, 'p', 'A small note in your existing inbox, ready to organize when you are.', 'tangrow-section-caption');
    const composer = this.root.createDiv({ cls: 'tangrow-composer' });
    this.editor = composer.createEl('textarea', { cls: 'tangrow-textarea', attr: { rows: '6' } });
    this.editor.value = this.host.loadComposer().capture;
    this.editor.addEventListener('compositionstart', () => { this.composing = true; });
    this.editor.addEventListener('compositionend', () => {
      this.composing = false;
      if (this.editor) this.host.saveComposer({ capture: this.editor.value });
      this.syncComposer();
    });
    this.editor.addEventListener('input', () => {
      if (this.editor) this.host.saveComposer({ capture: this.editor.value });
      this.updateComposerControls();
    });
    this.editor.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        this.saveButton?.click();
      }
    });
    const composerFooter = composer.createDiv({ cls: 'tangrow-composer-footer' });
    this.count = composerFooter.createSpan({ cls: 'tangrow-muted' });
    this.saveButton = this.button(composerFooter, 'Save capture', () => this.submit(), 'arrow-up-right', 'mod-cta');
    this.destination = this.root.createEl('p', { cls: 'tangrow-destination' });
    if (this.options.allowPopout !== false) {
      this.button(this.root, 'Open capture window', () => this.host.openCaptureWindow(), 'external-link', 'tangrow-full-width tangrow-capture-popout');
    }

    const calendar = this.root.createEl('section', { cls: 'tangrow-capture-calendar' });
    const calendarHeader = calendar.createDiv({ cls: 'tangrow-capture-calendar-heading' });
    this.button(calendarHeader, 'Previous month', () => this.moveMonth(-1), 'chevron-left', 'tangrow-capture-icon-button');
    this.calendarTitle = calendarHeader.createEl('h3', { attr: { id: `${this.instanceId}-month`, 'aria-live': 'polite' } });
    this.button(calendarHeader, 'Next month', () => this.moveMonth(1), 'chevron-right', 'tangrow-capture-icon-button');
    this.weekdays = calendar.createDiv({ cls: 'tangrow-capture-weekdays', attr: { 'aria-hidden': 'true' } });
    this.calendarGrid = calendar.createDiv({ cls: 'tangrow-capture-days', attr: { role: 'group', 'aria-labelledby': `${this.instanceId}-month` } });
    const calendarFooter = calendar.createDiv({ cls: 'tangrow-capture-calendar-footer' });
    this.monthCount = calendarFooter.createSpan({ cls: 'tangrow-muted' });
    const calendarActions = calendarFooter.createDiv({ cls: 'tangrow-capture-calendar-actions' });
    this.button(calendarActions, 'Today', () => this.selectToday(), undefined, 'tangrow-text-button');
    this.allDaysButton = this.button(calendarActions, 'All days', () => {
      this.selectedDay = null;
      this.limit = PAGE_SIZE;
      this.refresh();
    }, undefined, 'tangrow-text-button');

    const timelineHeader = this.root.createDiv({ cls: 'tangrow-capture-timeline-heading' });
    this.timelineTitle = this.label(timelineHeader, 'h3', 'Capture timeline', 'tangrow-section-title');
    this.statusFilter = this.root.createEl('select', { cls: 'tangrow-capture-filter' });
    for (const value of ['pending', 'processed', 'all']) this.statusFilter.createEl('option', { value });
    this.statusFilter.value = this.captureFilter;
    this.statusFilter.addEventListener('change', () => {
      this.captureFilter = this.statusFilter!.value as typeof this.captureFilter;
      this.limit = PAGE_SIZE;
      this.refresh();
    });
    this.timelineCount = timelineHeader.createSpan({ cls: 'tangrow-muted', attr: { 'aria-live': 'polite' } });
    this.timeline = this.root.createDiv({ cls: 'tangrow-capture-timeline' });
    this.footer = this.root.createDiv({ cls: 'tangrow-capture-pagination' });
    this.button(this.root, 'Browse capture database', () => this.host.openBase('captures'), 'table', 'tangrow-full-width');
    this.unsubscribe = this.host.subscribe(() => this.refresh());
    this.unsubscribeComposer = this.host.subscribeComposer(() => this.syncComposer());
    this.calendarSignature = '';
    this.timelineSignature = '';
    this.language = '';
    this.refresh();
  }

  refresh(): void {
    if (!this.mounted || !this.root) return;
    this.labels = this.labels.filter(({ element }) => this.root?.contains(element));
    for (const control of this.buttonLabels.keys()) if (!this.root.contains(control)) this.buttonLabels.delete(control);
    const languageChanged = this.language !== this.host.settings.language;
    const scrollParent = languageChanged ? this.root.closest<HTMLElement>('.tangrow-sidebar, .tangrow-capture-window') : null;
    const scrollTop = scrollParent?.scrollTop;
    this.language = this.host.settings.language;
    if (languageChanged) {
      for (const { element, source, values } of this.labels) element.textContent = this.t(source, values);
      this.root.setAttribute('aria-label', this.t('Quick capture'));
      this.editor?.setAttribute('placeholder', this.t('An idea, a question, a link...'));
      this.statusFilter?.setAttribute('aria-label', this.t('Capture status'));
      const labels = { pending: 'Pending captures', processed: 'Processed captures', all: 'All captures' };
      for (const option of Array.from(this.statusFilter?.options ?? [])) option.textContent = this.t(labels[option.value as keyof typeof labels]);
      this.editor?.setAttribute('aria-label', this.t('Quick capture'));
      this.calendarGrid?.setAttribute('aria-label', this.t('Capture days'));
      this.timeline?.setAttribute('aria-labelledby', `${this.instanceId}-timeline`);
      this.timelineTitle?.setAttribute('id', `${this.instanceId}-timeline`);
      this.renderWeekdays();
    }
    if (this.destination) this.destination.textContent = this.t('Destination: {path}', { path: this.host.settings.inboxFolder });
    this.syncComposer();
    const captures = this.host.snapshot().captures;
    const fingerprint = captures.map((capture) => [capture.path, capture.created, capture.modified, capture.name, capture.processed, capture.processing]);
    const calendarSignature = JSON.stringify([this.language, this.year, this.monthIndex, this.selectedDay, this.focusedDay, captureDay(Date.now()), fingerprint]);
    const timelineSignature = JSON.stringify([this.language, this.selectedDay, this.captureFilter, this.limit, fingerprint]);
    if (calendarSignature !== this.calendarSignature) {
      this.calendarSignature = calendarSignature;
      this.renderCalendar(captures);
    }
    if (timelineSignature !== this.timelineSignature) {
      this.timelineSignature = timelineSignature;
      this.renderTimeline(captures);
      this.labels = this.labels.filter(({ element }) => this.root?.contains(element));
      for (const control of this.buttonLabels.keys()) if (!this.root.contains(control)) this.buttonLabels.delete(control);
    }
    if (scrollParent && scrollTop !== undefined) scrollParent.scrollTop = scrollTop;
  }

  destroy(): void {
    this.mounted = false;
    this.unsubscribe?.();
    this.unsubscribeComposer?.();
    this.unsubscribe = undefined;
    this.unsubscribeComposer = undefined;
    this.previewQueue = [];
    this.previewJobs.clear();
    this.dayButtons.clear();
    this.root?.remove();
    this.root = undefined;
    this.editor = undefined;
    this.statusFilter = undefined;
    this.labels = [];
    this.buttonLabels.clear();
  }

  private t(source: string, values?: TranslationValues): string {
    return translate(this.host.settings.language, source, values);
  }

  private number(value: number): string { return value.toLocaleString(this.host.settings.language); }

  private label(parent: HTMLElement, tag: 'h3' | 'p' | 'span', source: string, cls: string, values?: TranslationValues): HTMLElement {
    const element = parent.createEl(tag, { text: this.t(source, values), cls });
    this.labels.push({ element, source, values });
    return element;
  }

  private button(parent: HTMLElement, source: string, handler: () => void | Promise<void>, iconName?: string, cls = '', values?: TranslationValues): HTMLButtonElement {
    const control = parent.createEl('button', { cls: `tangrow-button ${cls}`, attr: { type: 'button', 'aria-label': this.t(source, values) } });
    if (iconName) {
      const icon = control.createSpan({ cls: 'tangrow-icon' });
      setIcon(icon, iconName);
    }
    this.label(control, 'span', source, 'tangrow-capture-button-label', values);
    this.buttonLabels.set(control, { source, values });
    control.addEventListener('click', () => {
      if (control.disabled || control.getAttribute('aria-busy') === 'true') return;
      control.setAttribute('aria-busy', 'true');
      void Promise.resolve().then(handler).catch((error: unknown) => new Notice(describeError(this.host.settings.language, error))).finally(() => control.removeAttribute('aria-busy'));
    });
    return control;
  }

  private syncComposer(): void {
    if (!this.mounted || !this.editor) return;
    const value = this.host.loadComposer().capture;
    if (value !== this.editor.value && !this.composing) {
      const focused = this.editor.ownerDocument.activeElement === this.editor;
      const start = this.editor.selectionStart;
      const end = this.editor.selectionEnd;
      const direction = this.editor.selectionDirection;
      const scroll = this.editor.scrollTop;
      this.editor.value = value;
      if (focused) this.editor.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length), direction);
      this.editor.scrollTop = scroll;
    }
    this.updateComposerControls();
  }

  private updateComposerControls(): void {
    const text = this.host.loadComposer().capture;
    if (this.count) this.count.textContent = text.length ? this.t('{count} characters', { count: this.number(Array.from(text).length) }) : this.t('Saved as Markdown');
    if (this.saveButton) {
      this.saveButton.disabled = this.submitting || !text.trim();
      this.saveButton.setAttribute('aria-label', this.t(this.submitting ? 'Saving capture...' : 'Save capture'));
      const label = this.saveButton.querySelector('.tangrow-capture-button-label');
      if (label) label.textContent = this.t(this.submitting ? 'Saving capture...' : 'Save capture');
    }
    for (const [control, { source, values }] of this.buttonLabels) {
      if (control !== this.saveButton) control.setAttribute('aria-label', this.t(source, values));
    }
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.host.loadComposer().capture.trim()) return;
    this.submitting = true;
    this.updateComposerControls();
    const editor = this.editor;
    try {
      await this.host.submitCaptureDraft();
      this.syncComposer();
      const active = editor?.ownerDocument.activeElement;
      if (this.mounted && editor?.isConnected && (active === editor || active === this.saveButton)) editor.focus({ preventScroll: true });
    } finally {
      this.submitting = false;
      if (this.mounted) this.updateComposerControls();
    }
  }

  private renderWeekdays(): void {
    if (!this.weekdays) return;
    this.weekdays.empty();
    for (let index = 0; index < 7; index++) {
      const day = new Date(2024, 0, index + 1, 12);
      this.weekdays.createSpan({ text: day.toLocaleDateString(this.host.settings.language, { weekday: 'short' }) });
    }
  }

  private renderCalendar(captures: CaptureSummary[]): void {
    if (!this.calendarGrid || !this.calendarTitle) return;
    const cells = captureCalendar(captures, this.year, this.monthIndex);
    this.calendarTitle.textContent = new Date(this.year, this.monthIndex, 1, 12).toLocaleDateString(this.host.settings.language, { year: 'numeric', month: 'long' });
    if (this.monthCount) this.monthCount.textContent = this.t('{count} captures this month', { count: this.number(cells.filter((cell) => cell.inMonth).reduce((sum, cell) => sum + cell.count, 0)) });
    if (this.allDaysButton) this.allDaysButton.setAttribute('aria-pressed', String(this.selectedDay === null));
    const active = this.calendarGrid.ownerDocument.activeElement as HTMLElement | null;
    const activeDay = this.calendarGrid.contains(active) ? active?.dataset.captureDate : undefined;
    this.calendarGrid.empty();
    this.dayButtons.clear();
    const focusDate = cells.some((cell) => cell.date === this.focusedDay) ? this.focusedDay : cells.find((cell) => cell.inMonth)?.date;
    for (const cell of cells) {
      const date = new Date(`${cell.date}T12:00:00`);
      const fullDate = date.toLocaleDateString(this.host.settings.language, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
      const label = this.t('{date}: {count} captures', { date: fullDate, count: this.number(cell.count) });
      const control = this.calendarGrid.createEl('button', {
        cls: `tangrow-capture-day${cell.inMonth ? '' : ' is-other-month'}${cell.today ? ' is-today' : ''}${this.selectedDay === cell.date ? ' is-selected' : ''}`,
        attr: { type: 'button', 'aria-label': label, 'aria-pressed': String(this.selectedDay === cell.date) }
      });
      control.dataset.captureDate = cell.date;
      control.tabIndex = cell.date === focusDate ? 0 : -1;
      if (cell.today) control.setAttribute('aria-current', 'date');
      control.createSpan({ cls: 'tangrow-capture-day-number', text: this.number(cell.day) });
      if (cell.count) control.createSpan({ cls: 'tangrow-capture-day-count', text: this.number(cell.count) });
      setTooltip(control, label);
      control.addEventListener('click', () => this.selectDay(cell.date));
      control.addEventListener('keydown', (event) => this.navigateCalendar(event, cell.date));
      this.dayButtons.set(cell.date, control);
    }
    if (activeDay) this.dayButtons.get(activeDay)?.focus({ preventScroll: true });
  }

  private selectDay(date: string): void {
    const selected = new Date(`${date}T12:00:00`);
    this.selectedDay = date;
    this.focusedDay = date;
    this.year = selected.getFullYear();
    this.monthIndex = selected.getMonth();
    this.limit = PAGE_SIZE;
    this.refresh();
    this.dayButtons.get(date)?.focus({ preventScroll: true });
  }

  private selectToday(): void { this.selectDay(captureDay(Date.now())); }

  private moveMonth(offset: number): void {
    const next = shiftCaptureMonth(this.year, this.monthIndex, offset);
    this.year = next.year;
    this.monthIndex = next.monthIndex;
    this.refresh();
  }

  private navigateCalendar(event: KeyboardEvent, date: string): void {
    const movement: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const next = new Date(`${date}T12:00:00`);
    const weekday = (next.getDay() + 6) % 7;
    if (Object.hasOwn(movement, event.key)) next.setDate(next.getDate() + (movement[event.key] ?? 0));
    else if (event.key === 'Home') next.setDate(next.getDate() - weekday);
    else if (event.key === 'End') next.setDate(next.getDate() + 6 - weekday);
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const month = shiftCaptureMonth(next.getFullYear(), next.getMonth(), event.key === 'PageUp' ? -1 : 1);
      const day = Math.min(next.getDate(), new Date(month.year, month.monthIndex + 1, 0).getDate());
      next.setFullYear(month.year, month.monthIndex, day);
    } else return;
    event.preventDefault();
    this.focusedDay = captureDay(next.getTime());
    this.year = next.getFullYear();
    this.monthIndex = next.getMonth();
    this.refresh();
    this.dayButtons.get(this.focusedDay)?.focus({ preventScroll: true });
  }

  private renderTimeline(captures: CaptureSummary[]): void {
    if (!this.timeline || !this.timelineCount || !this.footer) return;
    const filtered = captures.filter((capture) => (!this.selectedDay || captureDay(capture.created) === this.selectedDay)
      && (this.captureFilter === 'all' || Boolean(capture.processed) === (this.captureFilter === 'processed')));
    const formattedDay = this.selectedDay ? new Date(`${this.selectedDay}T12:00:00`).toLocaleDateString(this.host.settings.language, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    const countLabel = this.captureFilter === 'pending' ? 'Pending captures · {count}' : this.captureFilter === 'processed' ? 'Processed captures · {count}' : 'All captures · {count}';
    this.timelineCount.textContent = this.selectedDay ? this.t('{date}: {count} captures', { date: formattedDay, count: this.number(filtered.length) }) : this.t(countLabel, { count: this.number(filtered.length) });
    const active = this.timeline.ownerDocument.activeElement as HTMLElement | null;
    const activePath = this.timeline.contains(active) ? active?.dataset.captureSource : undefined;
    this.timeline.empty();
    this.footer.empty();
    if (!filtered.length) {
      const empty = this.timeline.createDiv({ cls: 'tangrow-empty' });
      const hasCaptures = captures.length > 0;
      empty.createEl('strong', { text: this.t(hasCaptures ? 'No captures match this filter' : this.selectedDay ? 'No captures on this day' : 'Your first thought starts here') });
      empty.createEl('p', { cls: 'tangrow-muted', text: this.t(hasCaptures ? 'Choose another status or date to browse your captures.' : this.selectedDay ? 'Choose another day, or save a new thought above.' : 'Saved captures will appear by their creation date.') });
      return;
    }
    const visible = groupCapturesByDay(filtered).flatMap((group) => group.captures).slice(0, this.limit);
    let entryIndex = 0;
    for (const group of groupCapturesByDay(visible)) {
      const day = this.timeline.createEl('section', { cls: 'tangrow-capture-timeline-day' });
      day.createEl('h4', { text: new Date(`${group.date}T12:00:00`).toLocaleDateString(this.host.settings.language, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }) });
      for (const capture of group.captures) {
        const article = day.createEl('article', { cls: 'tangrow-capture-entry' });
        const heading = article.createDiv({ cls: 'tangrow-capture-entry-heading' });
        const date = new Date(capture.created);
        heading.createEl('time', { text: date.toLocaleTimeString(this.host.settings.language, { hour: '2-digit', minute: '2-digit' }), attr: { datetime: date.toISOString(), 'aria-label': date.toLocaleString(this.host.settings.language) } });
        const open = this.button(heading, 'Open source note', () => this.host.openNote(capture.path), 'arrow-up-right', 'tangrow-text-button tangrow-capture-open-source');
        open.dataset.captureSource = capture.path;
        setTooltip(open, capture.path);
        const entryId = `${this.instanceId}-entry-${entryIndex++}`;
        const sourceLabel = open.querySelector<HTMLElement>('.tangrow-capture-button-label');
        sourceLabel?.setAttribute('id', `${entryId}-action`);
        article.createEl('strong', { cls: 'tangrow-capture-entry-title', text: capture.name, attr: { id: `${entryId}-title` } });
        if (sourceLabel) open.setAttribute('aria-labelledby', `${entryId}-action ${entryId}-title`);
        const preview = article.createEl('p', { cls: 'tangrow-capture-snippet', text: this.t('Loading preview...') });
        this.loadPreview(capture, preview);
        const actions = article.createDiv({ cls: 'tangrow-capture-entry-actions' });
        if (capture.processed) {
          actions.createSpan({ cls: 'tangrow-muted', text: this.t('Processed') });
          const pending = this.button(actions, 'Move back to pending', async () => { await this.host.processCapture(capture.path, { action: 'pending' }); }, 'undo-2', 'tangrow-text-button');
          setTooltip(pending, this.t('Saved results are kept.'));
        } else this.button(actions, capture.processing ? 'Continue processing' : 'Process capture', async () => {
          if (capture.processing) await this.host.processCapture(capture.path, { action: 'resume' });
          else new CaptureProcessingModal(this.host, capture).open();
        }, 'check-check', 'tangrow-text-button');
      }
    }
    this.footer.createSpan({ cls: 'tangrow-muted', text: this.t('Showing {shown} of {total} captures', { shown: this.number(visible.length), total: this.number(filtered.length) }) });
    if (visible.length < filtered.length) {
      const count = Math.min(PAGE_SIZE, filtered.length - visible.length);
      this.button(this.footer, 'Load {count} more', () => {
        const previousLimit = this.limit;
        this.limit += PAGE_SIZE;
        this.refresh();
        this.timeline?.querySelectorAll<HTMLButtonElement>('button[data-capture-source]')[previousLimit]?.focus();
      }, 'chevrons-down', 'tangrow-full-width', { count: this.number(count) });
    }
    if (activePath) Array.from(this.timeline.querySelectorAll<HTMLButtonElement>('button[data-capture-source]')).find((control) => control.dataset.captureSource === activePath)?.focus({ preventScroll: true });
  }

  private loadPreview(capture: CaptureSummary, target: HTMLElement): void {
    const key = `${capture.path}\u0000${capture.modified}`;
    if (this.previewCache.has(key)) {
      const value = this.previewCache.get(key);
      target.textContent = value === null ? this.t('Preview unavailable') : value || this.t('No text preview');
      return;
    }
    const pending = this.previewJobs.get(key);
    if (pending) { pending.targets.add(target); return; }
    const job: PreviewJob = { key, path: capture.path, targets: new Set([target]) };
    this.previewJobs.set(key, job);
    this.previewQueue.push(job);
    this.pumpPreviews();
  }

  private pumpPreviews(): void {
    while (this.mounted && this.activeReads < PREVIEW_CONCURRENCY && this.previewQueue.length) {
      const job = this.previewQueue.shift();
      if (!job) break;
      job.targets = new Set(Array.from(job.targets).filter((target) => this.root?.contains(target)));
      if (!job.targets.size) { this.previewJobs.delete(job.key); continue; }
      this.activeReads++;
      void this.host.readCapture(job.path).then((content) => {
        const value = capturePreview(content);
        this.previewCache.set(job.key, value);
        for (const target of job.targets) if (this.mounted && this.root?.contains(target)) target.textContent = value || this.t('No text preview');
      }).catch(() => {
        this.previewCache.set(job.key, null);
        for (const target of job.targets) if (this.mounted && this.root?.contains(target)) target.textContent = this.t('Preview unavailable');
      }).finally(() => {
        this.activeReads--;
        if (this.previewJobs.get(job.key) === job) this.previewJobs.delete(job.key);
        while (this.previewCache.size > PREVIEW_CACHE_SIZE) {
          const oldest = this.previewCache.keys().next().value;
          if (oldest === undefined) break;
          this.previewCache.delete(oldest);
        }
        this.pumpPreviews();
      });
    }
  }
}
