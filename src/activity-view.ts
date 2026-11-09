import { Notice, setIcon, setTooltip } from 'obsidian';
import { activityRecordsForDay, aggregateActivity, type ActivityData, type ActivityDay } from './activity-data';
import { describeError, translate, type TranslationValues } from './i18n';
import type { ReportRecord } from './report-data';
import type { SidebarHost } from './types';

export interface ActivityViewState {
  year: number;
  selection?: { day: string };
  focusedDays: { activity?: string };
  scrollPositions: { activity?: number };
}

let nextDetailId = 0;

export function renderActivityHeatmaps(
  parent: HTMLElement,
  records: readonly ReportRecord[],
  host: SidebarHost,
  state: ActivityViewState,
  onYearChange: (year: number) => void
): void {
  const now = Date.now();
  const data = aggregateActivity(records, host.settings, state.year, now);
  const t = (source: string, values?: TranslationValues): string => translate(host.settings.language, source, values);
  const section = parent.createDiv({ cls: 'tangrow-activity' });
  const header = section.createDiv({ cls: 'tangrow-activity-heading' });
  const introduction = header.createDiv();
  introduction.createEl('h2', { text: t('A year in notes') });
  introduction.createEl('p', { cls: 'tangrow-report-caption', text: t('One square, one day. Select a day to revisit its notes.') });
  const navigation = header.createDiv({ cls: 'tangrow-activity-navigation', attr: { role: 'group', 'aria-label': t('Activity year') } });
  const yearButton = (label: string, icon: string, year: number, disabled: boolean): void => {
    const button = navigation.createEl('button', {
      cls: 'tangrow-report-control tangrow-activity-year-button',
      attr: { type: 'button', 'aria-label': t(label), 'data-activity-focus': label }
    });
    setIcon(button, icon);
    button.disabled = disabled;
    setTooltip(button, t(label));
    button.addEventListener('click', () => onYearChange(year));
  };
  yearButton('Previous year', 'chevron-left', data.year - 1, data.year <= 1);
  navigation.createEl('strong', { text: String(data.year), attr: { 'aria-live': 'polite' } });
  yearButton('Next year', 'chevron-right', data.year + 1, data.year >= new Date(now).getFullYear());
  const current = navigation.createEl('button', {
    cls: 'tangrow-report-control', text: t('This year'),
    attr: { type: 'button', 'data-activity-focus': 'This year', 'aria-pressed': String(data.year === new Date(now).getFullYear()) }
  });
  current.addEventListener('click', () => onYearChange(new Date(now).getFullYear()));

  const detailId = `tangrow-activity-detail-${++nextDetailId}`;
  renderHeatmap(section, data, host, state, detailId, selectDay);
  const detail = section.createDiv({ cls: 'tangrow-activity-detail', attr: { id: detailId, 'aria-live': 'polite' } });
  if (state.selection) renderSelection();
  else detail.hidden = true;

  function selectDay(day: string): void {
    state.selection = { day };
    for (const button of Array.from(section.querySelectorAll<HTMLButtonElement>('.tangrow-heatmap-day'))) {
      button.setAttribute('aria-pressed', String(button.dataset.activityFocus === `activity:${day}`));
    }
    renderSelection();
  }

  function renderSelection(): void {
    const selected = state.selection;
    if (!selected) return;
    detail.hidden = false;
    detail.empty();
    const matches = activityRecordsForDay(records, host.settings, selected.day, now);
    const title = detail.createDiv({ cls: 'tangrow-activity-detail-heading' });
    title.createEl('h3', {
      text: t('{day}: {notes} new notes, {pins} current pins', {
        day: selected.day, notes: matches.filter((item) => item.isNew).length, pins: matches.filter((item) => item.isPinned).length
      })
    });
    if (!matches.length) detail.createEl('p', { cls: 'tangrow-report-caption', text: t('No records for this day.') });
    const list = detail.createDiv({ cls: 'tangrow-activity-records' });
    for (const { record, isNew, isPinned } of matches) {
      const button = list.createEl('button', { cls: 'tangrow-report-control tangrow-report-note-row', attr: { type: 'button' } });
      const icon = button.createSpan({ cls: 'tangrow-report-icon' });
      setIcon(icon, 'file-text');
      button.createSpan({ text: record.name });
      const badges = button.createSpan({ cls: 'tangrow-activity-record-badges' });
      if (isNew) badges.createSpan({ cls: 'tangrow-activity-record-badge is-note', text: t('New notes') });
      if (isPinned) badges.createSpan({ cls: 'tangrow-activity-record-badge is-pin', text: t('Current pins') });
      button.createSpan({ cls: 'tangrow-activity-record-path', text: record.path });
      setTooltip(button, record.path);
      button.addEventListener('click', () => {
        void host.openNote(record.path).catch((error: unknown) => {
          new Notice(describeError(host.settings.language, error));
        });
      });
    }
  }
}

