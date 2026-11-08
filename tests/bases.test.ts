import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { baseDefinitions, managedFileTranslations, setupReadme } from '../src/bases';
import chinese from '../src/locales/bases.zh-CN.json';
import { DEFAULT_SETTINGS, type Settings } from '../src/types';

const EN_SETTINGS: Settings = { ...DEFAULT_SETTINGS, language: 'en' };

function filters(content: string): string[] {
  return content.split('\n')
    .filter((line) => line.startsWith('    - '))
    .map((line) => JSON.parse(line.slice(6)) as string);
}

test('all database definitions restrict files to Markdown and have unique stable names', () => {
  const bases = baseDefinitions(EN_SETTINGS);
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
  const bases = baseDefinitions({ ...EN_SETTINGS, projectFolder: folder, supportFolder: 'Meta/"Tangrow"' });
  const project = bases.find((base) => base.id === 'projects');
  const notes = bases.find((base) => base.id === 'notes');
  assert.ok(project);
  assert.ok(notes);
  assert.ok(filters(project.content).includes(`file.inFolder(${JSON.stringify(folder)})`));
  assert.ok(filters(notes.content).includes(`!file.inFolder(${JSON.stringify('Meta/"Tangrow"')})`));
});

test('existing project and source conventions do not require metadata migrations', () => {
  const bases = baseDefinitions(EN_SETTINGS);
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
  const readme = setupReadme(EN_SETTINGS);
  assert.match(readme, /00-Inbox/);
  assert.match(readme, /never overwritten/);
  assert.match(readme, /not individual checkboxes/);
  for (const base of baseDefinitions(EN_SETTINGS)) assert.ok(readme.includes(base.filename));
});

const LEGACY_ENGLISH_HASHES: Record<string, string> = {
  'Tangrow Notes.base': '4225d665eee65a54b609fb0c1584cffb772cd7e1ae0b431af8f4ecfdc8c59004',
  'Tangrow Recent.base': '6eadcd0eb6e960b5e4ac641926cdeedb704f53160a24ef44091c97cf5f3a9c7f',
  'Tangrow Projects.base': 'c2105f414c2f059ae0f053e8227ba5f12d31788da567f4c6dfca715c805293dc',
  'Tangrow Areas.base': '515dea26f90352b398b1b2122043e5c893a1e8c0eef23433f4bcc53c9f6e58c2',
  'Tangrow Resources.base': '966aa1206cd924c70cddf227892731166dd8c556d683cfc8edbca1ec2c28a245',
  'Tangrow Inbox.base': '18a1a6592384693e6dc0f5a660b347b5245d03cda0b09bdfd1c0500bc43084d7',
  'Tangrow Sources.base': '3eb6ed7897a8edd96618e24d80601fe076c708da66d4d02aa85487593a62139b',
  'Tangrow Captures.base': '314fc4a1411db0b6f8fed4cffff924f45f6efe68fcce8cbfc95e953db6db2ab3',
  'Tangrow Pins.base': '4a58b1524b337bc283620f1cca0185896ff6200d807cd0a88195e81b25383ae7',
  'Tangrow Drafts.base': '574af633d22cb977586bc919ed4f54bcbb87521fbc1dfb6fbd854b851f87e7ac',
  'Tangrow Focus.base': '88b1ff90a2c1f452148836dc47cb0cd9126ec83cc3685b7fd81477f5a300357d',
  'Tangrow Habits.base': 'fbfb166c5192e77d1d1a9d5dabdfc1c5f104e1023ed501e493f8f9a8138843b3',
  'Tangrow Task notes.base': '29c9f11d1cc9a09d05cdbfea39437bc044374338b93d0f13f379215c090257ae',
  'README.md': '9d82b8560f435fcd57ed8be5bbfa17a8f244b43975e8aa10e409d237f225af31'
};

test('English managed output remains byte-for-byte compatible with the initial release', () => {
  const files = [
    ...baseDefinitions(EN_SETTINGS).map((base) => ({ filename: base.filename, content: base.content })),
    { filename: 'README.md', content: setupReadme(EN_SETTINGS) }
  ];
  assert.deepEqual(files.map((file) => file.filename).sort(), Object.keys(LEGACY_ENGLISH_HASHES).sort());
  for (const file of files) {
    assert.equal(createHash('sha256').update(file.content).digest('hex'), LEGACY_ENGLISH_HASHES[file.filename], file.filename);
  }
});

function withoutPresentation(content: string): string {
  return content.split('\n').filter((line) => !/^    (?:displayName|name): /.test(line)).join('\n');
}

test('Chinese Bases translate presentation while retaining filenames, expressions and property keys', () => {
  const english = baseDefinitions(EN_SETTINGS);
  const localized = baseDefinitions({ ...EN_SETTINGS, language: 'zh-CN' });
  assert.equal(localized[0]?.name, chinese.Notes);
  assert.ok(localized[0]?.content.includes(`    displayName: ${JSON.stringify(chinese.Note)}`));
  assert.ok(localized[0]?.content.includes(`    name: ${JSON.stringify(chinese.Notes)}`));
  for (const [index, base] of localized.entries()) {
    const original = english[index]!;
    assert.equal(base.id, original.id);
    assert.equal(base.filename, original.filename);
    assert.match(base.description, /\p{Script=Han}/u);
    assert.deepEqual(filters(base.content), filters(original.content));
    assert.equal(withoutPresentation(base.content), withoutPresentation(original.content));
  }
});

test('Chinese README keeps stable file links with localized aliases and original folder paths', () => {
  const settings: Settings = { ...EN_SETTINGS, language: 'zh-CN' };
  const readme = setupReadme(settings);
  assert.match(readme, /\p{Script=Han}/u);
  assert.ok(readme.includes(`[[Tangrow Notes.base|${chinese.Notes}]]`));
  for (const key of ['inboxFolder', 'projectFolder', 'supportFolder'] as const) assert.ok(readme.includes(settings[key]));
  for (const base of baseDefinitions(settings)) assert.ok(readme.includes(base.filename));
});

test('translation migration plans are reversible and change only generated presentation', () => {
  const settings: Settings = { ...EN_SETTINGS, language: 'zh-CN' };
  const forward = managedFileTranslations(settings, 'en');
  const reverse = new Map(managedFileTranslations(EN_SETTINGS, 'zh-CN').map((file) => [file.filename, file]));
  assert.equal(forward.length, 14);
  assert.equal(new Set(forward.map((file) => file.filename)).size, 14);
  for (const file of forward) {
    const originalHash = createHash('sha256').update(file.previous).digest('hex');
    assert.equal(originalHash, LEGACY_ENGLISH_HASHES[file.filename]);
    assert.notEqual(file.previous, file.next);
    assert.equal(reverse.get(file.filename)?.next, file.previous);
    assert.equal(reverse.get(file.filename)?.previous, file.next);
    if (file.filename.endsWith('.base')) assert.equal(withoutPresentation(file.previous), withoutPresentation(file.next));
  }
  assert.ok(managedFileTranslations(settings, 'zh-CN').every((file) => file.previous === file.next));
});
