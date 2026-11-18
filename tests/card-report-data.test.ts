import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCardReport, buildWorkbenchCards, cardCreationTrend, filterCardReport, reportCaptureCoverage, reportDrafts, reportMaterials } from '../src/card-report-data';
import type { CardRelationship, KnowledgeRecord } from '../src/knowledge-index';
import type { ReportRecord, ReportSnapshot } from '../src/report-contract';
import { aggregateReport } from '../src/report-data';
import { DEFAULT_SETTINGS } from '../src/types';

const NOW = new Date(2026, 10, 18, 12).getTime();
const BASE = new Date(2026, 10, 15, 12).getTime();

function record(path: string, frontmatter: Record<string, unknown> = {}, knowledge?: Partial<KnowledgeRecord>): ReportRecord {
  return {
    path, name: path.split('/').at(-1)!.slice(0, -3), created: BASE, modified: NOW, frontmatter,
    knowledge: knowledge ? { body: [], sources: [], legacySources: [], materials: [], parent: [], captureResults: [], ...knowledge } : undefined
  };
}

function link(path: string | null, details: Partial<CardRelationship> = {}): CardRelationship {
  return { path, anchor: '', raw: path ?? '[[Missing]]', ...details };
}

test('card period counts and every inclusive chart bin match the same title/path-searchable list', () => {
  const records = [
    record('Cards/Recent.md', { tangrow_kind: 'card', created: '2026-11-18', tangrow_stage: 'evergreen', tangrow_reviewed_at: '2026-10-19' }),
    record('Cards/A.md', { tangrow_kind: 'card' }),
    record('Elsewhere/B.md', { tangrow_kind: 'card', created: '2026-11-15', tangrow_stage: 'strange', tangrow_reviewed_at: '2026-11-20' }),
    record('Cards/Invalid.md', { tangrow_kind: 'card', created: '2026-02-30', tangrow_stage: 'seed' }),
    record('Cards/Future.md', { tangrow_kind: 'card', created: '2026-11-19', tangrow_stage: 'growing' }),
    record('Cards/Older.md', { tangrow_kind: 'card', created: '2026-10-19', tangrow_reviewed_at: '2026-10-20' }),
    record('Cards/NotACard.md', { tangrow_kind: 'note' })
  ];
  const index = buildCardReport(records, records, false, NOW);

  assert.equal(index.counts.all, 6);
  assert.equal(index.counts.week, 3);
  assert.equal(index.counts.unknownCreated, 2);
  assert.equal(index.counts.stale, 1);
  assert.equal(index.counts.recentReview, 1);
  assert.equal(index.counts.invalidReview, 1);
  assert.deepEqual(index.rows.slice(0, 4).map(({ note, creationBasis }) => [note.path, creationBasis]), [
    ['Cards/Recent.md', 'property'], ['Cards/A.md', 'file'], ['Elsewhere/B.md', 'property'], ['Cards/Older.md', 'property']
  ]);
  for (const range of [7, 30, 90, 180, 365] as const) {
    const trend = cardCreationTrend(index, range);
    assert.equal(trend.last, '2026-11-18');
    assert.equal(trend.count, filterCardReport(index, 'period', trend).length);
    assert.equal(trend.unknown, 2);
    assert.equal(trend.bins.length, Math.ceil(range / trend.step));
    assert.ok(trend.bins.some((bin) => bin.count === 0));
    for (const bin of trend.bins) assert.equal(bin.count, filterCardReport(index, 'period', bin).length);
  }
  assert.deepEqual(filterCardReport(index, 'period', { first: '2026-11-15', last: '2026-11-15' }, 'ELSEWHERE').map(({ note }) => note.path), ['Elsewhere/B.md']);
  assert.equal(filterCardReport(index, 'unused').length, 0);
});

test('card metrics scope both endpoints, dedupe directed pairs and exclude properties from body citations', () => {
  const a = 'Cards/A.md';
  const b = 'Cards/B.md';
  const c = 'Cards/C.md';
  const d = 'Cards/D.md';
  const outside = 'Private/Outside.md';
  const records = [
    record(a, { tangrow_kind: 'card' }, { body: [link(a), link(b), link(b, { anchor: '#Example', reason: 'A reason' }), link(outside), link(null)] }),
    record(b, { tangrow_kind: 'card' }, { body: [link(a)], sources: [link('40-Resources/Source.md'), link(null)], parent: [link(a)] }),
    record(c, { tangrow_kind: 'card' }), record(d, { tangrow_kind: 'card' }),
    record(outside, { tangrow_kind: 'card' }, { body: [link(c)] }),
    record('Private/Hub.md', { tangrow_kind: 'hub' }, { body: [link(d)] }),
    record('Cards/Hub.md', { tangrow_kind: 'hub' }, { body: [link(b), link(b, { anchor: '#Example' })] }),
    record('Draft.md', { tangrow_kind: 'draft' }, { body: [link(a)], materials: [link(a), link(c), link(c, { anchor: '#Part' })] }),
    record('Private/Other draft.md', { tangrow_kind: 'draft' }, { body: [link(c)] }),
    record('40-Resources/Source.md', { tangrow_kind: 'literature' })
  ];
  const settings = { ...DEFAULT_SETTINGS, reportExcludedFolders: ['Private'] };
  const workspace = buildWorkbenchCards(records, settings, true, NOW);
  const report = workspace.report;

  assert.equal(report.counts.all, 4);
  assert.equal(report.edges, 2);
  assert.equal(report.reasonedEdges, 1);
  assert.equal(report.counts.inHub, 1);
  assert.equal(report.counts.sourced, 1);
  assert.equal(report.counts.isolated, 2);
  assert.equal(report.counts.cited, 1);
  assert.equal(report.counts.candidate, 1);
  assert.equal(report.counts.unused, 2);
  assert.deepEqual(filterCardReport(report, 'candidate').map(({ note }) => note.path), [c]);
  assert.deepEqual(filterCardReport(report, 'candidate')[0]?.citations.map(({ path }) => path), ['Private/Other draft.md']);
  assert.equal(filterCardReport(report, 'reasoned')[0]?.outgoing.some((edge) => edge.path === null), true);
  assert.equal(workspace.workspace.counts.all, 5);
  assert.equal(workspace.workspace.counts.inHub, 2);
  assert.equal(workspace.workspace.counts.cited, 2);
});

