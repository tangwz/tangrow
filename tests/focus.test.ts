import assert from 'node:assert/strict';
import test from 'node:test';
import { focusMinutes, pauseSession, remainingMs, resumeSession, startSession } from '../src/focus';

const START = 1_800_000_000_000;
const MINUTE = 60_000;

test('paused time is excluded from completed focus minutes', () => {
  const started = startSession(25, START, 'stable-id', '00-Inbox/Note.md');
  const paused = pauseSession(started, START + 5 * MINUTE);
  assert.equal(paused.remainingMs, 20 * MINUTE);
  assert.equal(paused.endsAt, null);
  assert.equal(focusMinutes(paused, START + 60 * MINUTE), 5);
  const resumed = resumeSession(paused, START + 60 * MINUTE);
  assert.equal(resumed.endsAt, START + 80 * MINUTE);
  assert.equal(focusMinutes(resumed, START + 65 * MINUTE), 10);
  assert.equal(resumed.id, 'stable-id');
  assert.equal(resumed.startedAt, START);
  assert.equal(started.remainingMs, 25 * MINUTE);
});

test('suspension and timer expiry never exceed the planned duration', () => {
  const session = startSession(25, START, 'id', null);
  assert.equal(remainingMs(session, START + 60 * MINUTE), 0);
  assert.equal(focusMinutes(session, START + 60 * MINUTE), 25);
  const expired = pauseSession(session, START + 60 * MINUTE);
  assert.equal(resumeSession(expired, START + 61 * MINUTE), expired);
  assert.equal(focusMinutes(expired, START + 120 * MINUTE), 25);
});

test('running resume is idempotent and repeated pauses preserve elapsed time', () => {
  const session = startSession(10, START, 'id', null);
  assert.equal(resumeSession(session, START + MINUTE), session);
  const paused = pauseSession(session, START + 2 * MINUTE);
  assert.deepEqual(pauseSession(paused, START + 20 * MINUTE), paused);
  const resumed = resumeSession(paused, START + 20 * MINUTE);
  const pausedAgain = pauseSession(resumed, START + 21 * MINUTE);
  assert.equal(focusMinutes(pausedAgain, START + 30 * MINUTE), 3);
});

test('clock moving backward cannot add minutes or extend the saved remainder', () => {
  const session = pauseSession(startSession(25, START, 'id', null), START + 5 * MINUTE);
  const resumed = resumeSession(session, START + 10 * MINUTE);
  assert.equal(remainingMs(resumed, START + MINUTE), 20 * MINUTE);
  assert.equal(focusMinutes(resumed, START + MINUTE), 5);
});

test('invalid duration and time values are rejected', () => {
  for (const minutes of [0, -1, 0.5, 241, Infinity, NaN]) {
    assert.throws(() => startSession(minutes, START, 'id', null), RangeError);
  }
  for (const now of [-1, NaN, Infinity]) {
    assert.throws(() => startSession(25, now, 'id', null), RangeError);
    assert.throws(() => remainingMs(null, now), RangeError);
  }
  assert.throws(() => startSession(25, START, ' ', null), /stable ID/);
  assert.equal(remainingMs(null, START), 0);
});
