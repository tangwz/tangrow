import { DEFAULT_SETTINGS, type FocusSession, type Settings } from './types';

export function safeFolder(value: string): string {
  const path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!path || path.startsWith('/') || /[\u0000-\u001f:*?"<>|]/.test(path) || path.split('/').some((part) => !part || part.startsWith('.'))) {
    throw new Error('Use a relative vault folder without hidden or parent segments.');
  }
  return path;
}

export function safeTitle(value: string): string {
  const title = value.trim().replace(/\.md$/i, '');
  if (!title || title.startsWith('.') || title.length > 140 || /[\u0000-\u001f/\\:*?"<>|#\[\]^]/.test(title) || /[. ]$/.test(title)) {
    throw new Error('Use a title of 1-140 characters without path or link punctuation.');
  }
  return title;
}

export function inFolder(path: string, folder: string): boolean {
  return path.startsWith(`${folder}/`);
}

export function dayKey(time = Date.now()): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function recentDays(count: number, time = Date.now()): string[] {
  const date = new Date(time);
  date.setHours(12, 0, 0, 0);
  return Array.from({ length: count }, (_, index) => {
    const next = new Date(date);
    next.setDate(date.getDate() - count + 1 + index);
    return dayKey(next.getTime());
  });
}

export function streak(days: ReadonlySet<string>, time = Date.now()): number {
  const date = new Date(time);
  date.setHours(12, 0, 0, 0);
  if (!days.has(dayKey(date.getTime()))) date.setDate(date.getDate() - 1);
  let count = 0;
  while (days.has(dayKey(date.getTime()))) {
    count++;
    date.setDate(date.getDate() - 1);
  }
  return count;
}

export function readSettings(value: unknown): Settings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_SETTINGS, habits: [] } as Settings;
  if (raw.language === 'en' || raw.language === 'zh-CN') result.language = raw.language;
  const folders = ['supportFolder', 'inboxFolder', 'projectFolder', 'areaFolder', 'resourcesFolder', 'archiveFolder', 'journalFolder'] as const;
  for (const key of folders) {
    if (typeof raw[key] !== 'string') continue;
    try { result[key] = safeFolder(raw[key]); } catch { /* Keep the safe default for invalid persisted data. */ }
  }
  if (typeof raw.taskOverviewPath === 'string') {
    try { result.taskOverviewPath = safeFolder(raw.taskOverviewPath); } catch { /* Keep the existing Tasks note default. */ }
  }
  if (typeof raw.journalFormat === 'string' && raw.journalFormat.length < 100 && raw.journalFormat.length > 0) result.journalFormat = raw.journalFormat;
  if (Number.isInteger(raw.focusMinutes) && Number(raw.focusMinutes) >= 1 && Number(raw.focusMinutes) <= 240) result.focusMinutes = Number(raw.focusMinutes);
  if (typeof raw.autoOpen === 'boolean') result.autoOpen = raw.autoOpen;
  if (typeof raw.wideByDefault === 'boolean') result.wideByDefault = raw.wideByDefault;
  if (Array.isArray(raw.habits)) {
    const ids = new Set<string>();
    result.habits = raw.habits.filter((habit): habit is { id: string; name: string } => {
      if (!habit || typeof habit !== 'object' || typeof habit.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(habit.id) || typeof habit.name !== 'string' || !habit.name.trim() || habit.name.length > 100 || ids.has(habit.id)) return false;
      ids.add(habit.id);
      return true;
    }).map(({ id, name }) => ({ id, name }));
  }
  return result;
}

export function readSession(value: unknown): FocusSession | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as FocusSession;
  if (typeof session.id !== 'string' || !/^[a-z0-9-]{1,80}$/i.test(session.id) || !Number.isFinite(session.startedAt) || !Number.isFinite(session.durationMs) || session.durationMs < 60000 || session.durationMs > 14400000 || !Number.isFinite(session.remainingMs) || session.remainingMs < 0 || session.remainingMs > session.durationMs || (session.endsAt !== null && !Number.isFinite(session.endsAt)) || (session.filePath !== null && typeof session.filePath !== 'string')) return null;
  return { id: session.id, startedAt: session.startedAt, durationMs: session.durationMs, remainingMs: session.remainingMs, endsAt: session.endsAt, filePath: session.filePath };
}
