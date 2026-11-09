import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalEntityStatus, collectReportEntities, findOrphanNotes, isClipRecord, normalizeReportStatus, reportCompletion, reportJournalDay, reportRecordStatus, reportStreak, sampleReportNotes } from '../src/report-metrics';
import type { ReportRecord } from '../src/report-contract';
import { DEFAULT_SETTINGS } from '../src/types';

const NOW = new Date(2026, 10, 8, 12).getTime();
function record(path: string, fields: Record<string, unknown> = {}): ReportRecord {
  return { path, name: path.split('/').at(-1)!.replace(/\.md$/, ''), frontmatter: fields, created: NOW - 1000, modified: NOW - 1000 };
}

test('status normalization uses explicit aliases and gives namespaced status precedence', () => {
  assert.equal(normalizeReportStatus(' ACTIVE '), 'open');
  assert.equal(normalizeReportStatus('completed'), 'done');
  assert.equal(normalizeReportStatus('archived'), 'archived');
  assert.equal(normalizeReportStatus('on hold'), 'unknown');
  assert.equal(normalizeReportStatus(undefined), 'unknown');
  assert.equal(reportRecordStatus(record('A.md', { tangrow_status: 'done', status: 'active' })), 'done');
  assert.equal(reportRecordStatus(record('A.md', { tangrow_status: 'custom', status: 'done' })), 'unknown');
});

test('entity status comes only from canonical immediate documents and conflicting statuses remain unknown', () => {
  const folder = '20-Project/Alpha';
  assert.equal(canonicalEntityStatus([record(`${folder}/Log.md`, { status: 'done' })], folder), 'unknown');
  assert.equal(canonicalEntityStatus([record(`${folder}/README.md`, { status: 'done' }), record(`${folder}/Sub/README.md`, { status: 'active' })], folder), 'done');
  assert.equal(canonicalEntityStatus([record(`${folder}/Alpha.md`, { status: 'active' }), record(`${folder}/index.md`, { status: 'done' })], folder), 'unknown');
  assert.equal(canonicalEntityStatus([record(`${folder}/README.md`), record(`${folder}/Overview.md`, { status: 'done' })], folder), 'done');
  assert.equal(canonicalEntityStatus([record(`${folder}/README.md`, { status: 'custom' }), record(`${folder}/Overview.md`, { status: 'done' })], folder), 'unknown');
});

test('entity creation and canonical open-note choice are deterministic without inventing empty-folder dates', () => {
  const rows = [record('20-Project/Alpha/README.md'), record('20-Project/Alpha/Alpha.md'), record('20-Project/Alpha/Sub/Topic.md')];
  const before = structuredClone(rows);
  const entities = collectReportEntities(rows, '20-Project', ['20-Project/Empty', '20-Project/Alpha/Sub', '20-Project-Old/Outside'], NOW);
  assert.equal(entities.length, 2);
  assert.equal(entities.find((entity) => entity.name === 'Alpha')?.notePath, '20-Project/Alpha/Alpha.md');
  assert.equal(entities.find((entity) => entity.name === 'Empty')?.created, null);
  assert.deepEqual(rows, before);
});

test('clip records require web URLs, explicit clip kinds, or clip tags', () => {
  for (const fields of [{ source: 'https://example.com/path' }, { source: ['[[Internal]]', 'http://example.com'] }, { tangrow_kind: 'clip' }, { tags: '#webclip' }]) {
    assert.equal(isClipRecord(record('Clip.md', fields)), true);
  }
  assert.equal(isClipRecord({ ...record('Clip.md'), tags: ['clip/article'] }), true);
  for (const fields of [{ tangrow_source: '[[Internal]]' }, { source: '[[Internal]]' }, { source: 'mailto:hello@example.com' }, { source: '' }, { source: 'not a url' }]) {
    assert.equal(isClipRecord(record('Note.md', fields)), false);
  }
});

test('completion excludes archived and unknown statuses from the denominator', () => {
  const summary = reportCompletion(['open', 'done', 'archived', 'unknown']);
  assert.deepEqual(summary, { open: 1, done: 1, archived: 1, unknown: 1, cancelled: 0, total: 4, denominator: 2, rate: 0.5 });
  assert.equal(reportCompletion(['unknown', 'archived']).rate, null);
});

