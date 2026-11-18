import { parseNoteTimestamp } from './capture-data';
import { hasValidSupportFolder } from './folders';
import { dedupeKnowledgeLinks, type CardRelationship } from './knowledge-index';
import { dayKey, inFolder, recentDays } from './model';
import type { ReportRange, ReportRecord, ReportSnapshot } from './report-contract';
import { reportPathIncluded, reportTrendDay } from './report-data';
import { isClipRecord, reportJournalDay } from './report-metrics';
import type { Settings } from './types';

export type { CardRelationship } from './knowledge-index';

export type CardStage = 'seed' | 'growing' | 'evergreen' | 'unset' | 'unknown';
type CardReview = 'recentReview' | 'stale' | 'noReview' | 'invalidReview';
const RELATION_FILTERS = ['isolated', 'inHub', 'reasoned', 'sourced', 'cited', 'candidate', 'unused'] as const;
type RelationFilter = typeof RELATION_FILTERS[number];
type CardGroup = 'all' | 'week' | 'unknownCreated' | CardStage | CardReview | RelationFilter;
export type CardFilter = CardGroup | 'period';
export interface CardDateRange { first: string; last: string }

export const CARD_RELATION_FILTERS: ReadonlySet<CardFilter> = new Set(RELATION_FILTERS);

export interface CardReportRow {
  note: ReportRecord;
  stage: CardStage;
  created: string | null;
  creationBasis: 'property' | 'file';
  reviewed: string | null;
  groups: ReadonlySet<CardFilter>;
  sources: CardRelationship[];
  legacySources: CardRelationship[];
  parent: CardRelationship[];
  outgoing: CardRelationship[];
  incoming: CardRelationship[];
  hubs: CardRelationship[];
  candidates: CardRelationship[];
  citations: CardRelationship[];
  bodyUnreadable: boolean;
}

export interface CardReport {
  rows: CardReportRow[];
  counts: Record<CardGroup, number>;
  generatedAt: number;
  today: string;
  linksReady: boolean;
  edges: number;
  reasonedEdges: number;
}

function orderedPaths(left: ReportRecord, right: ReportRecord): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function stageOf(value: unknown): CardStage {
  if (value === undefined || value === null || value === '') return 'unset';
  return value === 'seed' || value === 'growing' || value === 'evergreen' ? value : 'unknown';
}

function propertyDay(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|[T ])/u.test(value.trim())) return null;
  const timestamp = parseNoteTimestamp(value);
  return timestamp === null ? null : dayKey(timestamp);
}

function fileDay(timestamp: number): string | null {
  return Number.isFinite(timestamp) && timestamp >= 0 && Number.isFinite(new Date(timestamp).getTime()) ? dayKey(timestamp) : null;
}

function creationOf(note: ReportRecord, today: string): Pick<CardReportRow, 'created' | 'creationBasis'> {
  const value = note.frontmatter?.created;
  const creationBasis = value === undefined || value === null ? 'file' : 'property';
  const day = creationBasis === 'file' ? fileDay(note.created) : propertyDay(value);
  return { creationBasis, created: day && day <= today ? day : null };
}

function availablePath(link: CardRelationship): link is CardRelationship & { path: string } {
  return !!link.path && !link.anchorMissing;
}

function reverseLink(note: ReportRecord, link: CardRelationship): CardRelationship {
  return { path: note.path, anchor: '', raw: note.path, relation: link.relation, reason: link.reason };
}

function retainUnresolvedOrKnownCards(link: CardRelationship, byPath: ReadonlyMap<string, ReportRecord>): boolean {
  return link.path === null || byPath.get(link.path)?.frontmatter?.tangrow_kind === 'card';
}