test('material, draft and capture details derive from scoped files and keep unknown-index counts pending', () => {
  const source = '40-Resources/Source.md';
  const note = '00-Inbox/Result.md';
  const records = [
    record(source, { tangrow_kind: 'literature' }),
    record(note, { tangrow_kind: 'note' }),
    record('40-Resources/Unrelated.md'),
    record('40-Resources/Manuscript.md', { tangrow_kind: 'draft', tangrow_status: 'draft' }, { materials: [link(source)] }),
    record('Cards/Idea.md', { tangrow_kind: 'card' }, { sources: [link(source), link(source, { anchor: '#Part' })] }),
    record('Capture A.md', { tangrow_kind: 'capture' }, { captureResults: [link(note)] }),
    record('Capture B.md', { tangrow_kind: 'capture', tangrow_processed_at: '2026-11-14' }, { captureResults: [link(null)] }),
    record('Older capture.md', { tangrow_kind: 'capture', created: '2026-04-01' }, { captureResults: [link(note)] })
  ];
  const snapshot = (linksReady: boolean): ReportSnapshot => ({
    records, data: aggregateReport(records, DEFAULT_SETTINGS, NOW), generatedAt: NOW, quality: { linksReady, unreadable: 0 },
    activity: { minutes: 0, totalMs: 0, days: [], hours: [], startedAt: NOW }
  });
  const covered = reportCaptureCoverage(snapshot(true));
  assert.equal(covered.captures, 2);
  assert.equal(covered.withResult, 1);
  assert.deepEqual(covered.rows.map(({ note: row, hasResult }) => [row.path, hasResult]), [['Capture A.md', true], ['Capture B.md', false]]);
  assert.equal(reportCaptureCoverage(snapshot(false)).withResult, null);
  assert.equal(reportDrafts(snapshot(true))[0]?.stage, 'drafting');
  assert.equal(reportDrafts(snapshot(true))[0]?.candidates.length, 1);
  assert.equal(reportDrafts(snapshot(true))[0]?.citations.length, 0);
  const materials = reportMaterials(snapshot(true), DEFAULT_SETTINGS);
  assert.equal(materials.rows.length, 2);
  assert.equal(materials.covered, 1);
  assert.equal(materials.rows.find(({ note: row }) => row.path === source)?.cards, 1);
  assert.equal(reportMaterials(snapshot(false), DEFAULT_SETTINGS).covered, null);
});

test('legacy capture receipts need a live task or a processed note with matching provenance', () => {
  const tasks = 'Overview.md';
  const createdNote = 'Converted.md';
  const notes = [
    record('Task capture.md', { tangrow_kind: 'capture' }, { legacyCaptureResults: [link(tasks)] }),
    record('Deleted task capture.md', { tangrow_kind: 'capture' }, { legacyCaptureResults: [link(tasks)] }),
    record('Note capture.md', { tangrow_kind: 'capture' }, { legacyCaptureResults: [link(createdNote)] }),
    record('Unverified capture.md', { tangrow_kind: 'capture' }, { legacyCaptureResults: [link('Still exists.md')] }),
    { ...record(tasks), captureTaskSources: ['Task capture.md'] },
    record(createdNote, { tangrow_kind: 'note', tangrow_capture_action_id: 'saved-id' }, { sources: [link('Note capture.md')] }),
    record('Still exists.md', { tangrow_kind: 'note' })
  ];
  const snapshot: ReportSnapshot = {
    records: notes, data: aggregateReport(notes, DEFAULT_SETTINGS, NOW), generatedAt: NOW, quality: { linksReady: true, unreadable: 0 },
    activity: { minutes: 0, totalMs: 0, days: [], hours: [], startedAt: NOW }
  };
  const coverage = reportCaptureCoverage(snapshot);
  assert.equal(coverage.captures, 4);
  assert.equal(coverage.withResult, 2);
  assert.deepEqual(coverage.rows.filter(({ hasResult }) => hasResult).map(({ note }) => note.path), ['Task capture.md', 'Note capture.md']);
});
