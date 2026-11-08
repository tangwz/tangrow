export type RecentPathExists = (path: string) => boolean;
export const RECENT_OPENED_LIMIT = 50;

function normalizedPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const path = value.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || /[\u0000-\u001f\u007f]/.test(path)) return null;
  if (path.split('/').some((segment) => !segment || segment.startsWith('.'))) return null;
  return path;
}

function boundedLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.min(RECENT_OPENED_LIMIT, Math.floor(limit))) : RECENT_OPENED_LIMIT;
}

export function normalizeRecentOpened(value: unknown, exists?: RecentPathExists, limit = RECENT_OPENED_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const maximum = boundedLimit(limit);
  if (maximum === 0) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const path = normalizedPath(entry);
    if (!path || seen.has(path) || (exists && !exists(path))) continue;
    seen.add(path);
    result.push(path);
    if (result.length === maximum) break;
  }
  return result;
}

export function recordRecentOpened(paths: readonly string[], path: string, exists?: RecentPathExists, limit = RECENT_OPENED_LIMIT): string[] {
  return normalizeRecentOpened([path, ...paths], exists, limit);
}

export function renameRecentOpened(paths: readonly string[], oldPath: string, newPath: string, exists?: RecentPathExists, limit = RECENT_OPENED_LIMIT): string[] {
  const previous = normalizedPath(oldPath);
  const next = normalizedPath(newPath);
  if (!previous) return normalizeRecentOpened(paths, exists, limit);
  const renamed = paths.map((path) => {
    const current = normalizedPath(path);
    if (!current) return null;
    if (current === previous) return next;
    if (current.startsWith(`${previous}/`)) return next ? `${next}${current.slice(previous.length)}` : null;
    return current;
  });
  return normalizeRecentOpened(renamed, exists, limit);
}

export function removeRecentOpened(paths: readonly string[], path: string): string[] {
  const removed = normalizedPath(path);
  return normalizeRecentOpened(paths.filter((path) => {
    const current = normalizedPath(path);
    return current && (!removed || (current !== removed && !current.startsWith(`${removed}/`)));
  }));
}
