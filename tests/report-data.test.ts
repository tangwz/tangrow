import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateReport, type ReportRecord } from '../src/report-data';
import { DEFAULT_SETTINGS } from '../src/types';

const NOW = new Date(2026, 10, 8, 12).getTime();
const TODAY = '2026-11-08';

function record(path: string, fields: Record<string, unknown> = {}, tasks: string[] = []): ReportRecord {
  return { path, name: path.split('/').at(-1)!, created: NOW - 1000, modified: NOW - 1000, frontmatter: fields, tasks };
}

test('the report counts note roles without imposing metadata or crossing folder boundaries', () => {
  const rows = [
    record('20-Project/A/Overview.md', { source: 'https://example.com', tangrow_pin: true }),
    record('20-Project-Old/Unrelated.md'),
    record('30-Area/Writing.md', { tangrow_source: '[[Other note]]' }),
    record('40-Resources/Reference.md', { source: '' }),
    record('00-Inbox/Capture.md', { tangrow_kind: 'capture' }),
    record('00-Inbox/Draft.md', { tangrow_kind: 'draft' }),
    record(`${DEFAULT_SETTINGS.supportFolder}/README.md`, { tangrow_pin: true }),
    record(`${DEFAULT_SETTINGS.supportFolder}-Other/Unrelated.md`)
  ];
  const report = aggregateReport(rows, DEFAULT_SETTINGS, NOW);
  assert.equal(report.counts.notes, 7);
  assert.equal(report.counts.projectNotes, 1);
  assert.equal(report.counts.areaNotes, 1);
  assert.equal(report.counts.resourceNotes, 1);
  assert.equal(report.counts.sourceNotes, 2);
  assert.equal(report.counts.pins, 2);
  assert.equal(report.counts.captures, 1);
  assert.equal(report.counts.drafts, 1);
  assert.equal(report.recent.some((row) => row.path === `${DEFAULT_SETTINGS.supportFolder}/README.md`), false);
});

test('explicit pins include support records without inflating note totals or counting duplicate paths', () => {
  const note = record('00-Inbox/Pinned.md', { tangrow_pin: true });
  const support = record(`${DEFAULT_SETTINGS.supportFolder}/README.md`, { tangrow_pin: true });
  const rows = [note, support, note, support];
  const report = aggregateReport(rows, DEFAULT_SETTINGS, NOW);
  assert.equal(report.counts.notes, 1);
  assert.equal(report.counts.pins, 2);

  const unpinnedSupport = [...rows, record(support.path, { tangrow_pin: false })];
  const afterSupportUnpin = aggregateReport(unpinnedSupport, DEFAULT_SETTINGS, NOW);
  assert.equal(afterSupportUnpin.counts.notes, 1);
  assert.equal(afterSupportUnpin.counts.pins, 1);

  const afterBothUnpinned = aggregateReport([...unpinnedSupport, record(note.path, {})], DEFAULT_SETTINGS, NOW);
  assert.equal(afterBothUnpinned.counts.notes, 1);
  assert.equal(afterBothUnpinned.counts.pins, 0);
});

test('task state counts include in-progress work and exclude support or archived tasks', () => {
  const report = aggregateReport([
    record('10-Life(Meta)/Tasks.md', {}, [' ', '/', 'x', 'X', '-', '?']),
    record('90-Archive/Old.md', {}, [' ', 'x', '-']),
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Task.md`, {}, [' ', '/', 'x'])
  ], DEFAULT_SETTINGS, NOW);
  assert.equal(report.counts.notes, 2);
  assert.equal(report.counts.openTasks, 2);
  assert.equal(report.counts.completedTasks, 2);
  assert.equal(report.counts.cancelledTasks, 1);
});

test('focus and habit records are validated and counted once by stable identity', () => {
  const rows = [
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Focus/one.md`, { tangrow_kind: 'focus', tangrow_session_id: 'one', tangrow_minutes: 2.33 }),
    record('00-Inbox/Imported focus.md', { tangrow_kind: 'focus', tangrow_session_id: 'one', tangrow_minutes: 2.33 }),
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Focus/two.md`, { tangrow_kind: 'focus', tangrow_minutes: 4.2 }),
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Focus/invalid.md`, { tangrow_kind: 'focus', tangrow_minutes: '25' }),
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Focus/negative.md`, { tangrow_kind: 'focus', tangrow_minutes: -1 }),
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Focus/infinite.md`, { tangrow_kind: 'focus', tangrow_minutes: Infinity }),
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Habits/one.md`, { tangrow_kind: 'habit', tangrow_habit_id: 'read', tangrow_day: TODAY }),
    record('00-Inbox/Imported habit.md', { tangrow_kind: 'habit', tangrow_habit_id: 'read', tangrow_day: TODAY }),
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Habits/old.md`, { tangrow_kind: 'habit', tangrow_habit_id: 'read', tangrow_day: '2026-11-07' }),
    record(`${DEFAULT_SETTINGS.supportFolder}/Records/Habits/two.md`, { tangrow_kind: 'habit', tangrow_habit_id: 'walk', tangrow_day: TODAY })
  ];
  const report = aggregateReport([...rows, rows[0]!], DEFAULT_SETTINGS, NOW);
  assert.equal(report.counts.focusMinutes, 6.53);
  assert.equal(report.counts.habitCheckinsToday, 2);
  assert.equal(report.counts.notes, 2);
});

test('the creation timeline uses local calendar days and rejects future or out-of-window dates', () => {
  const rows = [
    { ...record('00-Inbox/First day.md'), created: new Date(2026, 9, 10, 0).getTime() },
    { ...record('00-Inbox/Before window.md'), created: new Date(2026, 9, 9, 23, 59).getTime() },
    { ...record('00-Inbox/Today.md'), created: new Date(2026, 10, 8, 0).getTime() },
    { ...record('00-Inbox/Future.md'), created: NOW + 1000 },
    { ...record('00-Inbox/Invalid.md'), created: NaN },
    record(`${DEFAULT_SETTINGS.supportFolder}/README.md`)
  ];
  const report = aggregateReport(rows, DEFAULT_SETTINGS, NOW);
  assert.equal(report.days.length, 30);
  assert.equal(report.days[0]?.day, '2026-10-10');
  assert.equal(report.days.at(-1)?.day, TODAY);
  assert.equal(report.days[0]?.count, 1);
  assert.equal(report.days.at(-1)?.count, 1);
  assert.equal(report.days.reduce((sum, day) => sum + day.count, 0), 2);
});

test('recent records are bounded, deterministic and do not mutate input order or values', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ ...record(`00-Inbox/Note ${index}.md`), modified: NOW - index }));
  rows.reverse();
  const before = structuredClone(rows);
  const report = aggregateReport(rows, DEFAULT_SETTINGS, NOW);
  assert.equal(report.recent.length, 8);
  assert.equal(report.recent[0]?.name, 'Note 0.md');
  assert.deepEqual(rows, before);
  assert.throws(() => aggregateReport(rows, DEFAULT_SETTINGS, NaN), RangeError);
});
