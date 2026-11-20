import type { App, CachedMetadata, TFile } from 'obsidian';
import { hasValidSupportFolder } from './folders';
import { hasConnectionAnnotations, readCaptureTaskSources, readKnowledgeRecord, type ResolveAnchor } from './knowledge-index';
import { markdownStats, type MarkdownStats } from './markdown-stats';
import { inFolder, safeFolder } from './model';
import type { ReportRecord } from './report-contract';
import type { Settings } from './types';

export interface KnowledgeSourceResult {
  records: ReportRecord[];
  linksReady: boolean;
}

export interface ReportSourceResult extends KnowledgeSourceResult {
  folders: string[];
  unreadable: number;
}

interface BodyStats extends MarkdownStats {
  taskLines: Map<number, string>;
  connectionLines: Map<number, string>;
  captureTaskLines: Map<number, number>;
}

interface CacheEntry {
  modified: number;
  size: number;
  pending: Promise<BodyStats | null>;
}

function tagsFrom(cache: CachedMetadata | null): string[] {
  const tags = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || !value.trim()) return;
    const tag = value.trim();
    if (tag !== '#') tags.add(tag.startsWith('#') ? tag : `#${tag}`);
  };
  for (const entry of cache?.tags ?? []) add(entry.tag);
  const property: unknown = cache?.frontmatter?.tags;
  if (Array.isArray(property)) property.forEach(add);
  else if (typeof property === 'string') property.split(/[,\s]+/u).forEach(add);
  return [...tags];
}

function bodyStats(content: string): BodyStats {
  const taskLines = new Map<number, string>();
  const connectionLines = new Map<number, string>();
  const captureTaskLines = new Map<number, number>();
  for (const [index, line] of content.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const task = line.match(/^(?: {0,3}>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[^\]\n]\](?:[ \t]+(.*))?$/);
    if (task) {
      taskLines.set(index, task[1] ?? '');
      const marker = /<!--\s*tangrow-capture:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\s*-->/iu.exec(line);
      if (marker) captureTaskLines.set(index, marker.index);
    }
    if (/[\])][ \t]*[-\u2013\u2014\u00b7][ \t]*\p{L}/u.test(line)) connectionLines.set(index, line);
  }
  return { ...markdownStats(content), taskLines, connectionLines, captureTaskLines };
}

export class ReportSource {
  private readonly cache = new Map<string, CacheEntry>();
  private activeReads = 0;
  private readonly waiting: Array<() => void> = [];
  private linksDirty = false;
  private linksRevision = 0;
  private knowledgeCache: { key: string; pending: Promise<KnowledgeSourceResult> } | null = null;

  constructor(private readonly app: App, private readonly resolveAnchor?: ResolveAnchor) {}

  invalidate(path?: string): void {
    this.knowledgeCache = null;
    if (path === undefined) this.cache.clear();
    else this.cache.delete(path);
  }

  markLinksDirty(): void {
    this.linksDirty = true;
    this.linksRevision++;
  }

  markLinksResolved(): void {
    this.linksDirty = false;
    this.linksRevision++;
  }

  collectKnowledge(settings: Settings): Promise<KnowledgeSourceResult> {
    const excluded = this.exclusions(settings);
    const excludeSupport = hasValidSupportFolder(settings);
    const key = JSON.stringify([this.linksRevision, excluded, settings.archiveFolder]);
    if (this.knowledgeCache?.key === key) return this.knowledgeCache.pending;
    const pending = this.readRecords((file, metadata) => {
      const reportIncluded = !excluded.some((folder) => file.path === folder || inFolder(file.path, folder));
      const workspaceIncluded = (!excludeSupport || !inFolder(file.path, settings.supportFolder)) && !inFolder(file.path, settings.archiveFolder);
      return (reportIncluded || workspaceIncluded) && hasConnectionAnnotations(metadata);
    }, false).then(({ records, linksReady }) => {
      if ((!linksReady || records.some((record) => record.knowledge?.unreadable)) && this.knowledgeCache?.pending === pending) this.knowledgeCache = null;
      return { records, linksReady };
    });
    this.knowledgeCache = { key, pending };
    return pending;
  }