export function buildCardReport(records: readonly ReportRecord[], scope: readonly ReportRecord[], linksReady: boolean, now = Date.now()): CardReport {
  const today = dayKey(now);
  const reviewWindow = new Set(recentDays(30, now));
  const week = new Set(recentDays(7, now));
  const byPath = new Map(records.map((note) => [note.path, note]));
  const paths = new Set(scope.map((note) => note.path));
  const rows = new Map<string, CardReportRow & { groups: Set<CardGroup> }>();
  for (const path of paths) {
    const note = byPath.get(path);
    if (note?.frontmatter?.tangrow_kind !== 'card') continue;
    const stage = stageOf(note.frontmatter.tangrow_stage);
    const creation = creationOf(note, today);
    const reviewValue = note.frontmatter.tangrow_reviewed_at;
    const reviewDay = propertyDay(reviewValue);
    const reviewed = reviewDay && reviewDay <= today ? reviewDay : null;
    const review = reviewed ? (reviewWindow.has(reviewed) ? 'recentReview' : 'stale')
      : reviewValue === undefined || reviewValue === null || reviewValue === '' ? 'noReview' : 'invalidReview';
    const groups = new Set<CardGroup>(['all', stage, review]);
    if (!creation.created) groups.add('unknownCreated');
    else if (week.has(creation.created)) groups.add('week');
    rows.set(path, {
      note, stage, ...creation, reviewed, groups,
      sources: linksReady ? note.knowledge?.sources ?? [] : [],
      legacySources: linksReady ? note.knowledge?.legacySources ?? [] : [],
      parent: linksReady ? note.knowledge?.parent ?? [] : [],
      outgoing: [], incoming: [], hubs: [], candidates: [], citations: [], bodyUnreadable: !!note.knowledge?.unreadable
    });
  }

  if (linksReady) for (const note of byPath.values()) {
    const kind = note.frontmatter?.tangrow_kind;
    const info = note.knowledge;
    if (!info) continue;
    if (kind === 'card') {
      const outgoing = info.body.filter((link) => link.path !== note.path && retainUnresolvedOrKnownCards(link, byPath));
      const source = rows.get(note.path);
      if (source) source.outgoing = dedupeKnowledgeLinks(outgoing);
      for (const link of outgoing) if (availablePath(link)) rows.get(link.path)?.incoming.push(reverseLink(note, link));
    }
    if (kind === 'hub' || kind === 'draft') for (const link of info.body) {
      const row = availablePath(link) && rows.get(link.path);
      if (row) (kind === 'hub' ? row.hubs : row.citations).push(reverseLink(note, link));
    }
    if (kind === 'draft') for (const link of info.materials) {
      if (availablePath(link)) rows.get(link.path)?.candidates.push(reverseLink(note, link));
    }
  }

  const counts: CardReport['counts'] = {
    all: 0, week: 0, unknownCreated: 0, seed: 0, growing: 0, evergreen: 0, unset: 0, unknown: 0,
    recentReview: 0, stale: 0, noReview: 0, invalidReview: 0, isolated: 0, inHub: 0, reasoned: 0,
    sourced: 0, cited: 0, candidate: 0, unused: 0
  };
  const inScope = (link: CardRelationship): boolean => availablePath(link) && paths.has(link.path);
  let edges = 0;
  let reasonedEdges = 0;
  for (const row of rows.values()) {
    if (linksReady) {
      row.candidates = dedupeKnowledgeLinks(row.candidates);
      row.citations = dedupeKnowledgeLinks(row.citations);
      row.incoming = dedupeKnowledgeLinks(row.incoming);
      row.hubs = dedupeKnowledgeLinks(row.hubs);
      const outgoing = new Set<string>();
      const reasoned = new Set<string>();
      for (const link of row.outgoing) if (availablePath(link) && paths.has(link.path)) {
        outgoing.add(link.path);
        if (link.reason?.trim()) reasoned.add(link.path);
      }
      edges += outgoing.size;
      reasonedEdges += reasoned.size;
      const inHub = row.hubs.some(inScope);
      if (inHub) row.groups.add('inHub');
      if (!inHub && !outgoing.size && !row.incoming.some(inScope)) row.groups.add('isolated');
      if (reasoned.size) row.groups.add('reasoned');
      if (row.sources.some((link) => availablePath(link) && byPath.has(link.path))) row.groups.add('sourced');
      row.groups.add(row.citations.some(inScope) ? 'cited' : row.candidates.some(inScope) ? 'candidate' : 'unused');
    }
    for (const group of row.groups) counts[group]++;
  }

  const sorted = [...rows.values()].sort((left, right) => (right.created ?? '').localeCompare(left.created ?? '') || orderedPaths(left.note, right.note));
  return { rows: sorted, counts, generatedAt: now, today, linksReady, edges, reasonedEdges };
}

