import { getFrontMatterInfo, parseYaml, stringifyYaml, TFile, TFolder, type App } from 'obsidian';
import { hasValidSupportFolder } from './folders';
import { inFolder, safeFolder } from './model';
import { canonicalEntityNotes, hasReportStatus, reportRecordStatus, reportStatusSource } from './report-metrics';
import type { ReportStatusChange, ReportStatusSource, ReportTask, ReportTaskStatus } from './report-contract';
import type { Settings } from './types';

const STALE_STATUS = 'This status changed since the report was loaded. Refresh the report and try again.';

function statusFields(content: string): Record<string, unknown> {
  const info = getFrontMatterInfo(content);
  if (!info.exists) return {};
  const fields: unknown = parseYaml(info.frontmatter);
  if (fields === null || fields === undefined) return {};
  if (typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Fix the note frontmatter before changing its status.');
  return fields as Record<string, unknown>;
}

function allowedPath(settings: Settings, path: string): boolean {
  safeFolder(path);
  const within = (folder: string): boolean => path === folder || inFolder(path, folder);
  return !(hasValidSupportFolder(settings) && within(settings.supportFolder)) && !settings.reportExcludedFolders.some(within);
}

function noteFile(app: App, settings: Settings, path: string): TFile {
  if (!allowedPath(settings, path)) throw new Error('This record is excluded from the report.');
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('This note no longer exists.');
  return file;
}

function assertRevision(path: string, fields: Record<string, unknown>, source: ReportStatusSource): void {
  if (path !== source.path || reportStatusSource({ path, frontmatter: fields }).revision !== source.revision) throw new Error(STALE_STATUS);
}

function setStatus(fields: Record<string, unknown>, status: string): void {
  const explicit = (key: string): boolean => fields[key] !== undefined && fields[key] !== null && fields[key] !== '';
  if (explicit('tangrow_status') || !explicit('status')) fields.tangrow_status = status;
  if (explicit('status')) fields.status = status;
}

async function waitForReportIndex(app: App, change: ReportStatusChange, paths: string[]): Promise<void> {
  const ready = (): boolean => paths.every((path) => {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return true;
    const cache = app.metadataCache.getFileCache(file);
    return change.kind === 'task'
      ? Boolean(cache?.listItems?.some((item) => item.position.start.line === change.task.line && item.task === change.status))
      : reportRecordStatus({ path, frontmatter: cache?.frontmatter }) === change.status;
  });
  if (ready()) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => { app.metadataCache.offref(ref); clearTimeout(timer); resolve(); };
    const ref = app.metadataCache.on('changed', () => { if (ready()) finish(); });
    // A delayed or unavailable index must not leave a status control permanently disabled.
    const timer = setTimeout(finish, 1500);
    if (ready()) finish();
  });
}

/** Keep the checkbox marker, full label, indentation and original line endings intact. */
export function changeReportTaskStatus(content: string, task: ReportTask, status: ReportTaskStatus): string {
  if (![' ', '/', 'x', '-'].includes(status)) throw new Error('Choose a valid task status.');
  const lines = content.split('\n');
  const line = Number.isInteger(task.line) && task.line >= 0 ? lines[task.line] : undefined;
  const match = line?.replace(/\r$/, '').match(/^((?: {0,3}>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([^\]\r\n])(\](?:[ \t]+(.*))?)$/);
  if (!match || match[2] !== task.status || (match[4] ?? '') !== task.text) throw new Error('This task changed in its note. Open the note to review it.');
  lines[task.line] = `${match[1]}${status}${match[3]}${line!.endsWith('\r') ? '\r' : ''}`;
  return lines.join('\n');
}

export async function writeReportStatus(app: App, settings: Settings, change: ReportStatusChange): Promise<void> {
  if (change.kind === 'task') {
    const file = noteFile(app, settings, change.task.path);
    if (inFolder(file.path, settings.archiveFolder)) throw new Error('This record is excluded from the report.');
    await app.vault.process(file, (content) => changeReportTaskStatus(content, change.task, change.status));
    await waitForReportIndex(app, change, [file.path]);
    return;
  }
  if (!['open', 'done', 'archived'].includes(change.status)) throw new Error('Choose a valid record status.');
  if (change.kind === 'note') {
    const file = noteFile(app, settings, change.source.path);
    await app.fileManager.processFrontMatter(file, (fields) => {
      assertRevision(file.path, fields, change.source);
      setStatus(fields, change.status);
    });
    await waitForReportIndex(app, change, [file.path]);
    return;
  }
  const root = change.collection === 'projects' ? settings.projectFolder : settings.areaFolder;
  if (!allowedPath(settings, change.path) || change.path.slice(0, change.path.lastIndexOf('/')) !== root
    || !(app.vault.getAbstractFileByPath(change.path) instanceof TFolder)) throw new Error('Choose an existing project or area folder.');
  const files = app.vault.getMarkdownFiles().filter((file) => inFolder(file.path, change.path) && allowedPath(settings, file.path));
  const candidates = canonicalEntityNotes(files, change.path);
  if (candidates.length !== change.sources.length || candidates.some((file) => !change.sources.some((source) => source.path === file.path))) throw new Error(STALE_STATUS);
  const records = await Promise.all(candidates.map(async (file) => ({ file, frontmatter: statusFields(await app.vault.read(file)) })));
  for (const record of records) assertRevision(record.file.path, record.frontmatter, change.sources.find((source) => source.path === record.file.path)!);
  if (!records.length) {
    const path = `${change.path}/README.md`;
    if (!allowedPath(settings, path)) throw new Error('This record is excluded from the report.');
    const dates = files.map((file) => file.stat.ctime).filter((time) => Number.isFinite(time) && time >= 0 && time <= Date.now());
    // Adding the first canonical note must not make an existing project appear newly created.
    const options = dates.length ? { ctime: Math.min(...dates) } : undefined;
    const fields = { tangrow_kind: change.collection === 'projects' ? 'project' : 'area', tangrow_status: change.status };
    await app.vault.create(path, `---\n${stringifyYaml(fields)}---\n\n# ${change.path.split('/').at(-1)}\n`, options);
    await waitForReportIndex(app, change, [path]);
    return;
  }
  const written: string[] = [];
  for (const [index, record] of records.entries()) {
    if (index !== 0 && !hasReportStatus({ path: record.file.path, frontmatter: record.frontmatter })) continue;
    const source = change.sources.find((source) => source.path === record.file.path)!;
    await app.fileManager.processFrontMatter(record.file, (fields) => {
      assertRevision(record.file.path, fields, source);
      setStatus(fields, change.status);
    });
    written.push(record.file.path);
  }
  await waitForReportIndex(app, change, written);
}