test('journal recognition excludes weekly and ordinary date names while honoring configured literal folders', () => {
  assert.equal(reportJournalDay(record('Anywhere/Journal.md', { journal: 'Daily', 'journal-date': '2024-02-29' }), DEFAULT_SETTINGS), '2024-02-29');
  assert.equal(reportJournalDay(record('Anywhere/Journal.md', { journal: 'Weekly', 'journal-date': '2024-02-29' }), DEFAULT_SETTINGS), null);
  assert.equal(reportJournalDay(record('00-Inbox/2026-11-08.md'), DEFAULT_SETTINGS), null);
  assert.equal(reportJournalDay(record('10-Life(Meta)/13-Journal-Old/2026/Daily/2026-11-08.md'), DEFAULT_SETTINGS), null);
  assert.equal(reportJournalDay(record('10-Life(Meta)/13-Journal/2026/Daily/2026-11-08.md'), DEFAULT_SETTINGS), '2026-11-08');
  assert.equal(reportJournalDay(record('10-Life(Meta)/13-Journal/2025/Daily/2026-11-08.md'), DEFAULT_SETTINGS), null);
  assert.equal(reportJournalDay(record('10-Life(Meta)/13-Journal/2025/Daily/2025-02-29.md'), DEFAULT_SETTINGS), null);
  assert.equal(reportJournalDay(record('10-Life(Meta)/13-Journal/2026/Weekly/2026-11-08.md'), DEFAULT_SETTINGS), null);
});

test('streaks allow today pending but stop at the first gap and ignore future dates', () => {
  const dayCounts = new Map([['2026-11-04', 1], ['2026-11-05', 2], ['2026-11-06', 1], ['2026-11-07', 1], ['2026-11-09', 1]]);
  const streak = reportStreak(dayCounts, NOW);
  assert.equal(streak.current, 4);
  assert.equal(streak.longest, 4);
  assert.equal(streak.days.length, 14);
  assert.equal(streak.days.at(-1)?.count, 0);
  assert.equal(reportStreak(new Map([['2026-11-04', 1], ['2026-11-08', 1]]), NOW).current, 1);
  assert.equal(reportStreak(new Map([['2026-11-04', 1]]), NOW).current, 0);
  assert.equal(reportStreak(new Map([['2026-02-30', 1]]), NOW).longest, 0);
});

test('orphan detection ignores self-links and edges outside the eligible graph', () => {
  const rows = [
    { ...record('A.md'), links: ['B.md'] }, record('B.md'),
    { ...record('C.md'), links: ['C.md', 'missing.md'] },
    { ...record('D.md'), links: ['90-Archive/Old.md', `${DEFAULT_SETTINGS.supportFolder}/README.md`] },
    { ...record('90-Archive/Old.md'), links: ['C.md'] },
    record(`${DEFAULT_SETTINGS.supportFolder}/README.md`)
  ];
  assert.deepEqual(findOrphanNotes(rows, DEFAULT_SETTINGS).map((note) => note.path), ['C.md', 'D.md']);
  const excluded = { ...DEFAULT_SETTINGS, reportExcludedFolders: ['B.md'] };
  assert.ok(findOrphanNotes(rows, excluded).some((note) => note.path === 'A.md'));
});

test('random note samples are unique, at most ten, deterministic under injected randomness and immutable', () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ path: `Note ${index}.md` }));
  const before = structuredClone(rows);
  assert.deepEqual(sampleReportNotes([...rows, rows[0]!], 3, () => 0), rows.slice(0, 3));
  assert.equal(sampleReportNotes(rows, 100, () => 0.999).length, 10);
  assert.equal(new Set(sampleReportNotes([...rows, rows[0]!], 10, () => 0).map((note) => note.path)).size, 10);
  assert.deepEqual(sampleReportNotes([], 10, () => 0), []);
  assert.deepEqual(sampleReportNotes(rows, 0, () => 0), []);
  assert.throws(() => sampleReportNotes(rows, 1, () => 1), RangeError);
  assert.deepEqual(rows, before);
});
