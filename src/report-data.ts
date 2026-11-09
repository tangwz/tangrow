import { captureCreated } from './capture-data';
import { hasValidSupportFolder } from './folders';
import { dayKey, inFolder, recentDays } from './model';
import { collectReportEntities, findOrphanNotes, isClipRecord, reportCompletion, reportRecordStatus, reportJournalDay, reportStreak } from './report-metrics';
import type { AggregateReportOptions, CompletionSummary, DailyTrend, ReportData, ReportPreferences, ReportRecord, ReportStatus } from './report-contract';
import type { Settings } from './types';

export type { AggregateReportOptions, ReportData, ReportRecord } from './report-contract';

function hasSource(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function validCreated(value: number, now: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= now && !Number.isNaN(new Date(value).getTime());
}

function isWithin(path: string, folder: string): boolean { return path === folder || inFolder(path, folder); }
function safeCount(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0; }

function taskCompletion(open: number, done: number, cancelled: number, unknown: number): CompletionSummary {
  const denominator = open + done;
  return { open, done, cancelled, archived: 0, unknown, total: open + done + cancelled + unknown, denominator, rate: denominator ? done / denominator : null };
}

export function aggregateReport(records: readonly ReportRecord[], settings: Settings, now = Date.now(), options: AggregateReportOptions = {}): ReportData {
  if (!Number.isFinite(now) || now < 0) throw new RangeError('Report time must be a finite non-negative timestamp.');
  const unique = [...new Map(records.map((record) => [record.path, record])).values()];
  const excludeSupport = hasValidSupportFolder(settings);
  const excludedFolders = (settings as Settings & Partial<ReportPreferences>).reportExcludedFolders ?? [];
  const excluded = (path: string): boolean => (excludeSupport && isWithin(path, settings.supportFolder)) || excludedFolders.some((folder) => isWithin(path, folder));
  const notes = unique.filter((record) => !excluded(record.path));
  const folders = (options.folders ?? []).filter((path) => !excluded(path));
  const projects = collectReportEntities(notes, settings.projectFolder, folders, now);
  const areas = collectReportEntities(notes, settings.areaFolder, folders, now);
  const clips = notes.filter(isClipRecord);
  const clipPaths = new Set(clips.map((record) => record.path));
  const orphans = findOrphanNotes(notes, settings);
  const range = options.range ?? 30;
  const trends: DailyTrend[] = recentDays(range, now).map((day) => ({ day, notes: 0, tasks: 0, projects: 0, captures: 0, clips: 0 }));
  const dayTrends = new Map(trends.map((entry) => [entry.day, entry]));
  const today = dayKey(now);
  const gainDays = new Set(recentDays(90, now));
  const gains90 = { notes: 0, projects: 0, areas: 0, clips: 0, captures: 0 };
  const seenFocus = new Set<string>();
  const seenHabits = new Set<string>();
  const activeHabitIds = new Set(settings.habits.map((habit) => habit.id));
  const habitDays = new Map<string, Set<string>>();
  const captureDays = new Map<string, number>();
  const journalDays = new Map<string, number>();
  const taskItems: ReportData['taskItems'] = [];
  let unknownTasks = 0;
  const counts: ReportData['counts'] = {
    notes: notes.length, projectNotes: 0, areaNotes: 0, resourceNotes: 0, sourceNotes: 0,
    captures: 0, pins: 0, drafts: 0, openTasks: 0, completedTasks: 0, cancelledTasks: 0,
    focusMinutes: 0, habitCheckinsToday: 0, tasks: 0, projects: projects.length, areas: areas.length,
    clips: clips.length, words: 0, characters: 0, orphans: orphans.length
  };

  for (const record of notes) {
    const fields = record.frontmatter;
    if (inFolder(record.path, settings.projectFolder)) counts.projectNotes++;
    if (inFolder(record.path, settings.areaFolder)) counts.areaNotes++;
    if (inFolder(record.path, settings.resourcesFolder)) counts.resourceNotes++;
    if (hasSource(fields?.source) || hasSource(fields?.tangrow_source)) counts.sourceNotes++;
    if (fields?.tangrow_kind === 'draft') counts.drafts++;
    counts.words += safeCount(record.wordCount);
    counts.characters += safeCount(record.characterCount);
    const created = validCreated(record.created, now) ? record.created : null;
    const trend = created === null ? undefined : dayTrends.get(dayKey(created));
    if (created !== null) {
      if (trend) trend.notes++;
      if (gainDays.has(dayKey(created))) gains90.notes++;
      if (clipPaths.has(record.path)) {
        if (trend) trend.clips++;
        if (gainDays.has(dayKey(created))) gains90.clips++;
      }
    }
    if (fields?.tangrow_kind === 'capture') {
      counts.captures++;
      const captureDate = captureCreated(fields.created, record.created, record.modified);
      if (validCreated(captureDate, now)) {
        const day = dayKey(captureDate);
        captureDays.set(day, (captureDays.get(day) ?? 0) + 1);
        const captureTrend = dayTrends.get(day);
        if (captureTrend) captureTrend.captures++;
        if (gainDays.has(day)) gains90.captures++;
      }
    }
    const journalDay = reportJournalDay(record, settings);
    if (journalDay && journalDay <= today) journalDays.set(journalDay, (journalDays.get(journalDay) ?? 0) + 1);
    if (inFolder(record.path, settings.archiveFolder)) continue;
    const statuses = record.taskItems?.length ? record.taskItems.map((item) => item.status) : record.tasks ?? [];
    if (trend) trend.tasks += statuses.length;
    for (const status of statuses) {
      counts.tasks++;
      if (status === ' ' || status === '/') counts.openTasks++;
      else if (status === 'x' || status === 'X') counts.completedTasks++;
      else if (status === '-') counts.cancelledTasks++;
      else unknownTasks++;
    }
    if (record.taskItems) taskItems.push(...record.taskItems);
  }

  for (const entity of projects) {
    if (entity.created === null) continue;
    const day = dayKey(entity.created);
    const trend = dayTrends.get(day);
    if (trend) trend.projects++;
    if (gainDays.has(day)) gains90.projects++;
  }
  for (const entity of areas) if (entity.created !== null && gainDays.has(dayKey(entity.created))) gains90.areas++;

  for (const record of unique) {
    const fields = record.frontmatter;
    if (fields?.tangrow_pin === true) counts.pins++;
    const minutes = fields?.tangrow_minutes;
    if (fields?.tangrow_kind === 'focus' && typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) {
      const id = typeof fields.tangrow_session_id === 'string' && fields.tangrow_session_id.trim() ? `session:${fields.tangrow_session_id}` : `path:${record.path}`;
      if (!seenFocus.has(id)) { counts.focusMinutes += minutes; seenFocus.add(id); }
    }
    if (fields?.tangrow_kind === 'habit' && typeof fields.tangrow_habit_id === 'string' && activeHabitIds.has(fields.tangrow_habit_id) && typeof fields.tangrow_day === 'string' && fields.tangrow_day <= today) {
      const id = `${fields.tangrow_habit_id}:${fields.tangrow_day}`;
      if (seenHabits.has(id)) continue;
      seenHabits.add(id);
      const habits = habitDays.get(fields.tangrow_day) ?? new Set<string>();
      habits.add(fields.tangrow_habit_id);
      habitDays.set(fields.tangrow_day, habits);
    }
  }
  counts.focusMinutes = Math.round(counts.focusMinutes * 100) / 100;
  counts.habitCheckinsToday = habitDays.get(today)?.size ?? 0;
  return {
    counts,
    days: trends.map((day) => ({ day: day.day, count: day.notes })),
    recent: [...notes].sort((left, right) => {
      const leftTime = Number.isFinite(left.modified) ? left.modified : -Infinity;
      const rightTime = Number.isFinite(right.modified) ? right.modified : -Infinity;
      return rightTime - leftTime || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    }).slice(0, 8),
    notes, projects, areas, clips, taskItems, orphanNotes: orphans, trends, gains90,
    completion: {
      tasks: taskCompletion(counts.openTasks, counts.completedTasks, counts.cancelledTasks, unknownTasks),
      projects: reportCompletion(projects.map((entity) => entity.status)),
      areas: reportCompletion(areas.map((entity) => entity.status)),
      clips: reportCompletion(clips.map((record): ReportStatus => reportRecordStatus(record)))
    },
    streaks: { journal: reportStreak(journalDays, now), captures: reportStreak(captureDays, now) },
    habits: {
      todayCompleted: counts.habitCheckinsToday,
      target: activeHabitIds.size,
      days: recentDays(14, now).map((day) => ({ day, completed: habitDays.get(day)?.size ?? 0, target: activeHabitIds.size }))
    }
  };
}
