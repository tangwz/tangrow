import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS } from '../src/types';
import { planOnboardingVault, suggestOnboardingVault } from '../src/settings/onboarding-vault';
import { VaultStructurePathError, type VaultPathKind } from '../src/settings/vault-structure-data';

test('onboarding recognizes the prototype Chinese PARA folders and numbered English variants', () => {
  const suggestions = suggestOnboardingVault(DEFAULT_SETTINGS, [
    '-1. 捕获', '1. 项目', '2. 领域', '3. 资源', '4. 存档', 'Knowledge/５０—Zettelkasten'
  ]);
  assert.deepEqual(suggestions, {
    inboxFolder: '-1. 捕获', projectFolder: '1. 项目', areaFolder: '2. 领域',
    resourcesFolder: '3. 资源', archiveFolder: '4. 存档', cardFolder: 'Knowledge/５０—Zettelkasten',
    taskOverviewPath: DEFAULT_SETTINGS.taskOverviewPath, supportFolder: DEFAULT_SETTINGS.supportFolder
  });
});

test('onboarding honors configured paths, retains defaults on ties, and skips inactive candidates', () => {
  const current = { ...DEFAULT_SETTINGS, projectFolder: 'Work/Active' };
  const folders = [
    'Work/Active', '01_Projects', 'Folders/Projects', 'Folders/Areas', '領域',
    'Archived/04-Archives', 'Archived/04-Archives/Cards', '99-Tangrow/Cards', 'Knowledge/Cards',
    'Archived/04-Archives/Resources'
  ];
  const forward = suggestOnboardingVault(current, folders);
  assert.deepEqual(forward, suggestOnboardingVault(current, [...folders].reverse()));
  assert.equal(forward.projectFolder, 'Work/Active');
  assert.equal(forward.areaFolder, current.areaFolder);
  assert.equal(forward.archiveFolder, 'Archived/04-Archives');
  assert.equal(forward.cardFolder, 'Knowledge/Cards');
  assert.equal(forward.resourcesFolder, current.resourcesFolder);
});

test('onboarding plans missing folders while keeping Tasks and companion paths out of the editable mapping', () => {
  const plan = planOnboardingVault(DEFAULT_SETTINGS, {
    inboxFolder: ' Work/Captures/ ', taskOverviewPath: 'Different.md', supportFolder: 'Different companion'
  }, () => 'missing', true);
  assert.equal(plan.settings.inboxFolder, 'Work/Captures');
  assert.equal(plan.settings.taskOverviewPath, DEFAULT_SETTINGS.taskOverviewPath);
  assert.equal(plan.settings.supportFolder, DEFAULT_SETTINGS.supportFolder);
  assert.ok(plan.folders.includes(DEFAULT_SETTINGS.supportFolder));
  assert.ok(!plan.folders.includes(DEFAULT_SETTINGS.journalFolder));
  assert.ok(!plan.folders.includes(DEFAULT_SETTINGS.taskOverviewPath));
});

test('onboarding checks blocked unchanged paths and validates companion safety before creation', () => {
  const kindAt = (path: string): VaultPathKind => path === 'Blocked' ? 'markdown' : 'missing';
  assert.throws(() => planOnboardingVault({ ...DEFAULT_SETTINGS, cardFolder: 'Blocked/Cards' }, {}, kindAt, false),
    (error) => error instanceof VaultStructurePathError && error.key === 'cardFolder');
  assert.throws(() => planOnboardingVault({ ...DEFAULT_SETTINGS, supportFolder: 'Blocked/Companion' }, {}, kindAt, true),
    (error) => error instanceof VaultStructurePathError && error.key === 'supportFolder');
  assert.throws(() => planOnboardingVault(DEFAULT_SETTINGS, { projectFolder: '99-Tangrow/Projects' }, kindAt, false),
    /must not equal or contain/);
  assert.doesNotThrow(() => planOnboardingVault({ ...DEFAULT_SETTINGS, supportFolder: 'Blocked/Companion' }, {}, kindAt, false));
});
