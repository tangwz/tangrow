import type { CachedMetadata, MetadataCache, ReferenceCache, TFile } from 'obsidian';
import { readMarkdownLinkTarget } from './markdown-links';

export type CardRelation = 'supports' | 'challenges' | 'extends' | 'exemplifies' | 'contrasts' | 'related';

export interface CardRelationship {
  path: string | null;
  anchor: string;
  raw: string;
  relation?: CardRelation;
  reason?: string;
  anchorMissing?: boolean;
}

export interface KnowledgeRecord {
  body: CardRelationship[];
  sources: CardRelationship[];
  legacySources: CardRelationship[];
  materials: CardRelationship[];
  parent: CardRelationship[];
  captureResults: CardRelationship[];
  legacyCaptureResults?: CardRelationship[];
  unreadable?: boolean;
}

export type ResolveAnchor = (cache: CachedMetadata, anchor: string) => unknown;

const RELATIONS = new Map<string, CardRelation>([
  ['supports', 'supports'], ['\u652f\u6491', 'supports'],
  ['challenges', 'challenges'], ['\u53cd\u9a73', 'challenges'],
  ['extends', 'extends'], ['\u5ef6\u4f38', 'extends'],
  ['exemplifies', 'exemplifies'], ['\u4e3e\u4f8b', 'exemplifies'],
  ['contrasts', 'contrasts'], ['\u5bf9\u6bd4', 'contrasts'],
  ['related', 'related'], ['\u76f8\u5173', 'related']
]);
const SOURCE_HEADINGS = new Set(['source', 'sources', '\u6765\u6e90', '\u63d0\u70bc\u6765\u6e90']);
const CONNECTION_HEADINGS = new Set(['connection', 'connections', '\u5173\u8054', '\u89c2\u70b9\u8fde\u63a5']);
const ATTACHMENT_PATH = /\.(?:avif|bmp|canvas|flac|gif|heic|jpeg|jpg|mov|mp3|mp4|oga|ogg|pdf|png|svg|wav|webm|webp)$/iu;

function decoded(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

function resolveLink(metadataCache: MetadataCache, file: TFile, raw: string, link: string, resolveAnchor?: ResolveAnchor): CardRelationship | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(link)) return null;
  const split = link.indexOf('#');
  const linkpath = split < 0 ? link : link.slice(0, split);
  const anchor = split < 0 ? '' : decoded(link.slice(split));
  const path = /^!?\[\[/u.test(raw) ? linkpath : decoded(linkpath);
  const target = path ? metadataCache.getFirstLinkpathDest?.(path, file.path) : anchor ? file : null;
  if (target ? target.extension.toLowerCase() !== 'md' : ATTACHMENT_PATH.test(path)) return null;
  const relationship: CardRelationship = { path: target?.path ?? null, anchor, raw };
  if (target && anchor && resolveAnchor) {
    const cache = metadataCache.getFileCache(target);
    if (cache && !resolveAnchor(cache, anchor)) relationship.anchorMissing = true;
  }
  return relationship;
}

export function readCaptureTaskSources(metadataCache: MetadataCache, file: TFile, cache: CachedMetadata, taskLines: ReadonlyMap<number, number>): string[] {
  if (!taskLines.size) return [];
  const tasks = new Set(cache.listItems?.filter((item) => typeof item.task === 'string').map((item) => item.position.start.line));
  const sources = new Map<number, ReferenceCache>();
  for (const ref of cache.links ?? []) {
    const line = ref.position.end.line;
    const marker = taskLines.get(line);
    if (!tasks.has(line) || marker === undefined || ref.position.end.col > marker) continue;
    const current = sources.get(line);
    if (!current || ref.position.end.col > current.position.end.col) sources.set(line, ref);
  }
  const paths = new Set<string>();
  for (const ref of sources.values()) {
    const link = resolveLink(metadataCache, file, ref.original, ref.link);
    if (link?.path) paths.add(link.path);
  }
  return [...paths];
}

export function resolvePropertyLink(metadataCache: MetadataCache, source: TFile, value: unknown, resolveAnchor?: ResolveAnchor): CardRelationship | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  const target = typeof value === 'string' ? readMarkdownLinkTarget(value.trim()) : null;
  return (target ? resolveLink(metadataCache, source, raw, target, resolveAnchor) : null) ?? { path: null, anchor: '', raw };
}

export function dedupeKnowledgeLinks(links: readonly CardRelationship[]): CardRelationship[] {
  const unique = new Map<string, CardRelationship>();
  for (const link of links) {
    const key = JSON.stringify(link.path ? [link.path, link.anchor] : [link.raw]);
    const previous = unique.get(key);
    if (!previous || (!previous.reason && link.reason)) unique.set(key, link);
  }
  return [...unique.values()];
}

