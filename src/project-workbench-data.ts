import { hasValidSupportFolder } from './folders';
import { inFolder } from './model';
import { canonicalEntityNotes, collectReportEntities } from './report-metrics';
import type { ReportRecord, ReportStatus } from './report-contract';
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
  /** Earliest dated open task, for project urgency. */
  due: Date | null;
}

export interface WorkbenchProjectRecord extends ReportRecord {
  linkedProjectPath?: string;
}

export interface WorkbenchProjectTaskSource extends TaskSummary {
  linkedProjectPaths?: readonly string[];
}

const NON_OUTPUT_KINDS = new Set(['capture', 'card', 'clip', 'literature', 'hub', 'topic', 'focus', 'habit']);

export function buildWorkbenchProjects(
  records: readonly WorkbenchProjectRecord[],
  tasks: readonly WorkbenchProjectTaskSource[],
  folders: readonly string[],
  settings: Settings
): WorkbenchProject[] {
  const excludeSupport = hasValidSupportFolder(settings);
  const included = (path: string): boolean => path !== settings.archiveFolder && !inFolder(path, settings.archiveFolder)
    && (!excludeSupport || (path !== settings.supportFolder && !inFolder(path, settings.supportFolder)));
  const visible = records.filter((record) => included(record.path));
  const byNote = new Map(visible.map((record) => [record.path, record]));
  const projectRecords = visible.filter((record) => inFolder(record.path, settings.projectFolder));
  const projects = collectReportEntities(projectRecords, settings.projectFolder, folders.filter(included)).map<WorkbenchProject>((entity) => ({
    path: entity.path, name: entity.name, notePath: entity.notePath, status: entity.status, notes: [], tasks: [], due: null
  }));
  const byPath = new Map(projects.map((project) => [project.path, project]));
  const projectForNote = (path: string | undefined): WorkbenchProject | undefined => {
    if (!path || !byNote.has(path) || !inFolder(path, settings.projectFolder)) return undefined;
    const first = path.slice(settings.projectFolder.length + 1).split('/', 1)[0];
    return byPath.get(`${settings.projectFolder}/${first}`);
  };
  const canonicalPaths = new Set(projects.flatMap((project) => project.notePath === project.path ? [project.path]
    : canonicalEntityNotes(projectRecords, project.path).map((record) => record.path)));

  for (const record of visible) {
    if (canonicalPaths.has(record.path)) continue;
    const kind = String(record.frontmatter?.tangrow_kind ?? '');
    if (NON_OUTPUT_KINDS.has(kind)) continue;
    const contained = projectForNote(record.path);
    const linked = projectForNote(record.linkedProjectPath);
    if (!contained && !linked) continue;
    const note: NoteSummary = {
      path: record.path, name: record.name, folder: record.path.slice(0, Math.max(0, record.path.lastIndexOf('/'))),
      modified: record.modified, kind, status: String(record.frontmatter?.tangrow_status ?? '')
    };
    contained?.notes.push(note);
    if (linked !== contained) linked?.notes.push(note);
  }

  const seen = new Set<string>();
  for (const candidate of tasks) {
    const record = byNote.get(candidate.path);
    if (!record) continue;
    const memberships = new Map<WorkbenchProject, WorkbenchProjectTask['sourceKind']>();
    const linked = projectForNote(record.linkedProjectPath);
    const contained = projectForNote(record.path);
    if (linked) memberships.set(linked, 'linked');
    if (contained) memberships.set(contained, 'folder');
    if (record.path === settings.taskOverviewPath) for (const path of candidate.linkedProjectPaths ?? []) {
      const project = projectForNote(path);
      if (project) memberships.set(project, 'overview');
    }
    if (!memberships.size) continue;
    const due = candidate.done ? null : parseTaskDisplay(candidate.text).due;
    for (const [project, sourceKind] of memberships) {
      const key = JSON.stringify([project.path, candidate.path, candidate.line]);
      if (seen.has(key)) continue;
      seen.add(key);
      project.tasks.push({ path: candidate.path, line: candidate.line, text: candidate.text, done: candidate.done, sourceKind, sourceName: record.name,
        ...(candidate.labelPending ? { labelPending: true } : {}) });
      if (due && (!project.due || due.getTime() < project.due.getTime())) project.due = due;
    }
  }
  for (const project of projects) project.notes.sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path));
  return projects;
}
