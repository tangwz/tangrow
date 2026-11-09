import assert from 'node:assert/strict';
import test from 'node:test';
import { activityLevel, activityRecordsForDay, aggregateActivity, pinnedTimestamp, type ActivityData, type ActivityDay } from '../src/activity-data';
import { readSettings } from '../src/model';
import type { ReportRecord } from '../src/report-data';
import { DEFAULT_SETTINGS } from '../src/types';

function time(year: number, month: number, day: number, hour = 12, minute = 0): number {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

const NOW = time(2026, 10, 9);

function record(path: string, created = NOW, frontmatter: Record<string, unknown> = {}): ReportRecord {
  return { path, name: path, created, modified: NOW, frontmatter };
}

function days(data: ActivityData): ActivityDay[] {
  return data.weeks.flat().filter((entry): entry is ActivityDay => entry !== null);
}

function entry(data: ActivityData, day: string): ActivityDay {
  const found = days(data).find((item) => item.day === day);
  assert.ok(found, day);
  return found;
}

test('annual calendars contain complete Monday-first weeks with empty boundary cells', () => {
  const data = aggregateActivity([], DEFAULT_SETTINGS, 2026, NOW);
  assert.equal(data.year, 2026);
  assert.equal(data.today, '2026-11-09');
  assert.equal(days(data).length, 365);
  assert.equal(data.weeks.length, 53);
  assert.ok(data.weeks.every((week) => week.length === 7));
  assert.deepEqual(data.weeks[0]?.slice(0, 3), [null, null, null]);
  assert.equal(data.weeks[0]?.[3]?.day, '2026-01-01');
  assert.equal(data.weeks.at(-1)?.[3]?.day, '2026-12-31');
  assert.deepEqual(data.weeks.at(-1)?.slice(4), [null, null, null]);
  assert.equal(entry(data, '2026-11-09').future, false);
  assert.equal(entry(data, '2026-11-10').future, true);
  assert.deepEqual(data.months.map((item) => item.month), Array.from({ length: 12 }, (_, index) => index));
  for (const month of data.months) {
    assert.ok(data.weeks[month.column]?.some((day) => day?.day === `2026-${String(month.month + 1).padStart(2, '0')}-01`));
  }
});

test('leap years and early supported years retain their real calendar dates', () => {
  const leap = aggregateActivity([], DEFAULT_SETTINGS, 2024, NOW);
  assert.equal(days(leap).length, 366);
  assert.equal(entry(leap, '2024-02-29').future, false);
  const early = aggregateActivity([], DEFAULT_SETTINGS, 1, NOW);
  assert.equal(days(early).length, 365);
  assert.equal(days(early)[0]?.day, '0001-01-01');
  assert.equal(early.weeks[0]?.[0]?.day, '0001-01-01');
  const last = aggregateActivity([], DEFAULT_SETTINGS, 9999, NOW);
  assert.equal(days(last).at(-1)?.day, '9999-12-31');
  assert.ok(days(last).every((day) => day.future));
});

test('creation and current pin activity are deduplicated and use separate dates and directory scopes', () => {
  const rows = [
    record('00-Inbox/Note.md', time(2026, 0, 1), { tangrow_pin: true, tangrow_pinned_at: new Date(time(2026, 5, 3)).toISOString() }),
    record('90-Archive/Archived.md', time(2026, 0, 1)),
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Focus.md`, time(2026, 0, 1), { tangrow_pin: true, tangrow_pinned_at: time(2026, 5, 3) }),
    record(`${DEFAULT_SETTINGS.supportFolder}-Other/Note.md`, time(2026, 0, 2)),
    record('00-Inbox/Unpinned.md', time(2026, 0, 3), { tangrow_pin: false, tangrow_pinned_at: time(2026, 5, 4) })
  ];
  const before = structuredClone(rows);
  const data = aggregateActivity([...rows, rows[0]!], DEFAULT_SETTINGS, 2026, NOW);
  assert.deepEqual(data.notes, { total: 4, activeDays: 3 });
  assert.deepEqual(data.pins, { total: 2, activeDays: 1 });
  assert.equal(entry(data, '2026-01-01').notes, 2);
  assert.equal(entry(data, '2026-06-03').pins, 2);
  assert.equal(entry(data, '2026-06-04').pins, 0);
  assert.deepEqual(rows, before);
  const unpinned = aggregateActivity([...rows, record(rows[0]!.path, time(2026, 0, 1))], DEFAULT_SETTINGS, 2026, NOW);
  assert.equal(unpinned.pins.total, 1);
});

test('conflicting support settings do not hide user creation activity', () => {
  const settings = readSettings({ ...DEFAULT_SETTINGS, supportFolder: 'Content', projectFolder: 'Content/Projects' });
  const data = aggregateActivity([record('Content/Projects/Note.md'), record('Content/Other.md')], settings, 2026, NOW);
  assert.equal(data.notes.total, 2);
});

test('report exclusions apply to note activity without hiding explicit pins or sibling paths', () => {
  const settings = readSettings({ ...DEFAULT_SETTINGS, reportExcludedFolders: ['Private'] });
  const data = aggregateActivity([
    record('Private/Hidden.md', NOW, { tangrow_pin: true, tangrow_pinned_at: NOW }),
    record('Private-Other/Visible.md', NOW),
    record('00-Inbox/Visible.md', NOW)
  ], settings, 2026, NOW);
  assert.deepEqual(data.notes, { total: 2, activeDays: 1 });
  assert.deepEqual(data.pins, { total: 1, activeDays: 1 });
});

test('missing or invalid pin dates are reported without inventing historical activity', () => {
  const invalid: unknown[] = [undefined, null, '', 'not a date', '2026-02-30', '2025-02-29', '2026-13-01', '2026-00-01', '1', '2026-01-01T25:00:00Z', NaN, Infinity, -1, 8.64e15 + 1, {}, true];
  const rows = invalid.map((value, index) => record(`pin-${index}.md`, NOW, { tangrow_pin: true, tangrow_pinned_at: value }));
  rows.push(record('not-pinned.md', NOW, { tangrow_pinned_at: 'invalid' }));
  rows.push(record('future-pin.md', NOW, { tangrow_pin: true, tangrow_pinned_at: NOW + 1 }));
  const data = aggregateActivity(rows, DEFAULT_SETTINGS, 2026, NOW);
  assert.equal(data.undatedPins, invalid.length);
  assert.deepEqual(data.pins, { total: 0, activeDays: 0 });
  assert.equal(aggregateActivity(rows, DEFAULT_SETTINGS, 2025, NOW).undatedPins, invalid.length);
});

test('pin timestamps reject time and offset components outside their numeric ranges', () => {
  for (const value of [
    '2026-01-01T24:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T25:00:00Z',
    '2026-01-01T23:60:00Z',
    '2026-01-01T23:59:60Z',
    '2026-01-01T12:00:00+24:00',
    '2026-01-01T12:00:00-24:00',
    '2026-01-01T12:00:00+01:60',
    '2026-01-01T12:00:00-01:60'
  ]) assert.equal(pinnedTimestamp(value), null, value);
  const valid = '2026-01-01T23:59:59.123+14:00';
  assert.equal(pinnedTimestamp(valid), Date.parse(valid));
});

test('zoned ISO dates are validated independently of local calendar days skipped by timezone changes', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Pacific/Apia';
  try {
    const source = '2011-12-30T12:00:00Z';
    assert.equal(pinnedTimestamp(source), Date.parse(source));
    assert.equal(pinnedTimestamp('2011-12-30'), null);
    assert.equal(pinnedTimestamp('2011-02-29T12:00:00Z'), null);
    const data = aggregateActivity([
      record('pinned.md', NOW, { tangrow_pin: true, tangrow_pinned_at: source })
    ], DEFAULT_SETTINGS, 2011, NOW);
    assert.equal(entry(data, '2011-12-31').pins, 1);
    assert.equal(data.undatedPins, 0);
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test('year boundaries and future instants are excluded while dates at the exact cutoff count', () => {
  const rows = [
    record('before.md', time(2025, 11, 31, 23, 59), { tangrow_pin: true, tangrow_pinned_at: time(2025, 11, 31, 23, 59) }),
    record('first.md', time(2026, 0, 1, 0), { tangrow_pin: true, tangrow_pinned_at: time(2026, 0, 1, 0) }),
    record('now.md', NOW, { tangrow_pin: true, tangrow_pinned_at: NOW }),
    record('later-today.md', NOW + 1, { tangrow_pin: true, tangrow_pinned_at: NOW + 1 }),
    record('next-year.md', time(2027, 0, 1), { tangrow_pin: true, tangrow_pinned_at: time(2027, 0, 1) }),
    ...[NaN, Infinity, -1, 8.64e15 + 1].map((value, index) => record(`invalid-${index}.md`, value))
  ];
  const data = aggregateActivity(rows, DEFAULT_SETTINGS, 2026, NOW);
  assert.deepEqual(data.notes, { total: 2, activeDays: 2 });
  assert.deepEqual(data.pins, { total: 2, activeDays: 2 });
  assert.equal(entry(data, '2026-01-01').notes, 1);
  assert.equal(entry(data, '2026-11-09').pins, 1);
  assert.equal(entry(data, '2026-11-09').future, false);
  assert.equal(days(data).filter((day) => day.future).reduce((sum, day) => sum + day.notes + day.pins, 0), 0);
});

function isoWithOffset(timestamp: number, offsetMinutes: number): string {
  const wallTime = new Date(timestamp + offsetMinutes * 60_000).toISOString().slice(0, 19);
  const absolute = Math.abs(offsetMinutes);
  return `${wallTime}${offsetMinutes < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

test('ISO offsets are grouped by local day and date-only pins keep their written day', () => {
  const before = time(2026, 10, 7, 23, 45);
  const after = time(2026, 10, 8, 0, 15);
  const data = aggregateActivity([
    record('before.md', before, { tangrow_pin: true, tangrow_pinned_at: isoWithOffset(before, -14 * 60) }),
    record('after.md', after, { tangrow_pin: true, tangrow_pinned_at: isoWithOffset(after, -14 * 60) }),
    record('date-only.md', NOW, { tangrow_pin: true, tangrow_pinned_at: '2026-11-07' })
  ], DEFAULT_SETTINGS, 2026, NOW);
  assert.equal(entry(data, '2026-11-07').notes, 1);
  assert.equal(entry(data, '2026-11-08').notes, 1);
  assert.equal(entry(data, '2026-11-07').pins, 2);
  assert.equal(entry(data, '2026-11-08').pins, 1);
});

test('daily records merge creation and current pin events while preserving independent directory scopes', () => {
  const settings = { ...DEFAULT_SETTINGS, reportExcludedFolders: ['Private'] };
  const old = time(2026, 0, 1);
  const rows = [
    record('z-new.md'),
    record('b-pin.md', old, { tangrow_pin: true, tangrow_pinned_at: NOW }),
    record('a-both.md', NOW, { tangrow_pin: true, tangrow_pinned_at: new Date(NOW).toISOString() }),
    record(`${settings.supportFolder}/Pinned.md`, NOW, { tangrow_pin: true, tangrow_pinned_at: NOW }),
    record(`${settings.supportFolder}/Unpinned.md`),
    record('Private/Pinned.md', NOW, { tangrow_pin: true, tangrow_pinned_at: NOW }),
    record('Private/Unpinned.md'),
    record('Private-Other/New.md')
  ];
  const before = structuredClone(rows);
  const matches = activityRecordsForDay(rows, settings, '2026-11-09', NOW);
  assert.deepEqual(matches.map(({ record, isNew, isPinned }) => ({ path: record.path, isNew, isPinned })), [
    { path: `${settings.supportFolder}/Pinned.md`, isNew: false, isPinned: true },
    { path: 'a-both.md', isNew: true, isPinned: true },
    { path: 'b-pin.md', isNew: false, isPinned: true },
    { path: 'Private-Other/New.md', isNew: true, isPinned: false },
    { path: 'Private/Pinned.md', isNew: false, isPinned: true },
    { path: 'z-new.md', isNew: true, isPinned: false }
  ].sort((left, right) => left.path.localeCompare(right.path)));
  assert.equal(matches.find((item) => item.record.path === 'a-both.md')?.record, rows[2]);
  assert.deepEqual(rows, before);
  const day = entry(aggregateActivity(rows, settings, 2026, NOW), '2026-11-09');
  assert.equal(matches.filter((item) => item.isNew).length, day.notes);
  assert.equal(matches.filter((item) => item.isPinned).length, day.pins);
});

test('daily detail keeps the last duplicate path and excludes invalid, future and unknown activity dates', () => {
  const old = time(2026, 0, 1);
  const rows = [
    record('removed.md', NOW, { tangrow_pin: true, tangrow_pinned_at: NOW }),
    record('removed.md', old, {}),
    record('replaced.md', old, { tangrow_pin: true, tangrow_pinned_at: NOW }),
    record('replaced.md', NOW),
    record('unknown-pin.md', old, { tangrow_pin: true }),
    record('invalid-pin.md', old, { tangrow_pin: true, tangrow_pinned_at: '2026-11-09T24:00:00Z' }),
    record('future-pin.md', old, { tangrow_pin: true, tangrow_pinned_at: NOW + 1 }),
    record('future-created.md', NOW + 1, { tangrow_pin: true, tangrow_pinned_at: NOW }),
    record('unpinned.md', old, { tangrow_pin: false, tangrow_pinned_at: NOW }),
    record('invalid-created.md', NaN, { tangrow_pin: true, tangrow_pinned_at: NOW }),
    record('negative-created.md', -1),
    record('infinite-created.md', Infinity)
  ];
  const matches = activityRecordsForDay(rows, DEFAULT_SETTINGS, '2026-11-09', NOW);
  assert.deepEqual(matches.map(({ record, isNew, isPinned }) => ({ path: record.path, isNew, isPinned })), [
    { path: 'future-created.md', isNew: false, isPinned: true },
    { path: 'invalid-created.md', isNew: false, isPinned: true },
    { path: 'replaced.md', isNew: true, isPinned: false }
  ]);
  const day = entry(aggregateActivity(rows, DEFAULT_SETTINGS, 2026, NOW), '2026-11-09');
  assert.equal(matches.filter((item) => item.isNew).length, day.notes);
  assert.equal(matches.filter((item) => item.isPinned).length, day.pins);
  assert.deepEqual(activityRecordsForDay(rows, DEFAULT_SETTINGS, '2026-11-10', NOW), []);
  assert.throws(() => activityRecordsForDay(rows, DEFAULT_SETTINGS, '2026-11-09', NaN), RangeError);
});

test('daily detail uses local creation dates and the same ISO-offset pin dates as the calendar', () => {
  const before = time(2026, 10, 7, 23, 45);
  const after = time(2026, 10, 8, 0, 15);
  const rows = [
    record('before.md', before, { tangrow_pin: true, tangrow_pinned_at: isoWithOffset(after, -14 * 60) }),
    record('after.md', after, { tangrow_pin: true, tangrow_pinned_at: isoWithOffset(before, -14 * 60) })
  ];
  assert.deepEqual(activityRecordsForDay(rows, DEFAULT_SETTINGS, '2026-11-07', NOW).map(({ record, isNew, isPinned }) => ({ path: record.path, isNew, isPinned })), [
    { path: 'after.md', isNew: false, isPinned: true },
    { path: 'before.md', isNew: true, isPinned: false }
  ]);
  assert.deepEqual(activityRecordsForDay(rows, DEFAULT_SETTINGS, '2026-11-08', NOW).map(({ record, isNew, isPinned }) => ({ path: record.path, isNew, isPinned })), [
    { path: 'after.md', isNew: true, isPinned: false },
    { path: 'before.md', isNew: false, isPinned: true }
  ]);
});

test('calendar arithmetic keeps every local day continuous across daylight-saving boundaries', () => {
  const rows: ReportRecord[] = [];
  for (const month of [2, 10]) {
    const length = month === 2 ? 31 : 30;
    for (let day = 1; day <= length; day++) {
      for (const hour of [0, 23]) {
        const created = time(2026, month, day, hour, 30);
        rows.push(record(`${month}-${day}-${hour}.md`, created, { tangrow_pin: true, tangrow_pinned_at: new Date(created).toISOString() }));
      }
    }
  }
  const data = aggregateActivity(rows, DEFAULT_SETTINGS, 2026, time(2026, 11, 31, 23, 59));
  assert.equal(new Set(days(data).map((day) => day.day)).size, 365);
  for (const day of days(data).filter((item) => item.day.startsWith('2026-03-') || item.day.startsWith('2026-11-'))) {
    assert.equal(day.notes, 2, day.day);
    assert.equal(day.pins, 2, day.day);
  }
  assert.deepEqual(data.notes, { total: 122, activeDays: 61 });
});

test('intensity thresholds stay comparable across days and years', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 7, 8, 100].map(activityLevel), [0, 1, 2, 2, 3, 3, 4, 4]);
  assert.equal(activityLevel(-1), 0);
  assert.equal(activityLevel(NaN), 0);
});

test('invalid years and report clocks fail before aggregation', () => {
  for (const year of [0, -1, 10000, 2026.5, NaN, Infinity]) {
    assert.throws(() => aggregateActivity([], DEFAULT_SETTINGS, year, NOW), RangeError);
  }
  for (const now of [-1, NaN, Infinity, 8.64e15 + 1]) {
    assert.throws(() => aggregateActivity([], DEFAULT_SETTINGS, 2026, now), RangeError);
  }
});