function renderHeatmap(
  parent: HTMLElement,
  data: ActivityData,
  host: SidebarHost,
  state: ActivityViewState,
  detailId: string,
  onSelect: (day: string) => void
): void {
  const t = (source: string, values?: TranslationValues): string => translate(host.settings.language, source, values);
  const card = parent.createDiv({ cls: 'tangrow-report-panel tangrow-heatmap-card' });
  const header = card.createDiv({ cls: 'tangrow-heatmap-heading' });
  const title = header.createDiv({ cls: 'tangrow-heatmap-title' });
  const icon = title.createSpan({ cls: 'tangrow-report-icon' });
  setIcon(icon, 'notebook-pen');
  title.createEl('h3', { text: t('Notes and pins') });
  const summary = header.createDiv({ cls: 'tangrow-heatmap-summary' });
  for (const metric of ['notes', 'pins'] as const) {
    const item = summary.createSpan({ cls: 'tangrow-heatmap-summary-item' });
    item.createEl('strong', { text: data[metric].total.toLocaleString(host.settings.language) });
    item.createSpan({ text: t(metric === 'notes' ? 'New notes' : 'Current pins') });
  }
  card.createEl('p', {
    cls: 'tangrow-report-caption',
    text: t('Notes use file creation dates; current pins use pin dates. Importing or restoring can change file dates.')
  });
  const scroller = card.createDiv({ cls: 'tangrow-heatmap-scroll' });
  const grid = scroller.createDiv({ cls: 'tangrow-heatmap-grid', attr: { role: 'group', 'aria-label': t('{year} daily activity. Use arrow keys to move between days.', { year: data.year }) } });
  grid.style.setProperty('--tangrow-heatmap-weeks', String(data.weeks.length));
  const monthFormat = new Intl.DateTimeFormat(host.settings.language, { month: 'short' });
  for (const month of data.months) {
    const label = grid.createSpan({ cls: 'tangrow-heatmap-month', text: monthFormat.format(new Date(2000, month.month, 1)) });
    label.style.gridColumn = `${month.column + 2} / span 3`;
    label.style.gridRow = '1';
  }
  const weekdayFormat = new Intl.DateTimeFormat(host.settings.language, { weekday: 'narrow' });
  for (const row of [0, 2, 4]) {
    const label = grid.createSpan({ cls: 'tangrow-heatmap-weekday', text: weekdayFormat.format(new Date(2024, 0, 1 + row)), attr: { 'aria-hidden': 'true' } });
    label.style.gridColumn = '1';
    label.style.gridRow = String(row + 2);
  }
  const buttons: Array<HTMLButtonElement | null> = [];
  const days = data.weeks.flat().filter((day): day is ActivityDay => day !== null && !day.future);
  const cachedDay = state.focusedDays.activity;
  const initialDay = days.some((day) => day.day === cachedDay)
    ? cachedDay : data.year === Number(data.today.slice(0, 4)) ? data.today : days.at(-1)?.day;
  for (const [column, week] of data.weeks.entries()) {
    for (const [row, day] of week.entries()) {
      const kind = !day || (!day.notes && !day.pins) ? 'empty' : day.notes && day.pins ? 'both' : day.pins ? 'pins' : 'notes';
      const slot = day && !day.future
        ? grid.createEl('button', { cls: `tangrow-heatmap-day tangrow-heatmap-kind-${kind}`, attr: { type: 'button' } })
        : grid.createSpan({ cls: `tangrow-heatmap-placeholder${day ? ' is-future' : ''}`, attr: { 'aria-hidden': 'true' } });
      slot.style.gridColumn = String(column + 2);
      slot.style.gridRow = String(row + 2);
      const index = buttons.length;
      if (!day || day.future) { buttons.push(null); continue; }
      const button = slot as HTMLButtonElement;
      buttons.push(button);
      const label = t('{day}: {notes} new notes, {pins} current pins', { day: day.day, notes: day.notes, pins: day.pins });
      button.setAttribute('aria-label', label);
      button.setAttribute('aria-controls', detailId);
      button.setAttribute('aria-pressed', String(state.selection?.day === day.day));
      button.dataset.activityFocus = `activity:${day.day}`;
      button.tabIndex = day.day === initialDay ? 0 : -1;
      if (day.day === data.today) button.addClass('is-today');
      setTooltip(button, label);
      button.addEventListener('click', () => onSelect(day.day));
      button.addEventListener('focus', () => {
        for (const previous of buttons) if (previous) previous.tabIndex = -1;
        button.tabIndex = 0;
        state.focusedDays.activity = day.day;
      });
      button.addEventListener('keydown', (event) => {
        const offsets: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
        let target: HTMLButtonElement | null | undefined;
        if (event.key === 'Home') target = buttons.find((entry) => entry !== null);
        else if (event.key === 'End') target = [...buttons].reverse().find((entry) => entry !== null);
        else if (event.key in offsets) {
          if ((event.key === 'ArrowUp' && row === 0) || (event.key === 'ArrowDown' && row === 6)) {
            event.preventDefault();
            return;
          }
          target = buttons[index + offsets[event.key]!];
        } else return;
        event.preventDefault();
        target?.focus();
      });
    }
  }
  const footer = card.createDiv({ cls: 'tangrow-heatmap-footer' });
  footer.createSpan({ cls: 'tangrow-report-caption', text: t('across {count} active days', { count: days.filter((day) => day.notes || day.pins).length }) });
  const legend = footer.createDiv({ cls: 'tangrow-heatmap-legend', attr: { 'aria-label': t('Daily activity types') } });
  for (const [kind, label] of [['empty', 'No records'], ['notes', 'New notes'], ['pins', 'Current pins'], ['both', 'Both activities']] as const) {
    const item = legend.createSpan({ cls: 'tangrow-heatmap-legend-item' });
    item.createSpan({ cls: `tangrow-heatmap-swatch tangrow-heatmap-kind-${kind}`, attr: { 'aria-hidden': 'true' } });
    item.createSpan({ text: t(label) });
  }
  card.createEl('p', {
    cls: 'tangrow-report-caption tangrow-heatmap-method',
    text: t('Today is outlined. Unpinning removes its pin activity; pinning again uses the new date.')
  });
  if (data.undatedPins) card.createEl('p', {
    cls: 'tangrow-report-caption tangrow-heatmap-undated',
    text: t('{count} current pins have no valid pin date and are not shown in the calendar.', { count: data.undatedPins })
  });
  const todayColumn = data.weeks.findIndex((week) => week.some((day) => day?.day === data.today));
  scroller.scrollLeft = state.scrollPositions.activity
    ?? (todayColumn < 0 ? 0 : Math.max(0, (todayColumn + 1) * grid.scrollWidth / (data.weeks.length + 2) - scroller.clientWidth + 50));
  scroller.addEventListener('scroll', () => { state.scrollPositions.activity = scroller.scrollLeft; }, { passive: true });
}
