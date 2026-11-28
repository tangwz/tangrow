import { materialReason } from './card-report-data';
import { hasValidSupportFolder } from './folders';
import { inFolder } from './model';
import { canonicalEntityNotes, collectReportEntities, collectReportResources } from './report-metrics';
import type { ReportRecord, ReportResource, ReportStatus } from './report-contract';
import { parseTaskDisplay } from './task-display';
import type { NoteSummary, Settings, TaskSummary } from './types';

export interface WorkbenchProjectTask extends TaskSummary {
  sourceKind: 'folder' | 'linked' | 'overview';
  sourceName: string;
}

export interface WorkbenchProject {
  path: string;
  name: string;
  notePath: string | null;
  status: ReportStatus;
  notes: NoteSummary[];
  tasks: WorkbenchProjectTask[];
  areaPath: string | null;
  /** Stable project note that owns the optional area link. */
  areaNotePath?: string | null;
  projectType?: string | null;
  typeNotePath?: string | null;
  references: WorkbenchLinkCandidate[];
  /** Earliest dated open task, for project urgency. */
  due: Date | null;
}

export interface WorkbenchArea {
  path: string;
  name: string;
  notePath: string | null;
  noteCount: number;
  modified: number | null;
  recent: NoteSummary[];
  tasks: WorkbenchProjectTask[];
  projects: Array<Pick<WorkbenchProject, 'path' | 'name' | 'status'>>;
}

export interface WorkbenchLinkCandidate {
  path: string;
  name: string;
  role: 'note' | 'card' | 'material';
  location: string;
  projectPath: string | null;
}

export interface WorkbenchProjectType {
  key: string;
  name: string;
  count: number;
}

export interface WorkbenchParaData {
  projects: WorkbenchProject[];
  areas: WorkbenchArea[];
  resources: ReportResource[];
  candidates: WorkbenchLinkCandidate[];
  types: WorkbenchProjectType[];
  drafts: NoteSummary[];
}

export interface WorkbenchProjectRecord extends ReportRecord {
  linkedProjectPath?: string;
  linkedAreaPath?: string;
}

export interface WorkbenchProjectTaskSource extends TaskSummary {
  overviewLinks?: readonly string[];
}

const NON_OUTPUT_KINDS = new Set(['capture', 'card', 'clip', 'literature', 'hub', 'topic', 'focus', 'habit']);

export type ProjectNoteProperty = 'tangrow_area' | 'tangrow_project_type';