  async collect(settings: Settings): Promise<ReportSourceResult> {
    const excluded = this.exclusions(settings);
    const result = await this.readRecords((file) => !excluded.some((folder) => file.path === folder || inFolder(file.path, folder)), true);
    const folders = [...new Set(this.app.vault.getAllFolders().map((folder) => folder.path).filter((path) => path && path !== '/'))].sort();
    return { ...result, folders };
  }

  private exclusions(settings: Settings): string[] {
    const excluded = settings.reportExcludedFolders.flatMap((folder) => {
      try { return [safeFolder(folder)]; } catch { return []; }
    });
    if (hasValidSupportFolder(settings)) excluded.push(settings.supportFolder);
    return excluded;
  }

  private async readRecords(read: (file: TFile, metadata: CachedMetadata | null) => boolean, statistics: boolean): Promise<KnowledgeSourceResult & { unreadable: number }> {
    const files = this.app.vault.getMarkdownFiles();
    const existing = new Set(files.map((file) => file.path));
    for (const path of this.cache.keys()) if (!existing.has(path)) this.cache.delete(path);
    const resolved = this.app.metadataCache.resolvedLinks;
    const linksRevision = this.linksRevision;
    let linksReady = !this.linksDirty && resolved !== null && typeof resolved === 'object';
    let unreadable = 0;
    const records = await Promise.all(files.map(async (file): Promise<ReportRecord> => {
      const metadata = this.app.metadataCache.getFileCache(file);
      if (!metadata) linksReady = false;
      const tasks = (metadata?.listItems ?? []).filter((item) => typeof item.task === 'string');
      const record: ReportRecord = {
        path: file.path,
        name: file.basename,
        created: file.stat.ctime,
        modified: file.stat.mtime,
        frontmatter: metadata?.frontmatter ? { ...metadata.frontmatter } : undefined,
        tasks: tasks.map((item) => item.task!),
        tags: tagsFrom(metadata),
        links: resolved && typeof resolved === 'object' ? Object.keys(resolved[file.path] ?? {}) : undefined
      };
      const shouldRead = read(file, metadata);
      const body = shouldRead ? await this.readBody(file) : null;
      if (metadata) record.knowledge = readKnowledgeRecord(this.app.metadataCache, file, metadata, body?.connectionLines, this.resolveAnchor);
      if (shouldRead && !body) {
        unreadable++;
        if (record.knowledge) record.knowledge.unreadable = true;
      }
      if (!statistics || !body) return record;
      if (metadata && body.captureTaskLines.size) record.captureTaskSources = readCaptureTaskSources(this.app.metadataCache, file, metadata, body.captureTaskLines);
      record.wordCount = body.wordCount;
      record.characterCount = body.characterCount;
      record.taskItems = tasks.map((item) => ({
        path: file.path,
        name: file.basename,
        line: item.position.start.line,
        text: body.taskLines.get(item.position.start.line) ?? '',
        status: item.task!
      }));
      return record;
    }));
    return { records, unreadable, linksReady: linksReady && !this.linksDirty && linksRevision === this.linksRevision };
  }

  private readBody(file: TFile): Promise<BodyStats | null> {
    const saved = this.cache.get(file.path);
    if (saved && saved.modified === file.stat.mtime && saved.size === file.stat.size) return saved.pending;
    const entry: CacheEntry = {
      modified: file.stat.mtime,
      size: file.stat.size,
      pending: this.withReadSlot(async () => {
        try { return bodyStats(await this.app.vault.cachedRead(file)); }
        catch { return null; }
      })
    };
    this.cache.set(file.path, entry);
    void entry.pending.then((body) => {
      if (!body && this.cache.get(file.path) === entry) this.cache.delete(file.path);
    });
    return entry.pending;
  }

  private async withReadSlot<T>(read: () => Promise<T>): Promise<T> {
    if (this.activeReads >= 3) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.activeReads++;
    try { return await read(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.activeReads--;
    }
  }
}
