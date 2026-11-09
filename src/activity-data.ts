import { hasValidSupportFolder } from './folders';
import { inFolder } from './model';
import type { ReportRecord } from './report-data';
import type { Settings } from './types';

export interface ActivityDay {
  day: string;
  notes: number;
  pins: number;
  future: boolean;
}

export interface ActivityData {
  year: number;
  today: string;
  weeks: Array<Array<ActivityDay | null>>;
  months: Array<{ month: number; column: number }>;
  notes: { total: number; activeDays: number };
  pins: { total: number; activeDays: number };
  undatedPins: number;
}

export interface ActivityRecord {
  record: ReportRecord;
  isNew: boolean;
  isPinned: boolean;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

function localDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(12, 0, 0, 0);
  return date;
}

function localDay(time: number): string {
  const date = new Date(time);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function pinnedTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return timestamp(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))?)?$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month, day);
  calendarDate.setUTCHours(12, 0, 0, 0);
  if (year < 1 || calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month || calendarDate.getUTCDate() !== day) return null;
  if (Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59 || Number(match[6] ?? 0) > 59
    || Number(match[8] ?? 0) > 23 || Number(match[9] ?? 0) > 59) return null;
  // A date-only value names a local calendar day rather than midnight in UTC.
  if (text.length === 10) {
    const date = localDate(year, month, day);
    date.setHours(0, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
    return timestamp(date.getTime());
  }
  return timestamp(Date.parse(text));
}

export function activityLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (count < 2) return 1;
  if (count < 4) return 2;
  if (count < 8) return 3;
  return 4;
}

export function isActivityNote(path: string, settings: Settings): boolean {
  return (!hasValidSupportFolder(settings) || !inFolder(path, settings.supportFolder))
    && !(settings.reportExcludedFolders ?? []).some((folder) => path === folder || inFolder(path, folder));
}

export function activityRecordsForDay(records: readonly ReportRecord[], settings: Settings, day: string, now = Date.now()): ActivityRecord[] {
  if (timestamp(now) === null) throw new RangeError('Activity time must be a valid non-negative timestamp.');
  const unique = new Map(records.map((record) => [record.path, record]));
  const matches: ActivityRecord[] = [];
  for (const record of unique.values()) {
    const created = timestamp(record.created);
    const pinned = record.frontmatter?.tangrow_pin === true ? pinnedTimestamp(record.frontmatter.tangrow_pinned_at) : null;
    const isNew = created !== null && created <= now && isActivityNote(record.path, settings) && localDay(created) === day;
    const isPinned = pinned !== null && pinned <= now && localDay(pinned) === day;
    if (isNew || isPinned) matches.push({ record, isNew, isPinned });
  }
  return matches.sort((left, right) => left.record.path.localeCompare(right.record.path));
}

export function aggregateActivity(records: readonly ReportRecord[], settings: Settings, year: number, now = Date.now()): ActivityData {
  if (!Number.isInteger(year) || year < 1 || year > 9999) throw new RangeError('Use a year from 1 to 9999.');
  if (timestamp(now) === null) throw new RangeError('Activity time must be a valid non-negative timestamp.');
  const today = localDay(now);
  const todayNoon = new Date(now);
  todayNoon.setHours(12, 0, 0, 0);
  const date = localDate(year, 0, 1);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  const last = localDate(year, 11, 31);
  const weeks: ActivityData['weeks'] = [];
  const months: ActivityData['months'] = [];
  const buckets = new Map<string, ActivityDay>();
  while (date.getTime() <= last.getTime()) {
    const week: Array<ActivityDay | null> = [];
    for (let weekday = 0; weekday < 7; weekday++) {
      if (date.getFullYear() !== year) week.push(null);
      else {
        const entry = { day: localDay(date.getTime()), notes: 0, pins: 0, future: date.getTime() > todayNoon.getTime() };
        week.push(entry);
        buckets.set(entry.day, entry);
        if (date.getDate() === 1) months.push({ month: date.getMonth(), column: weeks.length });
      }
      // Calendar arithmetic keeps local days continuous across daylight-saving changes.
      date.setDate(date.getDate() + 1);
    }
    weeks.push(week);
  }

  const unique = new Map(records.map((record) => [record.path, record]));
  let undatedPins = 0;
  for (const record of unique.values()) {
    const created = timestamp(record.created);
    if (created !== null && created <= now && isActivityNote(record.path, settings)) {
      const bucket = buckets.get(localDay(created));
      if (bucket) bucket.notes++;
    }
    if (record.frontmatter?.tangrow_pin !== true) continue;
    const pinned = pinnedTimestamp(record.frontmatter.tangrow_pinned_at);
    if (pinned === null) undatedPins++;
    else if (pinned <= now) {
      const bucket = buckets.get(localDay(pinned));
      if (bucket) bucket.pins++;
    }
  }

  const notes = { total: 0, activeDays: 0 };
  const pins = { total: 0, activeDays: 0 };
  for (const entry of buckets.values()) {
    notes.total += entry.notes;
    if (entry.notes > 0) notes.activeDays++;
    pins.total += entry.pins;
    if (entry.pins > 0) pins.activeDays++;
  }
  return { year, today, weeks, months, notes, pins, undatedPins };
}