export function readProjectType(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

export function projectTypeKey(value: string): string {
  return value.trim().normalize('NFC').toLowerCase();
}

export function projectMetadataOwner<T extends { frontmatter?: Record<string, unknown> }>(canonical: readonly T[], property: ProjectNoteProperty): T | undefined {
  return canonical.find((note) => {
    const value = note.frontmatter?.[property];
    // A clear can leave null on the owner when another canonical note still has a type.
    if (property === 'tangrow_project_type' && value === null) return true;
    return typeof value === 'string' && value.trim() !== '';
  }) ?? canonical[0];
}

function hasProjectLink(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

function collectProjectTypes(projects: readonly WorkbenchProject[]): WorkbenchProjectType[] {
  const types = new Map<string, WorkbenchProjectType>();
  for (const project of projects) {
    if (!project.projectType) continue;
    const key = projectTypeKey(project.projectType);
    const type = types.get(key);
    if (type) type.count++;
    else types.set(key, { key, name: project.projectType, count: 1 });
  }
  return [...types.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function workbenchPathIncluded(settings: Settings): (path: string) => boolean {
  const excludeSupport = hasValidSupportFolder(settings);
  return (path) => path !== settings.archiveFolder && !inFolder(path, settings.archiveFolder)
    && (!excludeSupport || (path !== settings.supportFolder && !inFolder(path, settings.supportFolder)));
}

function entityForNote<T>(root: string, entities: ReadonlyMap<string, T>, path: string | undefined): T | undefined {
  if (!path || !inFolder(path, root)) return undefined;
  const first = path.slice(root.length + 1).split('/', 1)[0];
  return entities.get(`${root}/${first}`);
}

function noteSummary(record: WorkbenchProjectRecord): NoteSummary {
  return {
    path: record.path, name: record.name, folder: record.path.slice(0, Math.max(0, record.path.lastIndexOf('/'))),
    modified: record.modified, kind: String(record.frontmatter?.tangrow_kind ?? ''), status: String(record.frontmatter?.tangrow_status ?? '')
  };
}

function recentFirst(left: NoteSummary, right: NoteSummary): number {
  return right.modified - left.modified || left.path.localeCompare(right.path);
}

export function buildWorkbenchPara(
  records: readonly WorkbenchProjectRecord[],
  tasks: readonly WorkbenchProjectTaskSource[],
  folders: readonly string[],
  settings: Settings
): WorkbenchParaData {
  const included = workbenchPathIncluded(settings);
  const visible = records.filter((record) => included(record.path));
  const byNote = new Map(visible.map((record) => [record.path, record]));
  const visibleFolders = folders.filter(included);
  const projectRecords = visible.filter((record) => inFolder(record.path, settings.projectFolder));
  const canonicalPaths = new Set<string>();
  const projects = collectReportEntities(projectRecords, settings.projectFolder, visibleFolders).map<WorkbenchProject>((entity) => {
    const rootNote = byNote.get(entity.path);
    const canonical = rootNote ? [rootNote] : canonicalEntityNotes(projectRecords, entity.path);
    for (const record of canonical) canonicalPaths.add(record.path);
    const typeOwner = projectMetadataOwner(canonical, 'tangrow_project_type');
    return { path: entity.path, name: entity.name, notePath: entity.notePath, status: entity.status, notes: [], tasks: [], due: null,
      areaPath: null, areaNotePath: projectMetadataOwner(canonical, 'tangrow_area')?.path ?? null, references: [],
      projectType: readProjectType(typeOwner?.frontmatter?.tangrow_project_type), typeNotePath: typeOwner?.path ?? null };
  });
  const areaRecords = visible.filter((record) => inFolder(record.path, settings.areaFolder));
  const areas = collectReportEntities(areaRecords, settings.areaFolder, visibleFolders).map<WorkbenchArea>((entity) => ({
    path: entity.path, name: entity.name, notePath: entity.notePath, noteCount: entity.noteCount, modified: null, recent: [], tasks: [], projects: []
  }));
  const resources = collectReportResources(visible, settings.resourcesFolder, visibleFolders);
  const byProject = new Map(projects.map((project) => [project.path, project]));
  const byArea = new Map(areas.map((area) => [area.path, area]));
  const byResource = new Map(resources.map((resource) => [resource.path, resource]));
  const projectForNote = (path: string | undefined) => path && byNote.has(path) ? entityForNote(settings.projectFolder, byProject, path) : undefined;
  const areaForNote = (path: string | undefined) => path && byNote.has(path) ? entityForNote(settings.areaFolder, byArea, path) : undefined;
  const candidates: WorkbenchLinkCandidate[] = [];
  const drafts: NoteSummary[] = [];

  for (const project of projects) {
    const link = project.areaNotePath ? byNote.get(project.areaNotePath)?.linkedAreaPath : undefined;
    const area = areaForNote(link);
    if (!area) continue;
    project.areaPath = area.path;
    if (project.status !== 'done' && project.status !== 'archived') area.projects.push({ path: project.path, name: project.name, status: project.status });
  }

  for (const record of visible) {
    areaForNote(record.path)?.recent.push(noteSummary(record));
    if (canonicalPaths.has(record.path)) continue;
    const kind = String(record.frontmatter?.tangrow_kind ?? '');
    if (kind === 'draft' && !inFolder(record.path, settings.projectFolder) && !hasProjectLink(record.frontmatter?.tangrow_project)) drafts.push(noteSummary(record));
    const contained = projectForNote(record.path);
    const linked = projectForNote(record.linkedProjectPath);
    const role = kind === 'card' ? 'card' : materialReason(record, settings, true) ? 'material' : NON_OUTPUT_KINDS.has(kind) ? null : 'note';
    if (role && (role !== 'note' || kind === 'draft' || inFolder(record.path, settings.areaFolder) || inFolder(record.path, settings.inboxFolder))) {
      const resource = entityForNote(settings.resourcesFolder, byResource, record.path);
      const candidate: WorkbenchLinkCandidate = {
        path: record.path, name: record.name, role, projectPath: (linked ?? contained)?.path ?? null,
        location: resource?.name ?? record.path.slice(0, Math.max(0, record.path.lastIndexOf('/')))
      };
      candidates.push(candidate);
      if (role !== 'note') linked?.references.push(candidate);
    }
    if (role !== 'note') continue;
    if (!contained && !linked) continue;
    const note = noteSummary(record);
    contained?.notes.push(note);
    if (linked !== contained) linked?.notes.push(note);
  }

  const seen = new Set<string>();
  for (const candidate of tasks) {
    const record = byNote.get(candidate.path);
    if (!record) continue;
    const memberships = new Map<WorkbenchProject | WorkbenchArea, WorkbenchProjectTask['sourceKind']>();
    const linked = projectForNote(record.linkedProjectPath);
    const contained = projectForNote(record.path);
    if (linked) memberships.set(linked, 'linked');
    if (contained) memberships.set(contained, 'folder');
    const area = areaForNote(record.path);
    if (area) memberships.set(area, 'folder');
    if (record.path === settings.taskOverviewPath) for (const path of candidate.overviewLinks ?? []) {
      const project = projectForNote(path);
      if (project) memberships.set(project, 'overview');
      const linkedArea = areaForNote(path);
      if (linkedArea) memberships.set(linkedArea, 'overview');
    }
    if (!memberships.size) continue;
    const due = candidate.done ? null : parseTaskDisplay(candidate.text).due;
    for (const [entity, sourceKind] of memberships) {
      const key = JSON.stringify(['due' in entity, entity.path, candidate.path, candidate.line]);
      if (seen.has(key)) continue;
      seen.add(key);
      entity.tasks.push({ path: candidate.path, line: candidate.line, text: candidate.text, done: candidate.done, sourceKind, sourceName: record.name,
        ...(candidate.labelPending ? { labelPending: true } : {}) });
      if ('due' in entity && due && (!entity.due || due.getTime() < entity.due.getTime())) entity.due = due;
    }
  }
  for (const project of projects) project.notes.sort(recentFirst);
  for (const area of areas) {
    area.recent.sort(recentFirst);
    area.modified = area.recent[0]?.modified ?? null;
  }
  return { projects, areas, resources, candidates, types: collectProjectTypes(projects), drafts: drafts.sort(recentFirst) };
}
