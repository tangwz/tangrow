import assert from 'node:assert/strict';
import test from 'node:test';
import { addEditingActivity, createActivityState, normalizeActivityState, summarizeActivity } from '../src/activity';

const HOUR = 3_600_000;
const BUCKET = 15 * 60_000;
const START = Date.UTC(2026, 10, 8, 10);

function inTimezone<T>(timezone: string, action: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try { return action(); }
  finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('only intervals between actual edits count, and each interval is capped', () => {
  const initial = createActivityState(START);
  const first = addEditingActivity(initial, START, null);
  assert.deepEqual(first.state.buckets, []);
  const second = addEditingActivity(first.state, START + 10_000, first.lastEventMs);
  const third = addEditingActivity(second.state, START + 60_000, second.lastEventMs);
  assert.deepEqual(third.state.buckets, [{ start: START, ms: 40_000 }]);
  assert.deepEqual(initial.buckets, []);
  assert.deepEqual(second.state.buckets, [{ start: START, ms: 10_000 }]);
});

test('idle gaps and reset baselines for hidden or unfocused editors add no time', () => {
  const initial = createActivityState(START);
  const idle = addEditingActivity(initial, START + 60_001, START);
  assert.deepEqual(idle.state.buckets, []);
  const resumed = addEditingActivity(idle.state, START + 70_001, idle.lastEventMs);
  const unfocused = addEditingActivity(resumed.state, START + 80_001, null);
  assert.deepEqual(unfocused.state.buckets, resumed.state.buckets);
  assert.equal(unfocused.lastEventMs, START + 80_001);
});

test('credits are split across hour and local midnight boundaries', () => inTimezone('Asia/Shanghai', () => {
  const midnight = Date.UTC(2026, 10, 8, 16);
  const state = addEditingActivity(createActivityState(midnight - 10_000), midnight + 10_000, midnight - 10_000).state;
  assert.deepEqual(state.buckets, [{ start: midnight - BUCKET, ms: 10_000 }, { start: midnight, ms: 10_000 }]);
  const today = summarizeActivity(state, 1, midnight + 10_000);
  assert.equal(today.totalMs, 10_000);
  assert.equal(today.hours[0]?.ms, 10_000);
  assert.deepEqual(today.days, [{ day: '2026-11-09', ms: 10_000, minutes: 1 / 6 }]);
  const week = summarizeActivity(state, 7, midnight + 10_000);
  assert.equal(week.totalMs, 20_000);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[5]?.ms, 10_000);
  assert.equal(week.hours[23]?.ms, 10_000);
}));

test('DST repeated local hours remain distinct in persisted data and merge in hourly summaries', () => inTimezone('America/New_York', () => {
  const transition = Date.UTC(2026, 10, 1, 6);
  const state = addEditingActivity(createActivityState(transition - 10_000), transition + 10_000, transition - 10_000).state;
  assert.deepEqual(state.buckets, [{ start: transition - BUCKET, ms: 10_000 }, { start: transition, ms: 10_000 }]);
  const summary = summarizeActivity(state, 1, transition + 10_000);
  assert.equal(summary.hours[1]?.ms, 20_000);
  assert.equal(summary.totalMs, 20_000);
  assert.equal(summary.days[0]?.day, '2026-11-01');
}));

test('half-hour and quarter-hour time zones split edits across the correct local midnight', () => {
  for (const [timezone, midnight] of [
    ['Asia/Kolkata', Date.UTC(2026, 10, 8, 18, 30)],
    ['Asia/Kathmandu', Date.UTC(2026, 10, 8, 18, 15)]
  ] as const) inTimezone(timezone, () => {
    const state = addEditingActivity(createActivityState(midnight - 10_000), midnight + 10_000, midnight - 10_000).state;
    assert.deepEqual(state.buckets, [{ start: midnight - BUCKET, ms: 10_000 }, { start: midnight, ms: 10_000 }]);
    const today = summarizeActivity(state, 1, midnight + 10_000);
    assert.equal(today.totalMs, 10_000);
    assert.equal(today.hours[0]?.ms, 10_000);
    const week = summarizeActivity(state, 7, midnight + 10_000);
    assert.equal(week.days[5]?.ms, 10_000);
    assert.equal(week.days[6]?.ms, 10_000);
    assert.equal(week.hours[23]?.ms, 10_000);
  });
});

