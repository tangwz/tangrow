import type { FocusSession } from './types';

const MINUTE_MS = 60_000;

function validateTime(now: number): void {
  if (!Number.isFinite(now) || now < 0) throw new RangeError('Time must be a finite non-negative timestamp.');
}

export function remainingMs(session: FocusSession | null, now: number): number {
  validateTime(now);
  if (!session) return 0;
  const remaining = session.endsAt === null ? session.remainingMs : session.endsAt - now;
  return Math.max(0, Math.min(session.durationMs, session.remainingMs, remaining));
}

export function startSession(minutes: number, now: number, id: string, filePath: string | null): FocusSession {
  validateTime(now);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
    throw new RangeError('Focus duration must be a whole number between 1 and 240 minutes.');
  }
  if (!id.trim()) throw new Error('A focus session requires a stable ID.');
  const durationMs = minutes * MINUTE_MS;
  return { id, startedAt: now, durationMs, remainingMs: durationMs, endsAt: now + durationMs, filePath };
}

export function pauseSession(session: FocusSession, now: number): FocusSession {
  const remaining = remainingMs(session, now);
  return { ...session, remainingMs: remaining, endsAt: null };
}

export function resumeSession(session: FocusSession, now: number): FocusSession {
  validateTime(now);
  if (session.endsAt !== null || session.remainingMs <= 0) return session;
  return { ...session, endsAt: now + session.remainingMs };
}

export function focusMinutes(session: FocusSession, now: number): number {
  return (session.durationMs - remainingMs(session, now)) / MINUTE_MS;
}
