import { hasValidSupportFolder } from './folders';
import { dayKey, inFolder } from './model';
import type { Settings } from './types';
import type { CompletionSummary, ReportEntity, ReportPreferences, ReportRecord, ReportStatus, StreakSummary } from './report-contract';

export type NormalizedReportStatus = ReportStatus;

export interface MetricNote {
  path: string;
  name?: string;
  frontmatter?: Record<string, unknown>;
  tags?: readonly string[];
  links?: readonly string[];
}

const OPEN_STATUSES = new Set(['active', 'open', 'todo', 'to-do', 'doing', 'in-progress', 'in progress', 'pending']);
const DONE_STATUSES = new Set(['completed', 'complete', 'done']);
const ARCHIVED_STATUSES = new Set(['archived', 'archive']);

export function normalizeReportStatus(value: unknown): NormalizedReportStatus {
  if (typeof value !== 'string') return 'unknown';
  const status = value.trim().toLowerCase();
  if (OPEN_STATUSES.has(status)) return 'open';
  if (DONE_STATUSES.has(status)) return 'done';
  if (ARCHIVED_STATUSES.has(status)) return 'archived';
  return 'unknown';
}

function explicitStatus(fields: Record<string, unknown> | undefined): { explicit: boolean; status: NormalizedReportStatus } {
  for (const key of ['tangrow_status', 'status']) {
    const value = fields?.[key];
    if (value !== null && value !== undefined && value !== '') return { explicit: true, status: normalizeReportStatus(value) };
  }
  return { explicit: false, status: 'unknown' };
}

export function reportRecordStatus(record: MetricNote): NormalizedReportStatus {
  return explicitStatus(record.frontmatter).status;
}

export function canonicalEntityStatus(records: readonly MetricNote[], folder: string): NormalizedReportStatus {
  const name = folder.split('/').at(-1)?.toLowerCase() ?? '';
  const canonicalNames = new Set([name, 'readme', 'index', 'overview']);
  const statuses = new Set<NormalizedReportStatus>();
  for (const record of records) {
    const slash = record.path.lastIndexOf('/');
    if (record.path.slice(0, slash) !== folder || !record.path.toLowerCase().endsWith('.md')) continue;
    const basename = record.path.slice(slash + 1, -3).toLowerCase();
    if (!canonicalNames.has(basename)) continue;
    const value = explicitStatus(record.frontmatter);
    if (value.explicit) statuses.add(value.status);
  }
  return statuses.size === 1 ? statuses.values().next().value! : 'unknown';
}

function normalizedTags(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : [];
  return values.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.trim().replace(/^#/, '').toLowerCase());
}

function httpSource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(httpSource);
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
  } catch { return false; }
}

export function isClipRecord(record: MetricNote): boolean {
  if (record.frontmatter?.tangrow_kind === 'clip' || httpSource(record.frontmatter?.source)) return true;
  const tags = [...normalizedTags(record.frontmatter?.tags), ...normalizedTags(record.tags)];
  return tags.some((tag) => ['clip', 'webclip'].includes(tag.split('/')[0]!));
}

function validDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year!, month! - 1, day!);
  date.setHours(12, 0, 0, 0);
  return dayKey(date.getTime()) === value ? value : null;
}

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dayFromFormat(value: string, format: string): string | null {
  const fields: Array<'year' | 'month' | 'day'> = [];
  let expression = '^';
  for (let index = 0; index < format.length;) {
    if (format[index] === '[') {
      const end = format.indexOf(']', index + 1);
      if (end < 0) return null;
      expression += regexLiteral(format.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (format[index] === '\\' && index + 1 < format.length) {
      expression += regexLiteral(format[index + 1]!);
      index += 2;
      continue;
    }
    const token = (['YYYY', 'MM', 'DD', 'M', 'D'] as const).find((candidate) => format.startsWith(candidate, index));
    if (token) {
      fields.push(token === 'YYYY' ? 'year' : token.startsWith('M') ? 'month' : 'day');
      expression += token === 'YYYY' ? '(\\d{4})' : token.length === 2 ? '(\\d{2})' : '(\\d{1,2})';
      index += token.length;
    } else {
      if (/[A-Za-z]/.test(format[index]!)) return null;
      expression += regexLiteral(format[index]!);
      index++;
    }
  }
  if (!['year', 'month', 'day'].every((field) => fields.includes(field as typeof fields[number]))) return null;
  const match = new RegExp(`${expression}$`).exec(value);
  if (!match) return null;
  const values = new Map<string, number>();
  for (const [index, field] of fields.entries()) {
    const number = Number(match[index + 1]);
    if (values.has(field) && values.get(field) !== number) return null;
    values.set(field, number);
  }
  return validDay(`${String(values.get('year')).padStart(4, '0')}-${String(values.get('month')).padStart(2, '0')}-${String(values.get('day')).padStart(2, '0')}`);
}

export function reportJournalDay(record: MetricNote, settings: Pick<Settings, 'journalFolder' | 'journalFormat'>): string | null {
  const journal = typeof record.frontmatter?.journal === 'string' ? record.frontmatter.journal.trim().toLowerCase() : '';
  if (journal && journal !== 'daily') return null;
  const explicitDay = validDay(record.frontmatter?.['journal-date']);
  if (explicitDay && (journal === 'daily' || record.frontmatter?.['journal-date'] !== undefined)) return explicitDay;
  if (!record.path.toLowerCase().endsWith('.md') || !inFolder(record.path, settings.journalFolder)) return null;
  const relative = record.path.slice(settings.journalFolder.length + 1, -3);
  return dayFromFormat(relative, settings.journalFormat);
}

export function findOrphanNotes<T extends MetricNote>(records: readonly T[], settings: Settings): T[] {
  const excludeSupport = hasValidSupportFolder(settings);
  const excludedFolders = (settings as Settings & Partial<ReportPreferences>).reportExcludedFolders ?? [];
  const candidates = new Map(records.filter((record) => (!excludeSupport || !inFolder(record.path, settings.supportFolder)) && !inFolder(record.path, settings.archiveFolder) && !excludedFolders.some((folder) => record.path === folder || inFolder(record.path, folder))).map((record) => [record.path, record]));
  const connected = new Set<string>();
  for (const record of candidates.values()) {
    for (const target of record.links ?? []) {
      if (target === record.path || !candidates.has(target)) continue;
      connected.add(record.path);
      connected.add(target);
    }
  }
  return [...candidates.values()].filter((record) => !connected.has(record.path)).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function sampleReportNotes<T extends { path: string }>(records: readonly T[], count = 10, random: () => number = Math.random): T[] {
  const shuffled = [...new Map(records.map((record) => [record.path, record])).values()];
  const maximum = Number.isFinite(count) ? Math.max(0, Math.min(10, Math.floor(count))) : 10;
  for (let index = 0; index < Math.min(maximum, shuffled.length); index++) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError('Random samples must be between zero inclusive and one exclusive.');
    const swap = index + Math.floor(value * (shuffled.length - index));
    [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
  }
  return shuffled.slice(0, maximum);
}

function validCreated(value: number, now: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= now && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

function canonicalDocuments(records: readonly ReportRecord[], folder: string): ReportRecord[] {
  const name = folder.split('/').at(-1)?.toLowerCase() ?? '';
  const names = [name, 'readme', 'index', 'overview'];
  return records.filter((record) => {
    const slash = record.path.lastIndexOf('/');
    return record.path.slice(0, slash) === folder && names.includes(record.path.slice(slash + 1, -3).toLowerCase());
  }).sort((left, right) => {
    const leftName = left.path.slice(left.path.lastIndexOf('/') + 1, -3).toLowerCase();
    const rightName = right.path.slice(right.path.lastIndexOf('/') + 1, -3).toLowerCase();
    return names.indexOf(leftName) - names.indexOf(rightName) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  });
}

export function collectReportEntities(records: readonly ReportRecord[], root: string, folders: readonly string[] = [], now = Date.now()): ReportEntity[] {
  const children = new Set<string>();
  const rootNotes: ReportRecord[] = [];
  for (const path of [...folders, ...records.map((record) => record.path)]) {
    if (!inFolder(path, root)) continue;
    const relative = path.slice(root.length + 1);
    if (relative.includes('/')) children.add(`${root}/${relative.split('/')[0]}`);
    else if (folders.includes(path)) children.add(path);
  }
  for (const record of records) {
    if (record.path.slice(0, record.path.lastIndexOf('/')) === root) rootNotes.push(record);
  }
  const entities: ReportEntity[] = [...children].map((folder) => {
    const notes = records.filter((record) => inFolder(record.path, folder));
    const canonical = canonicalDocuments(notes, folder);
    const canonicalCreated = canonical.map((record) => validCreated(record.created, now)).filter((value): value is number => value !== null);
    const childCreated = notes.map((record) => validCreated(record.created, now)).filter((value): value is number => value !== null);
    const candidates = canonicalCreated.length ? canonicalCreated : childCreated;
    const latestNote = [...notes].sort((left, right) => right.modified - left.modified || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))[0];
    return {
      path: folder,
      name: folder.split('/').at(-1) ?? folder,
      notePath: canonical[0]?.path ?? latestNote?.path ?? null,
      noteCount: notes.length,
      created: candidates.length ? Math.min(...candidates) : null,
      status: canonicalEntityStatus(notes, folder)
    };
  });
  for (const record of rootNotes) {
    entities.push({ path: record.path, name: record.name, notePath: record.path, noteCount: 1, created: validCreated(record.created, now), status: reportRecordStatus(record) });
  }
  return entities.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function reportCompletion(statuses: readonly ReportStatus[]): CompletionSummary {
  const counts = { open: 0, done: 0, archived: 0, unknown: 0, cancelled: 0 };
  for (const status of statuses) counts[status]++;
  const denominator = counts.open + counts.done;
  return { ...counts, total: statuses.length, denominator, rate: denominator ? counts.done / denominator : null };
}

export function reportStreak(dayCounts: ReadonlyMap<string, number>, now = Date.now()): StreakSummary {
  const today = dayKey(now);
  const ordered = [...dayCounts].filter(([day, count]) => validDay(day) && day <= today && count > 0).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const present = new Set(ordered.map(([day]) => day));
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const [day] of ordered) {
    const [year, month, date] = day.split('-').map(Number);
    const yesterday = new Date(0);
    yesterday.setFullYear(year!, month! - 1, date!);
    yesterday.setHours(12, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    run = previous === dayKey(yesterday.getTime()) ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  if (!present.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (present.has(dayKey(cursor.getTime()))) { current++; cursor.setDate(cursor.getDate() - 1); }
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - 13 + index);
    const day = dayKey(date.getTime());
    return { day, count: dayCounts.get(day) ?? 0 };
  });
  return { current, longest, days };
}
