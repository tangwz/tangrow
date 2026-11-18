import type { CardReport, CardReportRow } from './card-report-data';
import { parseNoteTimestamp } from './capture-data';

const REVIEW_REASONS = ['isolated', 'overdue', 'sample'] as const;
export type CardReviewReason = typeof REVIEW_REASONS[number];

export interface CardReviewEntry { path: string; id?: string; reason: CardReviewReason }
export interface CardReviewQueue { day: string; entries: CardReviewEntry[]; completed: string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readCardReviewQueue(value: unknown): CardReviewQueue | null {
  if (!isRecord(value) || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
    || parseNoteTimestamp(value.day) === null
    || !Array.isArray(value.entries) || !Array.isArray(value.completed)) return null;
  const entries: CardReviewEntry[] = [];
  const paths = new Set<string>();
  for (const entry of value.entries as unknown[]) {
    if (!isRecord(entry) || typeof entry.path !== 'string' || !entry.path.trim() || paths.has(entry.path)
      || !REVIEW_REASONS.includes(entry.reason as CardReviewReason)) return null;
    paths.add(entry.path);
    entries.push({ path: entry.path, reason: entry.reason as CardReviewReason, ...(typeof entry.id === 'string' && entry.id.trim() ? { id: entry.id.trim() } : {}) });
  }
  const completed = (value.completed as unknown[]).filter((path): path is string => typeof path === 'string' && paths.has(path));
  return { day: value.day, entries, completed: [...new Set(completed)] };
}

function cardId(row: CardReportRow): string | undefined {
  const id = row.note.frontmatter?.tangrow_id;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

function dailyRank(day: string, path: string): number {
  let hash = 2166136261;
  for (const character of `${day}\n${path}`) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function createCardReviewQueue(cards: CardReport, count = 3): CardReviewQueue {
  const ranked = cards.rows.map((row) => {
    const reason = row.groups.has('isolated') ? 'isolated'
      : row.groups.has('stale') || row.groups.has('noReview') ? 'overdue' : 'sample';
    const entry: CardReviewEntry = { path: row.note.path, id: cardId(row), reason };
    return { entry, rank: dailyRank(cards.today, entry.id ?? entry.path) };
  });
  ranked.sort((a, b) => REVIEW_REASONS.indexOf(a.entry.reason) - REVIEW_REASONS.indexOf(b.entry.reason) || a.rank - b.rank
    || (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0));
  return { day: cards.today, entries: ranked.slice(0, Math.max(0, count)).map(({ entry }) => entry), completed: [] };
}

export function resolveCardReviewQueue(queue: CardReviewQueue, cards: CardReport) {
  const byPath = new Map(cards.rows.map((row) => [row.note.path, row]));
  const byId = new Map<string, CardReportRow | null>();
  for (const row of cards.rows) {
    const id = cardId(row);
    if (id) byId.set(id, byId.has(id) ? null : row);
  }
  const complete = new Set(queue.completed);
  return queue.entries.map((entry) => {
    const atPath = byPath.get(entry.path);
    const row = atPath && (!entry.id || cardId(atPath) === entry.id) ? atPath : entry.id ? byId.get(entry.id) : undefined;
    return { entry, row: row ?? null, reviewed: complete.has(entry.path) };
  });
}
