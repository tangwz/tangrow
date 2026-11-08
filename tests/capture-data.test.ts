import assert from 'node:assert/strict';
import test from 'node:test';
import { captureCalendar, captureCreated, captureDay, groupCapturesByDay, shiftCaptureMonth, sortCaptures, type CaptureSummary } from '../src/capture-data';

function localTime(year: number, monthIndex: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, monthIndex, day, hour, minute).getTime();
}

function capture(path: string, created: number, modified = created): CaptureSummary {
  return { path, name: path, folder: '00-Inbox', created, modified, kind: 'capture' };
}

test('capture creation metadata takes precedence and invalid values fall back deterministically', () => {
  const ctime = localTime(2026, 10, 8);
  const mtime = localTime(2026, 10, 9);
  const created = localTime(2025, 3, 4, 11, 22);
  assert.equal(captureCreated(created, ctime, mtime), created);
  assert.equal(captureCreated(new Date(created).toISOString(), ctime, mtime), created);
  for (const value of ['', 'not a date', '2026-02-30', NaN, Infinity, {}, null, undefined]) {
    assert.equal(captureCreated(value, ctime, mtime), ctime);
  }
  assert.equal(captureCreated('invalid', NaN, mtime), mtime);
  assert.equal(captureCreated('invalid', Infinity, NaN), 0);
  assert.equal(captureCreated(0, ctime, mtime), 0);
});

test('date-only creation metadata keeps the local date and validates leap days', () => {
  assert.equal(captureCreated('2024-02-29', 0, 0), localTime(2024, 1, 29, 0));
  assert.equal(captureDay(captureCreated('2024-02-29', 0, 0)), '2024-02-29');
  assert.equal(captureCreated('2025-02-29', 1234, 5678), 1234);
  assert.equal(captureCreated('2026-13-01', 1234, 5678), 1234);
  assert.equal(captureCreated('2026-00-01', 1234, 5678), 1234);
  assert.throws(() => captureDay(NaN), RangeError);
});

test('capture grouping uses creation days rather than edit times and resolves ties by path', () => {
  const late = localTime(2026, 0, 1, 0, 10);
  const early = localTime(2025, 11, 31, 23, 50);
  const captures = [
    capture('00-Inbox/z.md', late),
    capture('00-Inbox/old.md', early, localTime(2027, 0, 1)),
    capture('00-Inbox/a.md', late)
  ];
  const originalPaths = captures.map((note) => note.path);
  assert.deepEqual(sortCaptures(captures).map((note) => note.path), ['00-Inbox/a.md', '00-Inbox/z.md', '00-Inbox/old.md']);
  const groups = groupCapturesByDay(captures);
  assert.deepEqual(groups.map((group) => group.date), ['2026-01-01', '2025-12-31']);
  assert.deepEqual(groups[0]?.captures.map((note) => note.path), ['00-Inbox/a.md', '00-Inbox/z.md']);
  assert.deepEqual(captures.map((note) => note.path), originalPaths);
});

test('a leap-month calendar has 42 Monday-first cells and counts captures in adjacent months', () => {
  const captures = [
    capture('jan.md', localTime(2024, 0, 29)),
    capture('leap-a.md', localTime(2024, 1, 29, 9)),
    capture('leap-b.md', localTime(2024, 1, 29, 18)),
    capture('march.md', localTime(2024, 2, 1))
  ];
  const cells = captureCalendar(captures, 2024, 1, localTime(2024, 1, 29));
  assert.equal(cells.length, 42);
  assert.equal(cells[0]?.date, '2024-01-29');
  assert.equal(cells.at(-1)?.date, '2024-03-10');
  assert.equal(cells.filter((cell) => cell.inMonth).length, 29);
  assert.deepEqual(cells.find((cell) => cell.date === '2024-02-29'), { date: '2024-02-29', day: 29, inMonth: true, today: true, count: 2 });
  assert.equal(cells[0]?.inMonth, false);
  assert.equal(cells[0]?.count, 1);
  assert.equal(cells.find((cell) => cell.date === '2024-03-01')?.count, 1);
  assert.equal(cells.filter((cell) => cell.today).length, 1);
});

test('Monday-start months do not add an unnecessary leading week and year navigation is reversible', () => {
  const june = captureCalendar([], 2026, 5, localTime(2026, 5, 10));
  assert.equal(june[0]?.date, '2026-06-01');
  assert.equal(june.filter((cell) => cell.inMonth).length, 30);
  assert.deepEqual(shiftCaptureMonth(2026, 0, -1), { year: 2025, monthIndex: 11 });
  assert.deepEqual(shiftCaptureMonth(2025, 11, 1), { year: 2026, monthIndex: 0 });
  assert.deepEqual(shiftCaptureMonth(2026, 0, 25), { year: 2028, monthIndex: 1 });
  assert.throws(() => captureCalendar([], 2026, 12), RangeError);
  assert.throws(() => shiftCaptureMonth(2026, 0, 0.5), RangeError);
});

function isoWithOffset(timestamp: number, offsetMinutes: number): string {
  const wallTime = new Date(timestamp + offsetMinutes * 60_000).toISOString().slice(0, 19);
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${wallTime}${offsetMinutes < 0 ? '-' : '+'}${hours}:${minutes}`;
}

test('offset timestamps sharing an ISO date group into their actual local days across midnight', () => {
  const beforeMidnight = localTime(2026, 10, 7, 23, 45);
  const afterMidnight = localTime(2026, 10, 8, 0, 15);
  const beforeSource = isoWithOffset(beforeMidnight, -14 * 60);
  const afterSource = isoWithOffset(afterMidnight, -14 * 60);
  assert.equal(beforeSource.slice(0, 10), afterSource.slice(0, 10));
  const before = captureCreated(beforeSource, 0, 0);
  const after = captureCreated(afterSource, 0, 0);
  assert.equal(before, beforeMidnight);
  assert.equal(after, afterMidnight);
  assert.deepEqual(groupCapturesByDay([capture('before.md', before), capture('after.md', after)]).map((group) => group.date), ['2026-11-08', '2026-11-07']);
});

test('March and November calendars retain continuous local dates across daylight-saving boundaries', () => {
  for (const monthIndex of [2, 10]) {
    const today = localTime(2026, monthIndex, monthIndex === 2 ? 8 : 1, 0, 15);
    const blank = captureCalendar([], 2026, monthIndex, today);
    const first = new Date(2026, monthIndex, 1, 12);
    first.setDate(1 - ((first.getDay() + 6) % 7));
    const captures: CaptureSummary[] = [];
    for (let index = 0; index < 42; index++) {
      const date = new Date(first);
      date.setDate(first.getDate() + index);
      date.setHours(0, 30, 0, 0);
      captures.push(capture(`morning-${index}.md`, date.getTime()));
      date.setHours(23, 30, 0, 0);
      captures.push(capture(`night-${index}.md`, date.getTime()));
    }
    const cells = captureCalendar(captures, 2026, monthIndex, today);
    assert.equal(new Set(cells.map((cell) => cell.date)).size, 42);
    assert.equal(cells.filter((cell) => cell.today).length, 1);
    assert.equal(cells.filter((cell) => cell.inMonth).length, monthIndex === 2 ? 31 : 30);
    for (const [index, cell] of cells.entries()) {
      const expected = new Date(first);
      expected.setDate(first.getDate() + index);
      assert.equal(cell.date, captureDay(expected.getTime()));
      assert.equal(cell.date, blank[index]?.date);
      assert.equal(cell.count, 2);
    }
  }
});
