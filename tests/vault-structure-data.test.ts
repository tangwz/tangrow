import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectVaultStructurePath, validateVaultStructure, VaultStructurePathError, type VaultPathKind } from '../src/settings/vault-structure-data';
import { DEFAULT_SETTINGS } from '../src/types';

function lookup(entries: Record<string, VaultPathKind>) {
  return (path: string): VaultPathKind => entries[path] ?? 'missing';
}

test('a vault-structure save checks changed folder and Tasks paths while retaining untouched defaults', () => {
  const kindAt = lookup({ Work: 'folder', 'Work/Tasks.md': 'markdown', 'Work/Guide.pdf': 'other' });
  const changed = validateVaultStructure(DEFAULT_SETTINGS, { projectFolder: ' Work/ ', taskOverviewPath: 'Work\\Tasks.md' }, kindAt);
  assert.equal(changed.projectFolder, 'Work');
  assert.equal(changed.taskOverviewPath, 'Work/Tasks.md');
  assert.equal(changed.archiveFolder, DEFAULT_SETTINGS.archiveFolder);
  assert.equal(changed.supportFolder, DEFAULT_SETTINGS.supportFolder);
  assert.throws(() => validateVaultStructure(DEFAULT_SETTINGS, { projectFolder: 'Work/Tasks.md' }, kindAt),
    (error: unknown) => error instanceof VaultStructurePathError && error.key === 'projectFolder');
  for (const taskOverviewPath of ['Work', 'Work/Guide.pdf', 'Work/Missing.md']) {
    assert.throws(() => validateVaultStructure(DEFAULT_SETTINGS, { taskOverviewPath }, kindAt),
      (error: unknown) => error instanceof VaultStructurePathError && error.key === 'taskOverviewPath');
  }
});

test('vault-structure validation checks the final companion/content combination and rejects invalid path syntax', () => {
  const kindAt = lookup({ '99-Tangrow/Projects': 'folder', 'System/New companion': 'folder' });
  assert.throws(() => validateVaultStructure(DEFAULT_SETTINGS, { projectFolder: '99-Tangrow/Projects' }, kindAt), /must not equal or contain/);
  const candidate = validateVaultStructure(DEFAULT_SETTINGS, { projectFolder: '99-Tangrow/Projects', supportFolder: 'System/New companion' }, kindAt);
  assert.equal(candidate.projectFolder, '99-Tangrow/Projects');
  assert.equal(candidate.supportFolder, 'System/New companion');
  for (const path of ['', '../Outside', '/Absolute']) {
    assert.throws(() => validateVaultStructure(DEFAULT_SETTINGS, { archiveFolder: path }, kindAt),
      (error: unknown) => error instanceof VaultStructurePathError && error.key === 'archiveFolder');
  }
});

test('optional directory planning permits missing folders only when their ancestors are usable', () => {
  const kindAt = lookup({ 'Occupied.md': 'markdown', Existing: 'folder' });
  assert.deepEqual(inspectVaultStructurePath('inboxFolder', 'Existing/New', kindAt), { path: 'Existing/New', status: 'missing' });
  assert.deepEqual(inspectVaultStructurePath('inboxFolder', 'Existing/New', kindAt, 'allow-missing-folders'), { path: 'Existing/New', status: 'will-create' });
  assert.deepEqual(inspectVaultStructurePath('inboxFolder', 'Occupied.md/New', kindAt, 'allow-missing-folders'), { path: 'Occupied.md/New', status: 'blocked' });
  assert.deepEqual(inspectVaultStructurePath('taskOverviewPath', 'Existing/New.md', kindAt, 'allow-missing-folders'), { path: 'Existing/New.md', status: 'missing' });
  assert.equal(validateVaultStructure(DEFAULT_SETTINGS, { inboxFolder: 'Existing/New' }, kindAt, 'allow-missing-folders').inboxFolder, 'Existing/New');
});
