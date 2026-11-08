import type { CaptureSummary } from './types';
export type { CaptureSummary } from './types';

export interface CaptureDayGroup {
  date: string;
  captures: CaptureSummary[];
}

export interface CaptureCalendarCell {
  date: string;
  day: number;
  inMonth: boolean;
  today: boolean;
  count: number;
}

export interface CaptureMonth {
  year: number;
  monthIndex: number;
}

function validTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

function parseCreated(value: unknown): number | null {
  if (typeof value === 'number') return validTimestamp(value);
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const datePrefix = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(text);
  if (datePrefix) {
    const year = Number(datePrefix[1]);
    const month = Number(datePrefix[2]) - 1;
    const day = Number(datePrefix[3]);
    const date = new Date(0);
    date.setFullYear(year, month, day);
    date.setHours(0, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
    // Date-only metadata describes a local calendar day, not UTC midnight.
    if (text.length === 10) return date.getTime();
  }
  return validTimestamp(Date.parse(text));
}

export function captureCreated(frontmatterCreated: unknown, ctime: number, mtime: number): number {
  return parseCreated(frontmatterCreated) ?? validTimestamp(ctime) ?? validTimestamp(mtime) ?? 0;
}

export function captureDay(timestamp: number): string {
  if (validTimestamp(timestamp) === null) throw new RangeError('A capture date requires a valid timestamp.');
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function createdTime(capture: CaptureSummary): number {
  return validTimestamp(capture.created) ?? validTimestamp(capture.modified) ?? 0;
}

export function sortCaptures(captures: readonly CaptureSummary[]): CaptureSummary[] {
  return [...captures].sort((left, right) => {
    const delta = createdTime(right) - createdTime(left);
    if (delta !== 0) return delta;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

export function groupCapturesByDay(captures: readonly CaptureSummary[]): CaptureDayGroup[] {
  const groups = new Map<string, CaptureSummary[]>();
  for (const capture of sortCaptures(captures)) {
    const date = captureDay(createdTime(capture));
    const group = groups.get(date) ?? [];
    group.push(capture);
    groups.set(date, group);
  }
  return Array.from(groups, ([date, entries]) => ({ date, captures: entries }));
}

function validateMonth(year: number, monthIndex: number): void {
  if (!Number.isInteger(year) || year < 1 || year > 9999 || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    throw new RangeError('Use a year from 1 to 9999 and a zero-based month from 0 to 11.');
  }
}

export function shiftCaptureMonth(year: number, monthIndex: number, offset: number): CaptureMonth {
  validateMonth(year, monthIndex);
  if (!Number.isSafeInteger(offset)) throw new RangeError('The month offset must be a safe integer.');
  const absoluteMonth = year * 12 + monthIndex + offset;
  const nextYear = Math.floor(absoluteMonth / 12);
  const nextMonth = absoluteMonth - nextYear * 12;
  validateMonth(nextYear, nextMonth);
  return { year: nextYear, monthIndex: nextMonth };
}

export function captureCalendar(captures: readonly CaptureSummary[], year: number, monthIndex: number, today = Date.now()): CaptureCalendarCell[] {
  validateMonth(year, monthIndex);
  const todayKey = captureDay(today);
  const counts = new Map(groupCapturesByDay(captures).map((group) => [group.date, group.captures.length]));
  const first = new Date(0);
  first.setFullYear(year, monthIndex, 1);
  first.setHours(12, 0, 0, 0);
  const mondayOffset = (first.getDay() + 6) % 7;
  first.setDate(first.getDate() - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first);
    date.setDate(first.getDate() + index);
    const key = captureDay(date.getTime());
    return {
      date: key,
      day: date.getDate(),
      inMonth: date.getFullYear() === year && date.getMonth() === monthIndex,
      today: key === todayKey,
      count: counts.get(key) ?? 0
    };
  });
}
