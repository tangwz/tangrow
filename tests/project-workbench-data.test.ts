import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkbenchPara, projectTypeKey, type WorkbenchProjectRecord, type WorkbenchProjectTaskSource } from '../src/project-workbench-data';
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
  const { projects } = buildWorkbenchPara(records, [], [project, '20-Project/Empty', settings.archiveFolder, settings.supportFolder], settings);
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
    { path: overview, line: 2, text: 'Two projects 📅 2026-12-01', done: false, overviewLinks: [projectNote, child, standalone] },
    { path: overview, line: 3, text: 'Finished 📅 2026-11-01', done: true, overviewLinks: [projectNote] },
    { path: overview, line: 4, text: 'Unassigned', done: false },
    { path: archived, line: 1, text: 'Archived task', done: false }
  ];
  const { projects } = buildWorkbenchPara(records, tasks, [project], DEFAULT_SETTINGS);
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

test('PARA workbench groups area tasks and resources and keeps linked references out of project outputs', () => {
  const project = '20-Project/Plan/Plan.md';
  const done = '20-Project/Finished.md';
  const area = '30-Area/Work/README.md';
  const areaChild = '30-Area/Work/Planning/Plan.md';
  const standalone = '30-Area/Health.md';
  const resourceNote = '40-Resources/Writing/Source.md';
  const clip = '00-Inbox/Clip.md';
  const card = '50-Zettel/Argument.md';
  const manuscript = '00-Inbox/Draft.md';
  const overview = DEFAULT_SETTINGS.taskOverviewPath;
  const records = [
    { ...note(project, { tangrow_status: 'open' }), linkedAreaPath: area },
    { ...note(done, { tangrow_status: 'archived' }), linkedAreaPath: area },
    note(area), note(areaChild, undefined, undefined, 5), note(standalone), note(overview),
    note(resourceNote, {}, project), note(clip, { source: 'https://example.com' }, project),
    note(card, { tangrow_kind: 'card' }, project), note(manuscript, { tangrow_kind: 'draft' }, project)
  ];
  const tasks: WorkbenchProjectTaskSource[] = [
    { path: areaChild, line: 3, text: 'Prepare', done: false },
    { path: standalone, line: 1, text: 'Call clinic', done: false },
    { path: overview, line: 4, text: 'Area and project task', done: false, overviewLinks: [area, project, area] }
  ];
  const { projects, areas, resources, candidates } = buildWorkbenchPara(records, tasks, ['30-Area/Empty', '40-Resources/Empty'], DEFAULT_SETTINGS);
  const plan = projects.find((entry) => entry.notePath === project);
  const work = areas.find((entry) => entry.notePath === area);
  assert.ok(plan && work);
  assert.equal(plan.areaPath, work.path);
  assert.deepEqual(work.projects, [{ path: plan.path, name: 'Plan', status: 'open' }]);
  assert.equal(work.noteCount, 2);
  assert.equal(work.modified, 5);
  assert.deepEqual(work.recent.map((entry) => entry.path), [areaChild, area]);
  assert.deepEqual(work.tasks.map(({ text, sourceKind }) => [text, sourceKind]), [['Prepare', 'folder'], ['Area and project task', 'overview']]);
  assert.equal(areas.find((entry) => entry.path === standalone)?.tasks.length, 1);
  assert.equal(areas.find((entry) => entry.name === 'Empty')?.notePath, null);
  assert.deepEqual(resources.map(({ name, noteCount }) => [name, noteCount]), [['Empty', 0], ['Writing', 1]]);
  assert.deepEqual(plan.notes.map((entry) => entry.path), [manuscript]);
  assert.deepEqual(plan.references.map(({ name, role, location }) => [name, role, location]), [
    ['Source', 'material', 'Writing'], ['Clip', 'material', '00-Inbox'], ['Argument', 'card', '50-Zettel']
  ]);
  assert.equal(candidates.find((candidate) => candidate.path === manuscript)?.projectPath, plan.path);
});

