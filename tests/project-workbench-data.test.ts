import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkbenchProjects, type WorkbenchProjectRecord, type WorkbenchProjectTaskSource } from '../src/project-workbench-data';
import { DEFAULT_SETTINGS } from '../src/types';

function note(path: string, frontmatter?: Record<string, unknown>, linkedProjectPath?: string, modified = 1): WorkbenchProjectRecord {
  return { path, name: path.split('/').at(-1)!.slice(0, -3), created: 1, modified, frontmatter, linkedProjectPath };
}

test('project workbench reuses entity note and state rules and omits contained archive and support folders', () => {
  const settings = { ...DEFAULT_SETTINGS, archiveFolder: '20-Project/Archive', supportFolder: '20-Project/Companion' };
  const project = '20-Project/Plan';
  const records = [
    note(`${project}/Plan.md`), note(`${project}/README.md`, { status: 'active' }),
    note(`${project}/Scripts/Draft.md`, { tangrow_kind: 'draft' }, undefined, 2),
    note('20-Project/Standalone.md', { tangrow_status: 'complete' }),
    note(`${settings.archiveFolder}/Archived project.md`), note(`${settings.supportFolder}/Support note.md`)
  ];
  const projects = buildWorkbenchProjects(records, [], [project, '20-Project/Empty', settings.archiveFolder, settings.supportFolder], settings);
  assert.deepEqual(projects.map(({ name, notePath, status, notes }) => [name, notePath, status, notes.map((entry) => entry.name)]), [
    ['Empty', null, 'unknown', []], ['Plan', `${project}/Plan.md`, 'open', ['Draft']], ['Standalone', '20-Project/Standalone.md', 'done', []]
  ]);
});

test('project tasks use folder, property and overview links with one row per checkbox and an open-task urgency date', () => {
  const project = '20-Project/Plan';
  const projectNote = `${project}/Plan.md`;
  const child = `${project}/Scripts/Checklist.md`;
  const standalone = '20-Project/Standalone.md';
  const overview = DEFAULT_SETTINGS.taskOverviewPath;
  const linked = '00-Inbox/Linked draft.md';
  const archived = '90-Archive/Old.md';
  const records = [
    note(projectNote), note(child, {}, projectNote), note(standalone), note(overview),
    note(linked, { tangrow_kind: 'draft' }, child, 3), note(archived, {}, projectNote)
  ];
  const repeated = { path: child, line: 4, text: 'Folder task 📅 2026-12-05', done: false };
  const tasks: WorkbenchProjectTaskSource[] = [
    repeated, repeated, { path: linked, line: 1, text: 'Linked task', done: false },
    { path: overview, line: 2, text: 'Two projects 📅 2026-12-01', done: false, linkedProjectPaths: [projectNote, child, standalone] },
    { path: overview, line: 3, text: 'Finished 📅 2026-11-01', done: true, linkedProjectPaths: [projectNote] },
    { path: overview, line: 4, text: 'Unassigned', done: false },
    { path: archived, line: 1, text: 'Archived task', done: false }
  ];
  const projects = buildWorkbenchProjects(records, tasks, [project], DEFAULT_SETTINGS);
  const plan = projects.find((item) => item.path === project);
  assert.ok(plan);
  assert.deepEqual(plan.notes.map((entry) => entry.path), [linked, child]);
  assert.deepEqual(plan.tasks.map(({ path, line, done, sourceKind, sourceName }) => [path, line, done, sourceKind, sourceName]), [
    [child, 4, false, 'folder', 'Checklist'], [linked, 1, false, 'linked', 'Linked draft'],
    [overview, 2, false, 'overview', '12-Tasks'], [overview, 3, true, 'overview', '12-Tasks']
  ]);
  assert.equal(plan.due?.toISOString(), '2026-12-01T00:00:00.000Z');
  assert.deepEqual(projects.find((item) => item.path === standalone)?.tasks.map((task) => task.line), [2]);
});
