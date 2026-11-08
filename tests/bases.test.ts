import assert from 'node:assert/strict';
import test from 'node:test';
import { baseDefinitions, setupReadme } from '../src/bases';
import { DEFAULT_SETTINGS } from '../src/types';

function filters(content: string): string[] {
  return content.split('\n')
    .filter((line) => line.startsWith('    - '))
    .map((line) => JSON.parse(line.slice(6)) as string);
}

test('all database definitions restrict files to Markdown and have unique stable names', () => {
  const bases = baseDefinitions(DEFAULT_SETTINGS);
  assert.equal(bases.length, 13);
  assert.equal(new Set(bases.map((base) => base.id)).size, bases.length);
  assert.equal(new Set(bases.map((base) => base.filename)).size, bases.length);
  for (const base of bases) {
    assert.equal(filters(base.content)[0], 'file.ext == "md"');
    assert.match(base.content, /views:\n  - type: table/);
    assert.ok(base.filename.endsWith('.base'));
  }
});

test('folder expressions preserve quoted paths through YAML and expression escaping', () => {
  const folder = 'Projects/Research "A"/Back\\slash';
  const bases = baseDefinitions({ ...DEFAULT_SETTINGS, projectFolder: folder, supportFolder: 'Meta/"Tangrow"' });
  const project = bases.find((base) => base.id === 'projects');
  const notes = bases.find((base) => base.id === 'notes');
  assert.ok(project);
  assert.ok(notes);
  assert.ok(filters(project.content).includes(`file.inFolder(${JSON.stringify(folder)})`));
  assert.ok(filters(notes.content).includes(`!file.inFolder(${JSON.stringify('Meta/"Tangrow"')})`));
});

test('existing project and source conventions do not require metadata migrations', () => {
  const bases = baseDefinitions(DEFAULT_SETTINGS);
  const project = bases.find((base) => base.id === 'projects')!;
  assert.ok(filters(project.content).includes('file.inFolder("20-Project")'));
  assert.ok(!project.content.includes('note.status'));
  assert.ok(!project.content.includes('note.type'));
  const source = bases.find((base) => base.id === 'sources')!;
  assert.ok(source.content.includes('note.source'));
  const task = bases.find((base) => base.id === 'tasks')!;
  assert.match(task.description, /Body checkboxes/);
  assert.ok(filters(task.content).some((filter) => filter.includes('file.hasTag("task")')));
});

test('support README documents additive storage and body-task boundary', () => {
  const readme = setupReadme(DEFAULT_SETTINGS);
  assert.match(readme, /00-Inbox/);
  assert.match(readme, /never overwritten/);
  assert.match(readme, /not individual checkboxes/);
  for (const base of baseDefinitions(DEFAULT_SETTINGS)) assert.ok(readme.includes(base.filename));
});
