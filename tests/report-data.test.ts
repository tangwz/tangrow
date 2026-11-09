import assert from 'node:assert/strict';
import test from 'node:test';
import { readSettings } from '../src/model';
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

test('persisted support folders that equal or contain projects do not hide user notes or tasks', () => {
  const rows = [
    record('Content/Projects/Alpha.md', {}, [' ', '/', 'x', '-']),
    record('Content/Projects/Beta.md'),
    record('Content/Other/Readme.md', {}, [' ']),
    record('90-Archive/Old.md', {}, [' '])
  ];
  for (const supportFolder of ['Content/Projects', 'Content']) {
    const settings = readSettings({ ...DEFAULT_SETTINGS, supportFolder, projectFolder: 'Content/Projects' });
    const report = aggregateReport(rows, settings, NOW);
    assert.equal(report.counts.notes, 4);
    assert.equal(report.counts.projectNotes, 2);
    assert.equal(report.counts.openTasks, 3);
    assert.equal(report.counts.completedTasks, 1);
    assert.equal(report.counts.cancelledTasks, 1);
    assert.deepEqual(new Set(report.recent.map((row) => row.path)), new Set(rows.map((row) => row.path)));
    assert.equal(report.days.reduce((sum, day) => sum + day.count, 0), 4);
    assert.equal(settings.supportFolder, supportFolder);
  }
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
  const report = aggregateReport([...rows, rows[0]!], { ...DEFAULT_SETTINGS, habits: [{ id: 'read', name: 'Read' }, { id: 'walk', name: 'Walk' }] }, NOW);
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


test('project and area entity totals count immediate folders including empty folders plus root notes', () => {
  const rows = [
    record('20-Project/Alpha/README.md', { status: 'done' }),
    record('20-Project/Alpha/Log.md', { status: 'active' }),
    record('20-Project/Alpha/Deep/Topic.md'),
    record('20-Project/Beta/Note.md', { status: 'done' }),
    record('20-Project/Standalone.md', { tangrow_status: 'active' }),
    record('30-Area/Health/Overview.md', { tangrow_status: 'completed' })
  ];
  const report = aggregateReport(rows, DEFAULT_SETTINGS, NOW, { folders: ['20-Project', '20-Project/Alpha', '20-Project/Alpha/Deep', '20-Project/Beta', '20-Project/Empty', '30-Area/Health', '30-Area/Empty'] });
  assert.equal(report.counts.projectNotes, 5);
  assert.equal(report.counts.projects, 4);
  assert.equal(report.counts.areas, 2);
  assert.equal(report.projects.find((entity) => entity.name === 'Alpha')?.status, 'done');
  assert.equal(report.projects.find((entity) => entity.name === 'Beta')?.status, 'unknown');
  assert.equal(report.projects.find((entity) => entity.name === 'Empty')?.created, null);
  assert.equal(report.projects.find((entity) => entity.name === 'Empty')?.notePath, null);
  assert.equal(report.projects.find((entity) => entity.name === 'Alpha')?.noteCount, 3);
  assert.equal(report.completion.projects.denominator, 2);
  assert.equal(report.completion.projects.rate, 0.5);
  assert.equal(report.completion.projects.unknown, 2);
  assert.equal(report.completion.areas.rate, 1);
});

test('clip detection distinguishes external sources and clip tags from internal related-note links', () => {
  const rows: ReportRecord[] = [
    record('00-Inbox/URL.md', { source: 'https://example.com', status: 'done' }),
    record('00-Inbox/HTTP.md', { source: 'http://example.com', tangrow_status: 'open' }),
    record('00-Inbox/Tagged.md', { tags: ['webclip'], status: 'archived' }),
    { ...record('00-Inbox/Body tag.md'), tags: ['#clip/article'] },
    record('00-Inbox/Explicit.md', { tangrow_kind: 'clip', status: 'unknown-custom' }),
    record('00-Inbox/Related.md', { tangrow_source: '[[URL]]' }),
    record('00-Inbox/Internal source.md', { source: '[[Related]]' }),
    record('00-Inbox/FTP.md', { source: 'ftp://example.com' })
  ];
  const report = aggregateReport(rows, DEFAULT_SETTINGS, NOW);
  assert.equal(report.counts.clips, 5);
  assert.equal(report.completion.clips.open, 1);
  assert.equal(report.completion.clips.done, 1);
  assert.equal(report.completion.clips.archived, 1);
  assert.equal(report.completion.clips.unknown, 2);
  assert.equal(report.completion.clips.rate, 0.5);
  assert.ok(!report.clips.some((clip) => clip.path.endsWith('/Related.md')));
});

test('task totals include unknown and cancelled checkboxes while completion excludes them', () => {
  const source = record('10-Life(Meta)/Tasks.md');
  source.taskItems = [' ', '/', 'x', 'X', '-', '?'].map((status, index) => ({ path: source.path, name: source.name, line: index * 2 + 4, text: `Task ${index}`, status }));
  const report = aggregateReport([source], DEFAULT_SETTINGS, NOW);
  assert.equal(report.counts.tasks, 6);
  assert.equal(report.counts.openTasks, 2);
  assert.equal(report.counts.completedTasks, 2);
  assert.equal(report.counts.cancelledTasks, 1);
  assert.deepEqual(report.completion.tasks, { open: 2, done: 2, cancelled: 1, archived: 0, unknown: 1, total: 6, denominator: 4, rate: 0.5 });
  assert.equal(report.taskItems[0]?.line, 4);
  assert.equal(report.taskItems[5]?.line, 14);
  assert.equal(aggregateReport([], DEFAULT_SETTINGS, NOW).completion.tasks.rate, null);
});

test('word and character totals use supplied body counts and honor excluded folder boundaries', () => {
  const rows = [
    { ...record('00-Inbox/Counted.md'), wordCount: 12, characterCount: 42 },
    { ...record('40-Resources/Private/Excluded.md'), wordCount: 100, characterCount: 1000 },
    { ...record('40-Resources/Private-Other/Counted.md'), wordCount: 5, characterCount: 10 },
    { ...record(`${DEFAULT_SETTINGS.supportFolder}/Record.md`), wordCount: 100, characterCount: 1000 },
    { ...record('00-Inbox/Invalid.md'), wordCount: NaN, characterCount: -2 }
  ];
  const settings = { ...DEFAULT_SETTINGS, reportExcludedFolders: ['40-Resources/Private'] };
  const report = aggregateReport(rows, settings, NOW);
  assert.equal(report.counts.words, 17);
  assert.equal(report.counts.characters, 52);
  assert.equal(report.counts.notes, 3);
  assert.ok(report.notes.some((note) => note.path.includes('Private-Other')));
});

test('selected-range trends and 90-day gains use valid source creation dates with a capture metadata exception', () => {
  const yesterday = new Date(2026, 10, 7, 12).getTime();
  const capture = { ...record('00-Inbox/Capture.md', { tangrow_kind: 'capture', created: new Date(2026, 10, 8, 8).toISOString() }), created: yesterday };
  const taskSource = { ...record('10-Life(Meta)/Tasks.md', {}, [' ', 'x', '-']), created: yesterday };
  const old = { ...record('00-Inbox/Old.md'), created: new Date(2026, 6, 1, 12).getTime() };
  const future = { ...record('00-Inbox/Future clip.md', { source: 'https://example.com' }), created: NOW + 1000 };
  const report = aggregateReport([capture, taskSource, old, future], DEFAULT_SETTINGS, NOW, { range: 7 });
  assert.equal(report.trends.length, 7);
  assert.equal(report.days.length, 7);
  assert.equal(report.trends.find((day) => day.day === '2026-11-07')?.notes, 2);
  assert.equal(report.trends.find((day) => day.day === '2026-11-07')?.tasks, 3);
  assert.equal(report.trends.find((day) => day.day === TODAY)?.captures, 1);
  assert.equal(report.gains90.notes, 2);
  assert.equal(report.gains90.captures, 1);
  assert.equal(report.gains90.clips, 0);
});

test('90-day project gains prefer canonical document creation and do not guess empty-folder dates', () => {
  const rows = [
    { ...record('20-Project/Recent/README.md'), created: new Date(2026, 10, 1, 12).getTime() },
    { ...record('20-Project/Recent/Old topic.md'), created: new Date(2024, 0, 1, 12).getTime() },
    { ...record('20-Project/Old/Topic.md'), created: new Date(2024, 0, 1, 12).getTime() },
    { ...record('20-Project/Future/README.md'), created: NOW + 1000 }
  ];
  const report = aggregateReport(rows, DEFAULT_SETTINGS, NOW, { folders: ['20-Project/Recent', '20-Project/Old', '20-Project/Future', '20-Project/Empty'] });
  assert.equal(report.counts.projects, 4);
  assert.equal(report.gains90.projects, 1);
  assert.equal(report.projects.find((entity) => entity.name === 'Recent')?.created, new Date(2026, 10, 1, 12).getTime());
  assert.equal(report.projects.find((entity) => entity.name === 'Future')?.created, null);
  assert.equal(report.projects.find((entity) => entity.name === 'Empty')?.created, null);
});

test('journal and capture streaks allow today pending and ignore weekly or future records', () => {
  const rows = [
    record('10-Life(Meta)/13-Journal/2026/Daily/2026-11-06.md'),
    record('10-Life(Meta)/13-Journal/2026/Daily/2026-11-07.md'),
    record('10-Life(Meta)/13-Journal/Weekly/2026-11-08.md', { journal: 'Weekly', 'journal-date': TODAY }),
    record('00-Inbox/2026-11-08.md'),
    record('00-Inbox/Explicit journal.md', { journal: 'Daily', 'journal-date': '2026-11-09' }),
    record('00-Inbox/Capture 1.md', { tangrow_kind: 'capture', created: '2026-11-06' }),
    record('00-Inbox/Capture 2.md', { tangrow_kind: 'capture', created: '2026-11-07' })
  ];
  const report = aggregateReport(rows, DEFAULT_SETTINGS, NOW);
  assert.equal(report.streaks.journal.current, 2);
  assert.equal(report.streaks.journal.longest, 2);
  assert.equal(report.streaks.captures.current, 2);
  assert.equal(report.streaks.journal.days.at(-1)?.count, 0);
});

test('habit completion uses only active definitions and deduplicates each day and habit', () => {
  const settings = { ...DEFAULT_SETTINGS, habits: [{ id: 'read', name: 'Read' }, { id: 'walk', name: 'Walk' }] };
  const rows = [
    record(`${settings.supportFolder}/Habits/read.md`, { tangrow_kind: 'habit', tangrow_habit_id: 'read', tangrow_day: TODAY }),
    record('00-Inbox/Duplicate.md', { tangrow_kind: 'habit', tangrow_habit_id: 'read', tangrow_day: TODAY }),
    record(`${settings.supportFolder}/Habits/archived.md`, { tangrow_kind: 'habit', tangrow_habit_id: 'archived', tangrow_day: TODAY }),
    record(`${settings.supportFolder}/Habits/yesterday.md`, { tangrow_kind: 'habit', tangrow_habit_id: 'walk', tangrow_day: '2026-11-07' }),
    record(`${settings.supportFolder}/Habits/future.md`, { tangrow_kind: 'habit', tangrow_habit_id: 'walk', tangrow_day: '2026-11-09' })
  ];
  const report = aggregateReport(rows, settings, NOW);
  assert.equal(report.counts.habitCheckinsToday, 1);
  assert.equal(report.habits.todayCompleted, 1);
  assert.equal(report.habits.target, 2);
  assert.equal(report.habits.days.length, 14);
  assert.equal(report.habits.days.at(-1)?.completed, 1);
  assert.equal(report.habits.days.at(-2)?.completed, 1);
  assert.equal(aggregateReport(rows, DEFAULT_SETTINGS, NOW).habits.todayCompleted, 0);
});

test('orphan notes require no resolved incoming or outgoing candidate edges', () => {
  const rows = [
    { ...record('00-Inbox/A.md'), links: ['00-Inbox/B.md'] },
    record('00-Inbox/B.md'),
    { ...record('00-Inbox/Self.md'), links: ['00-Inbox/Self.md'] },
    { ...record('00-Inbox/Archive link.md'), links: ['90-Archive/Old.md'] },
    { ...record('90-Archive/Old.md'), links: ['00-Inbox/Archive link.md'] },
    { ...record(`${DEFAULT_SETTINGS.supportFolder}/README.md`), links: ['00-Inbox/Self.md'] },
    { ...record('00-Inbox/Missing link.md'), links: ['Missing.md'] }
  ];
  const report = aggregateReport(rows, DEFAULT_SETTINGS, NOW);
  assert.equal(report.counts.orphans, 3);
  assert.deepEqual(report.orphanNotes.map((note) => note.path), ['00-Inbox/Archive link.md', '00-Inbox/Missing link.md', '00-Inbox/Self.md']);
});