test('an existing project area link keeps its canonical owner when a higher-priority note appears', () => {
  const folder = '20-Project/Plan';
  const area = '30-Area/Work.md';
  const readme = `${folder}/README.md`;
  const records = [
    note(`${folder}/Plan.md`), { ...note(readme, { tangrow_area: '[[Work]]' }), linkedAreaPath: area }, note(area),
    { ...note('20-Project/No canonical/Chapter.md'), linkedAreaPath: area }
  ];
  const { projects } = buildWorkbenchPara(records, [], [], DEFAULT_SETTINGS);
  const plan = projects.find((entry) => entry.path === folder);
  assert.equal(plan?.notePath, `${folder}/Plan.md`);
  assert.equal(plan?.areaNotePath, readme);
  assert.equal(plan?.areaPath, area);
  assert.equal(projects.find((entry) => entry.name === 'No canonical')?.areaNotePath, null);
});

test('project types come from canonical visible project notes, merge case and whitespace, and sort by usage', () => {
  const settings = { ...DEFAULT_SETTINGS, archiveFolder: '20-Project/Archive' };
  const records = [
    note('20-Project/Alpha/Alpha.md'), note('20-Project/Alpha/README.md', { tangrow_project_type: '  Writing  ' }),
    note('20-Project/Beta.md', { tangrow_project_type: 'writing' }), note('20-Project/Code.md', { tangrow_project_type: 'Code' }),
    note('20-Project/None.md', { tangrow_project_type: '  ' }), note('20-Project/Noncanonical/Chapter.md', { tangrow_project_type: 'Ignore' }),
    note('20-Project/Archive/Archive.md', { tangrow_project_type: 'Archived type' }),
    note('00-Inbox/Not a project.md', { tangrow_project_type: 'Outside' })
  ];
  const { projects, types } = buildWorkbenchPara(records, [], [], settings);
  const alpha = projects.find((project) => project.name === 'Alpha');
  assert.equal(alpha?.notePath, '20-Project/Alpha/Alpha.md');
  assert.equal(alpha?.typeNotePath, '20-Project/Alpha/README.md');
  assert.equal(alpha?.projectType, 'Writing');
  assert.equal(projects.find((project) => project.name === 'None')?.projectType, null);
  assert.equal(projects.find((project) => project.name === 'Noncanonical')?.typeNotePath, null);
  assert.deepEqual(types, [{ key: 'writing', name: 'Writing', count: 2 }, { key: 'code', name: 'Code', count: 1 }]);
  assert.equal(projectTypeKey('  Écriture '), projectTypeKey('e\u0301CRITURE'));
  assert.equal(projectTypeKey('Video  essay'), 'video  essay');
});

test('draft classification requires a draft role outside project directories and an empty project property', () => {
  const draft = { tangrow_kind: 'draft' };
  const records = [
    note('00-Inbox/No link.md', draft, undefined, 1),
    note('30-Area/Work/Blank link.md', { ...draft, tangrow_project: '   ' }, undefined, 3),
    note('00-Inbox/Unresolved link.md', { ...draft, tangrow_project: '[[Missing]]' }),
    note('00-Inbox/Existing list link.md', { ...draft, tangrow_project: ['[[Missing]]'] }),
    note('20-Project/Plan/Chapter.md', draft), note('20-Project/Old standalone draft.md', draft),
    note('00-Inbox/Ordinary note.md'), note('90-Archive/Old draft.md', draft), note('99-Tangrow/Records/Draft.md', draft)
  ];
  const { drafts } = buildWorkbenchPara(records, [], [], DEFAULT_SETTINGS);
  assert.deepEqual(drafts.map(({ path }) => path), ['30-Area/Work/Blank link.md', '00-Inbox/No link.md']);
});

test('an explicit project area clear suppresses another canonical note’s area link', () => {
  const folder = '20-Project/Plan';
  const owner = `${folder}/README.md`;
  const area = '30-Area/Work.md';
  const { projects, areas } = buildWorkbenchPara([
    note(`${folder}/Plan.md`), note(owner, { tangrow_area: null }),
    { ...note(`${folder}/Index.md`, { tangrow_area: '[[Work]]' }), linkedAreaPath: area }, note(area)
  ], [], [], DEFAULT_SETTINGS);
  assert.equal(projects[0]?.areaNotePath, owner);
  assert.equal(projects[0]?.areaPath, null);
  assert.deepEqual(areas[0]?.projects, []);
});