export function connectionAnnotation(suffix: string): Pick<CardRelationship, 'relation' | 'reason'> | null {
  const match = /^\s*(?:[-\u2013\u2014]|\u00b7)\s*([^:\uff1a]+?)(?:\s*[:\uff1a]\s*(.*))?\s*$/u.exec(suffix);
  const relation = RELATIONS.get(match?.[1]?.trim().toLowerCase() ?? '');
  return relation ? { relation, reason: match?.[2]?.trim() || undefined } : null;
}

export function hasConnectionAnnotations(cache: CachedMetadata | null): boolean {
  return cache?.frontmatter?.tangrow_kind === 'card' && !!(cache.links?.length || cache.embeds?.length)
    && (cache.headings ?? []).some((heading) => CONNECTION_HEADINGS.has(heading.heading.trim().toLowerCase()));
}

function bodyLinks(
  metadataCache: MetadataCache, file: TFile, cache: CachedMetadata, isCard: boolean,
  annotations: ReadonlyMap<number, string> | undefined, resolveAnchor?: ResolveAnchor
): CardRelationship[] {
  const links = [...(cache.links ?? []), ...(cache.embeds ?? [])];
  if (!isCard) return dedupeKnowledgeLinks(links.flatMap((ref) => resolveLink(metadataCache, file, ref.original, ref.link, resolveAnchor) ?? []));

  links.sort((left, right) => left.position.start.offset - right.position.start.offset);
  const headings = [...(cache.headings ?? [])].sort((left, right) => left.position.start.offset - right.position.start.offset);
  const activeHeadings: Array<{ level: number; source: boolean; connection: boolean }> = [];
  let headingIndex = 0;
  return dedupeKnowledgeLinks(links.flatMap((ref: ReferenceCache) => {
    while (headings[headingIndex] && headings[headingIndex]!.position.start.offset <= ref.position.start.offset) {
      const heading = headings[headingIndex++]!;
      const key = heading.heading.trim().toLowerCase();
      while (activeHeadings.length && activeHeadings.at(-1)!.level >= heading.level) activeHeadings.pop();
      activeHeadings.push({ level: heading.level, source: SOURCE_HEADINGS.has(key), connection: CONNECTION_HEADINGS.has(key) });
    }
    if (activeHeadings.some((heading) => heading.source)) return [];
    const link = resolveLink(metadataCache, file, ref.original, ref.link, resolveAnchor);
    if (!link) return [];
    if (!activeHeadings.some((heading) => heading.connection) || ref.position.start.line !== ref.position.end.line) return [link];
    const line = annotations?.get(ref.position.end.line);
    const annotation = line && connectionAnnotation(line.slice(ref.position.end.col));
    return [annotation ? { ...link, ...annotation } : link];
  }));
}

export function readKnowledgeRecord(
  metadataCache: MetadataCache, file: TFile, cache: CachedMetadata, annotations?: ReadonlyMap<number, string>, resolveAnchor?: ResolveAnchor
): KnowledgeRecord | undefined {
  const fields = cache.frontmatter;
  const kind = fields?.tangrow_kind;
  const readBody = kind === 'card' || kind === 'hub' || kind === 'draft';
  if (!readBody && kind !== 'capture' && !fields?.tangrow_sources && !fields?.tangrow_capture_action_id) return undefined;

  const field = (name: string): CardRelationship[] => {
    const value: unknown = fields?.[name];
    return dedupeKnowledgeLinks((Array.isArray(value) ? value : [value]).flatMap((item) =>
      resolvePropertyLink(metadataCache, file, item, resolveAnchor) ?? []));
  };
  const legacySources = field('tangrow_source');
  let sources = field('tangrow_sources');
  if (typeof fields?.tangrow_capture_action_id === 'string' && fields.tangrow_capture_action_id.trim()) {
    sources = dedupeKnowledgeLinks([...sources, ...legacySources]);
  }
  const legacyResults = kind === 'capture' ? field('tangrow_capture_result') : [];
  const projectPaths = new Set(kind === 'capture' ? field('tangrow_project').map((link) => link.path) : []);
  return {
    body: readBody ? bodyLinks(metadataCache, file, cache, kind === 'card', annotations, resolveAnchor) : [],
    sources,
    legacySources,
    materials: kind === 'draft' ? field('tangrow_materials') : [],
    parent: kind === 'card' ? field('tangrow_parent') : [],
    // The legacy project-only action recorded its association in the singular field.
    captureResults: kind === 'capture' ? field('tangrow_capture_results') : [],
    legacyCaptureResults: legacyResults.filter((link) => !link.path || !projectPaths.has(link.path))
  };
}
