import { translate } from './i18n';
import type { Locale } from './types';

const PRIORITIES = { '🔺': 'highest', '⏫': 'high', '🔼': 'medium', '🔽': 'low', '⏬': 'lowest' } as const;
type TaskPriority = typeof PRIORITIES[keyof typeof PRIORITIES];

// Match code and links before metadata so their contents stay intact.
const TASK_TOKENS = new RegExp([
  /(?<literal>`+[^`\n]+`+|[!\\]\[\[[^\]\n]+\]\]|\[[^\]\n]*\]\([^\n)]*\))/,
  /(?<link>\[\[[^\]\n]+\]\])/,
  /<!--[^\n]*?-->/,
  /(?<priority>[🔺⏫🔼🔽⏬])\uFE0F?/u,
  /(?<dateMarker>[📅⏳🛫➕✅❌])\uFE0F?\s*(?<date>\d{4}-\d{2}-\d{2})(?![\p{L}\p{M}\p{N}_-])/u,
  /🔁\uFE0F?\s*(?<recurrence>every\s+(?=\S)[^#📅⏳🛫➕✅❌🔺⏫🔼🔽⏬🔁[<`]+)/iu,
  /(?<tag>(?<!\S)#[\p{L}\p{M}\p{N}_/-]+)/u
].map((token) => token.source).join('|'), 'giu');

export interface TaskDisplay {
  title: string;
  tags: string[];
  links: string[];
  priority: TaskPriority | null;
  due: Date | null;
  recurrence: string | null;
}

/** Parse the indexed task label for display. The source label remains intact for task edits. */
export function parseTaskDisplay(raw: string): TaskDisplay {
  const display: TaskDisplay = { title: '', tags: [], links: [], priority: null, due: null, recurrence: null };
  let end = 0;
  for (const { 0: token, index, groups } of raw.matchAll(TASK_TOKENS)) {
    if (index === undefined || groups === undefined || groups.literal) continue;
    if (groups.link) display.links.push(groups.link);
    if (groups.priority) display.priority = PRIORITIES[groups.priority as keyof typeof PRIORITIES];
    if (groups.date) {
      const date = new Date(`${groups.date}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== groups.date) continue;
      if (groups.dateMarker === '📅') display.due = date;
    }
    if (groups.recurrence !== undefined) display.recurrence = groups.recurrence.trim();
    if (groups.tag) {
      if (/^#\d+$/.test(groups.tag)) continue;
      display.tags.push(groups.tag);
    }
    display.title += `${raw.slice(end, index)} `;
    end = index + token.length;
  }
  display.title = (display.title + raw.slice(end)).replace(/\s+/g, ' ').trim();
  return display;
}

function calendarDay(today: Date): number {
  // Compare calendar days without crossing a daylight-saving transition in local time.
  const todayUtc = new Date(0);
  todayUtc.setUTCFullYear(today.getFullYear(), today.getMonth(), today.getDate());
  return todayUtc.getTime();
}

export function taskDueLabel(due: Date, today: Date, language: Locale): { text: string; overdue: boolean } {
  const days = (due.getTime() - calendarDay(today)) / 86_400_000;
  if (days < 0) {
    const text = days === -1 ? translate(language, '1 day overdue')
      : translate(language, '{days} days overdue', { days: (-days).toLocaleString(language) });
    return { text, overdue: true };
  }
  if (days === 0) return { text: translate(language, 'Today'), overdue: false };
  if (days === 1) return { text: translate(language, 'Tomorrow'), overdue: false };
  const format: Intl.DateTimeFormatOptions = days < 7 ? { weekday: 'short' } : { month: 'short', day: 'numeric' };
  return { text: due.toLocaleDateString(language, { ...format, timeZone: 'UTC' }), overdue: false };
}

function taskRank(display: TaskDisplay, today: number): number {
  const due = display.due?.getTime();
  if (due !== undefined && due < today) return 0;
  if (due === today) return 1;
  if (display.priority === 'highest') return 2;
  if (display.priority === 'high') return 3;
  return 4;
}

export function taskDisplayRank(display: TaskDisplay, today: Date): number {
  return taskRank(display, calendarDay(today));
}

export function sortTaskDisplay<T extends { text: string }>(tasks: readonly T[], today: Date): Array<{ task: T; display: TaskDisplay }> {
  const day = calendarDay(today);
  return tasks.map((task) => ({ task, display: parseTaskDisplay(task.text) }))
    .sort((left, right) => taskRank(left.display, day) - taskRank(right.display, day));
}