export function filterCardReport(index: CardReport, filter: CardFilter, dates?: CardDateRange | null, query = ''): CardReportRow[] {
  if (!index.linksReady && CARD_RELATION_FILTERS.has(filter)) return [];
  const search = query.trim().toLowerCase();
  return index.rows.filter((row) => {
    const matches = filter === 'period' ? !!dates && !!row.created && dates.first <= row.created && row.created <= dates.last : row.groups.has(filter);
    return matches && (!search || row.note.name.toLowerCase().includes(search) || row.note.path.toLowerCase().includes(search));
  });
}

export function cardCreationTrend(index: CardReport, range: ReportRange): CardDateRange & { bins: Array<CardDateRange & { count: number }>; count: number; unknown: number; step: number } {
  const days = recentDays(range, index.generatedAt);
  const step = range <= 7 ? 1 : range <= 90 ? 7 : 30;
  const bins: Array<CardDateRange & { count: number }> = [];
  const daysToBin = new Map<string, (typeof bins)[number]>();
  for (let offset = 0; offset < days.length; offset += step) {
    const group = days.slice(offset, offset + step);
    const bin = { first: group[0]!, last: group.at(-1)!, count: 0 };
    bins.push(bin);
    for (const day of group) daysToBin.set(day, bin);
  }
  let count = 0;
  for (const row of index.rows) {
    const bin = row.created && daysToBin.get(row.created);
    if (bin) { bin.count++; count++; }
  }
  return { first: days[0]!, last: days.at(-1)!, count, unknown: index.counts.unknownCreated, step, bins };
}

export type WritingStage = 'outline' | 'drafting' | 'revising' | 'finished' | 'published' | 'unset' | 'unknown';

export function writingStage(note: ReportRecord): WritingStage {
  const stage = note.frontmatter?.tangrow_writing_stage;
  if (stage === undefined || stage === null || stage === '') return note.frontmatter?.tangrow_status === 'draft' ? 'drafting' : 'unset';
  return stage === 'outline' || stage === 'drafting' || stage === 'revising' || stage === 'finished' || stage === 'published' ? stage : 'unknown';
}

export interface DraftReportRow {
  note: ReportRecord;
  stage: WritingStage;
  candidates: CardRelationship[];
  citations: CardRelationship[];
  cards: ReportRecord[];
}

export function reportDrafts(snapshot: ReportSnapshot): DraftReportRow[] {
  const drafts = snapshot.data.notes.filter((note) => note.frontmatter?.tangrow_kind === 'draft');
  const byPath = new Map(drafts.map((note): [string, DraftReportRow] => [note.path, {
    note, stage: writingStage(note), cards: [],
    candidates: snapshot.quality.linksReady ? note.knowledge?.materials ?? [] : [],
    citations: snapshot.quality.linksReady ? note.knowledge?.body ?? [] : []
  }]));
  if (snapshot.quality.linksReady) for (const card of snapshot.data.notes) {
    if (card.frontmatter?.tangrow_kind !== 'card') continue;
    const sources = new Set(card.knowledge?.sources.filter(availablePath).map((link) => link.path));
    for (const path of sources) byPath.get(path)?.cards.push(card);
  }
  return [...byPath.values()].sort((left, right) => orderedPaths(left.note, right.note));
}

type MaterialReason = 'literature' | 'clip' | 'resource' | 'derived';
export interface MaterialReportRow { note: ReportRecord; reason: MaterialReason; cards: number | null; citations: number | null }