test('half-hour DST transitions retain exact duration and correct local hour labels', () => inTimezone('Australia/Lord_Howe', () => {
  for (const [transition, beforeHour, afterHour] of [
    [Date.UTC(2026, 3, 4, 15), 1, 1],
    [Date.UTC(2026, 9, 3, 15, 30), 1, 2]
  ] as const) {
    const state = addEditingActivity(createActivityState(transition - 10_000), transition + 10_000, transition - 10_000).state;
    assert.deepEqual(state.buckets, [{ start: transition - BUCKET, ms: 10_000 }, { start: transition, ms: 10_000 }]);
    const today = summarizeActivity(state, 1, transition + 10_000);
    assert.equal(today.totalMs, 20_000);
    if (beforeHour === afterHour) assert.equal(today.hours[beforeHour]?.ms, 20_000);
    else {
      assert.equal(today.hours[beforeHour]?.ms, 10_000);
      assert.equal(today.hours[afterHour]?.ms, 10_000);
    }
  }
}));

test('clock rollback keeps a high-water mark and cannot count the same interval twice', () => {
  const initial = addEditingActivity(createActivityState(START), START + 30_000, START);
  const backward = addEditingActivity(initial.state, START + 10_000, initial.lastEventMs);
  const stillBehind = addEditingActivity(backward.state, START + 20_000, backward.lastEventMs);
  assert.equal(backward.state, initial.state);
  assert.equal(stillBehind.lastEventMs, START + 30_000);
  const caughtUp = addEditingActivity(stillBehind.state, START + 40_000, stillBehind.lastEventMs);
  assert.deepEqual(caughtUp.state.buckets, [{ start: START, ms: 40_000 }]);
});

test('persisted corruption, future buckets and duplicate buckets cannot inflate an interval', () => {
  const state = normalizeActivityState({
    version: 1,
    startedAt: START - HOUR,
    buckets: [
      null, { start: START, ms: Infinity }, { start: START + 1, ms: 10_000 },
      { start: START + HOUR, ms: HOUR }, { start: START, ms: HOUR * 20 },
      { start: START - HOUR, ms: HOUR }, { start: START - HOUR, ms: HOUR / 2 }
    ]
  }, START + 10_000);
  assert.deepEqual(state.buckets, [{ start: START - HOUR, ms: BUCKET }, { start: START, ms: 10_000 }]);
  assert.deepEqual(normalizeActivityState({ version: 2, startedAt: START, buckets: [] }, START), createActivityState(START));
  assert.deepEqual(normalizeActivityState(null, START), createActivityState(START));
  assert.deepEqual(normalizeActivityState({ version: 1, startedAt: START + 1, buckets: [] }, START), createActivityState(START));
});

test('old buckets are discarded and storage stays bounded to 365 calendar days', () => inTimezone('UTC', () => {
  const now = Date.UTC(2026, 10, 9, 12);
  const buckets = Array.from({ length: 400 * 24 * 4 }, (_, index) => ({ start: now - index * BUCKET, ms: 1_000 }));
  const state = normalizeActivityState({ version: 1, startedAt: now - 400 * 24 * HOUR, buckets }, now);
  assert.equal(state.buckets.length, 364 * 24 * 4 + 48);
  const summary = summarizeActivity(state, 365, now);
  assert.equal(summary.days.length, 365);
  assert.equal(summary.days[0]?.day, '2025-11-10');
  assert.equal(summary.days[364]?.day, '2026-11-09');
  assert.equal(summary.totalMs, state.buckets.length * 1_000);
  const movedOn = addEditingActivity(state, now + 2 * 24 * HOUR, null).state;
  assert.equal(movedOn.buckets.length, state.buckets.length - 2 * 24 * 4);
}));

test('tracking never backfills activity before it was started and summary is read-only', () => {
  const state = addEditingActivity(createActivityState(START + 20_000), START + 30_000, START).state;
  assert.deepEqual(state.buckets, [{ start: START, ms: 10_000 }]);
  const snapshot = JSON.stringify(state);
  const summary = summarizeActivity(state, 7, START + 30_000);
  assert.equal(summary.minutes, 1 / 6);
  assert.equal(summary.startedAt, START + 20_000);
  assert.equal(JSON.stringify(state), snapshot);
});

test('invalid timestamps and unsupported report ranges are rejected', () => {
  for (const now of [-1, NaN, Infinity, 8_640_000_000_000_001]) {
    assert.throws(() => createActivityState(now), RangeError);
    assert.throws(() => normalizeActivityState(null, now), RangeError);
    assert.throws(() => addEditingActivity(createActivityState(START), now, null), RangeError);
    assert.throws(() => summarizeActivity(createActivityState(START), 1, now), RangeError);
  }
  assert.throws(() => summarizeActivity(createActivityState(START), 2 as 1, START), RangeError);
});
