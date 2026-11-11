import { dayKey, safeFolder } from './model';
import type { Settings } from './types';

export const JOURNAL_PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type JournalPeriod = typeof JOURNAL_PERIODS[number];
export const JOURNAL_LABELS: Record<JournalPeriod, string> = {
  daily: 'Daily note', weekly: 'Weekly note', monthly: 'Monthly note', quarterly: 'Quarterly note', yearly: 'Yearly note'
};

export interface JournalInterval {
  period: JournalPeriod;
  title: string;
  start: string;
  end: string;
  date: Date;
  week: number;
  weekYear: number;
  quarter: number;
}

export function journalDate(value: string): Date {
  const date = new Date(`${value}T12:00:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || dayKey(date.getTime()) !== value) {
    throw new Error('Choose a valid journal date.');
  }
  return date;
}

export function journalInterval(period: JournalPeriod, value: string): JournalInterval {
  if (!JOURNAL_PERIODS.includes(period)) throw new Error('Unknown journal period.');
  const date = journalDate(value);
  const year = date.getFullYear();
  const month = date.getMonth();
  const quarter = Math.floor(month / 3) + 1;
  const thursday = new Date(0);
  thursday.setUTCFullYear(year, month, date.getDate());
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const weekYear = thursday.getUTCFullYear();
  const firstDay = new Date(0);
  firstDay.setUTCFullYear(weekYear, 0, 1);
  const week = Math.ceil(((thursday.getTime() - firstDay.getTime()) / 86_400_000 + 1) / 7);
  const start = new Date(date);
  const end = new Date(date);
  let title = value;
  if (period === 'weekly') {
    start.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    end.setFullYear(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    title = `${weekYear}-W${String(week).padStart(2, '0')}`;
  } else if (period === 'monthly') {
    start.setDate(1);
    end.setFullYear(year, month + 1, 0);
    title = `${year}-${String(month + 1).padStart(2, '0')}`;
  } else if (period === 'quarterly') {
    start.setFullYear(year, (quarter - 1) * 3, 1);
    end.setFullYear(year, quarter * 3, 0);
    title = `${year}-Q${quarter}`;
  } else if (period === 'yearly') {
    start.setFullYear(year, 0, 1);
    end.setFullYear(year, 11, 31);
    title = String(year);
  }
  return { period, title, start: dayKey(start.getTime()), end: dayKey(end.getTime()), date: start, week, weekYear, quarter };
}

export function journalPath(settings: Settings, period: JournalPeriod, value: string, format: (date: Date, pattern: string) => string): string {
  const interval = journalInterval(period, value);
  const pattern = period === 'daily' ? settings.journalFormat : settings.journalFormats[period];
  const relative = format(interval.date, pattern);
  try {
    if (!relative.trim() || relative !== relative.trim() || relative.endsWith('/')) throw new Error();
    return `${safeFolder(settings.journalFolder)}/${safeFolder(relative)}.md`;
  } catch { throw new Error('The journal format must resolve to a safe relative vault path.'); }
}

export function journalTemplate(template: string, interval: JournalInterval): string {
  const values: Record<string, string> = {
    title: interval.title, date: interval.start, start: interval.start, end: interval.end,
    period: interval.period, year: String(interval.date.getFullYear()), week: String(interval.week),
    quarter: String(interval.quarter)
  };
  return template.replace(/\{\{\s*(title|date|start|end|period|year|week|quarter)\s*\}\}/g, (_match, key: string) => values[key]!);
}

export function defaultJournal(interval: JournalInterval): string {
  const kind = interval.period[0]!.toUpperCase() + interval.period.slice(1);
  const end = interval.period === 'daily' ? '' : `journal-end-date: ${interval.end}\n`;
  return `---\njournal: ${kind}\njournal-date: ${interval.start}\n${end}---\n\n# ${interval.title}\n\n`;
}
