import { dayKey, inFolder, recentDays } from './model';
import type { Settings } from './types';

export interface ReportRecord {
  path: string;
  name: string;
  created: number;
  modified: number;
  frontmatter?: Record<string, unknown>;
  tasks?: string[];
}

export interface ReportData {
  counts: {
    notes: number;
    projectNotes: number;
    areaNotes: number;
    resourceNotes: number;
    sourceNotes: number;
    captures: number;
    pins: number;
    drafts: number;
    openTasks: number;
    completedTasks: number;
    cancelledTasks: number;
    focusMinutes: number;
    habitCheckinsToday: number;
  };
  days: Array<{ day: string; count: number }>;
  recent: ReportRecord[];
}

function hasSource(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

export function aggregateReport(records: readonly ReportRecord[], settings: Settings, now = Date.now()): ReportData {
  if (!Number.isFinite(now) || now < 0) throw new RangeError('Report time must be a finite non-negative timestamp.');
  const unique = [...new Map(records.map((record) => [record.path, record])).values()];
  const notes = unique.filter((record) => !inFolder(record.path, settings.supportFolder));
  const days = recentDays(30, now).map((day) => ({ day, count: 0 }));
  const dayCounts = new Map(days.map((entry) => [entry.day, entry]));
  const today = dayKey(now);
  const seenFocus = new Set<string>();
  const seenHabits = new Set<string>();
  const counts: ReportData['counts'] = {
    notes: notes.length,
    projectNotes: 0,
    areaNotes: 0,
    resourceNotes: 0,
    sourceNotes: 0,
    captures: 0,
    pins: 0,
    drafts: 0,
    openTasks: 0,
    completedTasks: 0,
    cancelledTasks: 0,
    focusMinutes: 0,
    habitCheckinsToday: 0
  };

  for (const record of notes) {
    const fields = record.frontmatter;
    if (inFolder(record.path, settings.projectFolder)) counts.projectNotes++;
    if (inFolder(record.path, settings.areaFolder)) counts.areaNotes++;
    if (inFolder(record.path, settings.resourcesFolder)) counts.resourceNotes++;
    if (hasSource(fields?.source) || hasSource(fields?.tangrow_source)) counts.sourceNotes++;
    if (fields?.tangrow_kind === 'capture') counts.captures++;
    if (fields?.tangrow_kind === 'draft') counts.drafts++;
    if (Number.isFinite(record.created) && record.created >= 0 && record.created <= now) {
      const bucket = dayCounts.get(dayKey(record.created));
      if (bucket) bucket.count++;
    }
    if (inFolder(record.path, settings.archiveFolder)) continue;
    for (const status of record.tasks ?? []) {
      if (status === ' ' || status === '/') counts.openTasks++;
      else if (status === 'x' || status === 'X') counts.completedTasks++;
      else if (status === '-') counts.cancelledTasks++;
    }
  }

  for (const record of unique) {
    const fields = record.frontmatter;
    if (fields?.tangrow_pin === true) counts.pins++;
    const minutes = fields?.tangrow_minutes;
    if (fields?.tangrow_kind === 'focus' && typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) {
      const id = typeof fields.tangrow_session_id === 'string' && fields.tangrow_session_id.trim()
        ? `session:${fields.tangrow_session_id}` : `path:${record.path}`;
      if (!seenFocus.has(id)) { counts.focusMinutes += minutes; seenFocus.add(id); }
    }
    if (fields?.tangrow_kind === 'habit' && fields.tangrow_day === today) {
      const id = typeof fields.tangrow_habit_id === 'string' && fields.tangrow_habit_id.trim()
        ? `habit:${fields.tangrow_habit_id}:${today}` : `path:${record.path}`;
      if (!seenHabits.has(id)) { counts.habitCheckinsToday++; seenHabits.add(id); }
    }
  }
  counts.focusMinutes = Math.round(counts.focusMinutes * 100) / 100;
  return {
    counts,
    days,
    recent: [...notes].sort((left, right) => {
      const leftTime = Number.isFinite(left.modified) ? left.modified : -Infinity;
      const rightTime = Number.isFinite(right.modified) ? right.modified : -Infinity;
      return rightTime - leftTime || left.path.localeCompare(right.path);
    }).slice(0, 8)
  };
}