const NON_MATERIAL_KINDS = new Set(['card', 'hub', 'draft', 'capture', 'project', 'task', 'focus', 'habit']);
const JOURNAL_KINDS = new Set(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']);

function materialReason(note: ReportRecord, settings: Settings, linksReady: boolean): MaterialReason | null {
  const fields = note.frontmatter;
  const kind = fields?.tangrow_kind;
  if (NON_MATERIAL_KINDS.has(String(kind)) || JOURNAL_KINDS.has(String(fields?.journal).trim().toLowerCase()) || reportJournalDay(note, settings)) return null;
  if (kind === 'literature') return 'literature';
  if (isClipRecord(note)) return 'clip';
  if (inFolder(note.path, settings.resourcesFolder)) return 'resource';
  if (linksReady && (kind === undefined || kind === 'note') && note.knowledge?.sources.some(availablePath)) return 'derived';
  return null;
}

function collectMaterials(scope: readonly ReportRecord[], settings: Settings, linksReady: boolean): { rows: MaterialReportRow[]; covered: number | null } {
  const rows = new Map<string, MaterialReportRow>();
  for (const note of scope) {
    const reason = materialReason(note, settings, linksReady);
    if (reason) rows.set(note.path, { note, reason, cards: linksReady ? 0 : null, citations: linksReady ? 0 : null });
  }
  if (linksReady) for (const note of scope) {
    const kind = note.frontmatter?.tangrow_kind;
    if (kind !== 'card' && kind !== 'draft') continue;
    const links = kind === 'card' ? note.knowledge?.sources : note.knowledge?.body;
    const targets = new Set(links?.filter(availablePath).map((link) => link.path));
    for (const target of targets) {
      const entry = rows.get(target);
      if (entry && kind === 'card') entry.cards = (entry.cards ?? 0) + 1;
      if (entry && kind === 'draft') entry.citations = (entry.citations ?? 0) + 1;
    }
  }
  const sorted = [...rows.values()].sort((left, right) => orderedPaths(left.note, right.note));
  return { rows: sorted, covered: linksReady ? sorted.filter((row) => !!row.cards).length : null };
}

export function reportMaterials(snapshot: ReportSnapshot, settings: Settings): ReturnType<typeof collectMaterials> {
  return collectMaterials(snapshot.data.notes, settings, snapshot.quality.linksReady);
}

export function reportCaptureCoverage(snapshot: ReportSnapshot): { captures: number; withResult: number | null; rows: Array<{ note: ReportRecord; hasResult: boolean | null }> } {
  const window = new Set(recentDays(90, snapshot.generatedAt));
  const knownNotes = new Map(snapshot.records.map((note) => [note.path, note]));
  const taskSources = new Map(snapshot.records.flatMap((note) => note.captureTaskSources?.length ? [[note.path, new Set(note.captureTaskSources)] as const] : []));
  const confirmedByReceipt = (path: string, source: string): boolean => {
    const result = knownNotes.get(path);
    if (taskSources.get(path)?.has(source)) return true;
    return !!result && result.frontmatter?.tangrow_kind === 'note' && typeof result.frontmatter.tangrow_capture_action_id === 'string'
      && !!result.knowledge?.sources.some((link) => availablePath(link) && link.path === source);
  };
  const rows = snapshot.data.notes.flatMap((note) => {
    const day = note.frontmatter?.tangrow_kind === 'capture' ? reportTrendDay(note, 'captures', snapshot.generatedAt) : null;
    if (!day || !window.has(day)) return [];
    const hasResult = snapshot.quality.linksReady ? !!note.knowledge && (
      note.knowledge.captureResults.some((link) => availablePath(link) && link.path !== note.path && knownNotes.has(link.path))
      || !!note.knowledge.legacyCaptureResults?.some((link) => availablePath(link) && confirmedByReceipt(link.path, note.path))
    ) : null;
    return [{ note, hasResult }];
  });
  return { rows, captures: rows.length, withResult: snapshot.quality.linksReady ? rows.filter((row) => row.hasResult).length : null };
}

export function buildWorkbenchCards(records: readonly ReportRecord[], settings: Settings, linksReady: boolean, now = Date.now()): {
  workspace: CardReport; report: CardReport; materials: MaterialReportRow[]; hubs: ReportRecord[];
} {
  const isReportPath = reportPathIncluded(settings);
  const excludeSupport = hasValidSupportFolder(settings);
  const workspace = records.filter((note) => !inFolder(note.path, settings.archiveFolder) && (!excludeSupport || !inFolder(note.path, settings.supportFolder)));
  const report = records.filter((note) => isReportPath(note.path));
  return {
    workspace: buildCardReport(records, workspace, linksReady, now),
    report: buildCardReport(records, report, linksReady, now),
    materials: collectMaterials(workspace, settings, linksReady).rows,
    hubs: workspace.filter((note) => note.frontmatter?.tangrow_kind === 'hub').sort(orderedPaths)
  };
}
