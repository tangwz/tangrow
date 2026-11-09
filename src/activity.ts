import { dayKey, recentDays } from './model';

const BUCKET_MS = 15 * 60_000;
const IDLE_THRESHOLD_MS = 60_000;
const MAX_EDIT_GAP_MS = 30_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

export const ACTIVITY_RANGES = [1, 7, 30, 60, 90, 180, 365] as const;
export type ActivityRange = typeof ACTIVITY_RANGES[number];

export interface EditingActivityState {
  version: 1;
  startedAt: number;
  buckets: Array<{ start: number; ms: number }>;
}

export interface ActivitySummary {
  startedAt: number;
  totalMs: number;
  minutes: number;
  hours: Array<{ hour: number; ms: number; minutes: number }>;
  days: Array<{ day: string; ms: number; minutes: number }>;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MS;
}

function assertTime(value: number): void {
  if (!validTime(value)) throw new RangeError('Activity time must be a finite non-negative timestamp.');
}

function bucketStart(time: number): number {
  return Math.floor(time / BUCKET_MS) * BUCKET_MS;
}

function rangeStart(range: number, now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - range + 1);
  return Math.max(0, date.getTime());
}

export function createActivityState(now = Date.now()): EditingActivityState {
  assertTime(now);
  return { version: 1, startedAt: now, buckets: [] };
}

export function normalizeActivityState(value: unknown, now = Date.now()): EditingActivityState {
  assertTime(now);
  if (!value || typeof value !== 'object') return createActivityState(now);
  const raw = value as Partial<EditingActivityState>;
  if (raw.version !== 1 || !validTime(raw.startedAt) || raw.startedAt > now || !Array.isArray(raw.buckets)) {
    return createActivityState(now);
  }
  const oldestBucket = bucketStart(rangeStart(365, now));
  const latestBucket = bucketStart(now);
  const buckets = new Map<number, number>();
  for (const entry of raw.buckets) {
    if (!entry || typeof entry !== 'object' || !validTime(entry.start) || entry.start !== bucketStart(entry.start)
      || entry.start < oldestBucket || entry.start > latestBucket || typeof entry.ms !== 'number'
      || !Number.isFinite(entry.ms) || entry.ms <= 0) continue;
    const available = Math.max(0, Math.min(entry.start + BUCKET_MS, now) - Math.max(entry.start, raw.startedAt));
    const ms = Math.min(entry.ms, available);
    // Duplicate persisted buckets describe the same interval, not additional sessions.
    if (ms > 0) buckets.set(entry.start, Math.max(buckets.get(entry.start) ?? 0, ms));
  }
  return {
    version: 1,
    startedAt: raw.startedAt,
    buckets: [...buckets].sort(([left], [right]) => left - right).map(([start, ms]) => ({ start, ms }))
  };
}

export function addEditingActivity(
  state: EditingActivityState,
  eventMs: number,
  previousEventMs: number | null
): { state: EditingActivityState; lastEventMs: number } {
  assertTime(eventMs);
  // Keep the high-water mark during a clock rollback to avoid counting time twice.
  if (validTime(previousEventMs) && eventMs <= previousEventMs) return { state, lastEventMs: previousEventMs };
  const normalized = normalizeActivityState(state, eventMs);
  const result = { state: normalized, lastEventMs: eventMs };
  if (!validTime(previousEventMs) || eventMs - previousEventMs > IDLE_THRESHOLD_MS) return result;

  // Only actual edits bound an interval. No timer credits idle or background time.
  let cursor = Math.max(previousEventMs, eventMs - MAX_EDIT_GAP_MS, normalized.startedAt, rangeStart(365, eventMs));
  const buckets = new Map(normalized.buckets.map(({ start, ms }) => [start, ms]));
  while (cursor < eventMs) {
    // Quarter-hour boundaries also align with modern half- and quarter-hour offsets.
    const start = bucketStart(cursor);
    const end = Math.min(eventMs, start + BUCKET_MS);
    const available = Math.min(eventMs, start + BUCKET_MS) - Math.max(start, normalized.startedAt);
    buckets.set(start, Math.min(available, (buckets.get(start) ?? 0) + end - cursor));
    cursor = end;
  }
  result.state = {
    ...normalized,
    buckets: [...buckets].sort(([left], [right]) => left - right).map(([start, ms]) => ({ start, ms }))
  };
  return result;
}

export function summarizeActivity(state: EditingActivityState, range: ActivityRange, now = Date.now()): ActivitySummary {
  assertTime(now);
  if (!ACTIVITY_RANGES.includes(range)) throw new RangeError('Use a supported activity range.');
  const normalized = normalizeActivityState(state, now);
  const days = recentDays(range, now).map((day) => ({ day, ms: 0, minutes: 0 }));
  const byDay = new Map(days.map((entry) => [entry.day, entry]));
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, ms: 0, minutes: 0 }));
  let totalMs = 0;
  for (const bucket of normalized.buckets) {
    const day = byDay.get(dayKey(bucket.start));
    if (!day) continue;
    const hour = hours[new Date(bucket.start).getHours()];
    if (!hour) continue;
    day.ms += bucket.ms;
    hour.ms += bucket.ms;
    totalMs += bucket.ms;
  }
  for (const entry of days) entry.minutes = entry.ms / 60_000;
  for (const entry of hours) entry.minutes = entry.ms / 60_000;
  return { startedAt: normalized.startedAt, totalMs, minutes: totalMs / 60_000, hours, days };
}
