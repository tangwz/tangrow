import { validateFolderSettings } from '../folders';
import { safeFolder } from '../model';
import type { Settings } from '../types';

export const PARA_FOLDER_KEYS = ['inboxFolder', 'projectFolder', 'areaFolder', 'resourcesFolder', 'archiveFolder'] as const;
export const VAULT_STRUCTURE_KEYS = [...PARA_FOLDER_KEYS, 'cardFolder', 'taskOverviewPath', 'supportFolder'] as const;
export type VaultStructureKey = typeof VAULT_STRUCTURE_KEYS[number];
export type VaultStructureValues = Pick<Settings, VaultStructureKey>;
export type VaultStructurePatch = Partial<VaultStructureValues>;
export type VaultPathKind = 'folder' | 'markdown' | 'other' | 'missing';
export type VaultPathLookup = (path: string) => VaultPathKind;
export type VaultDirectoryMode = 'existing' | 'allow-missing-folders';

export type VaultPathInspection =
  | { path: null; status: 'invalid'; error: string }
  | { path: string; status: 'found' | 'missing' | 'wrong-type' | 'blocked' | 'will-create' };

export class VaultStructurePathError extends Error {
  constructor(readonly key: VaultStructureKey, message: string) {
    super(message);
    this.name = 'VaultStructurePathError';
  }
}

export function vaultStructureValues(settings: VaultStructureValues): VaultStructureValues {
  const { inboxFolder, projectFolder, areaFolder, resourcesFolder, archiveFolder, cardFolder, taskOverviewPath, supportFolder } = settings;
  return { inboxFolder, projectFolder, areaFolder, resourcesFolder, archiveFolder, cardFolder, taskOverviewPath, supportFolder };
}

export function inspectVaultStructurePath(
  key: VaultStructureKey | 'journalFolder', raw: string, kindAt: VaultPathLookup, mode: VaultDirectoryMode = 'existing'
): VaultPathInspection {
  let path: string;
  try { path = safeFolder(raw); }
  catch (error) { return { path: null, status: 'invalid', error: error instanceof Error ? error.message : String(error) }; }

  const kind = kindAt(path);
  const expected = key === 'taskOverviewPath' ? 'markdown' : 'folder';
  if (kind === expected) return { path, status: 'found' };
  if (kind !== 'missing') return { path, status: 'wrong-type' };
  if (mode === 'existing' || expected === 'markdown') return { path, status: 'missing' };
  const segments = path.split('/');
  for (let length = 1; length < segments.length; length++) {
    const parent = kindAt(segments.slice(0, length).join('/'));
    if (parent !== 'folder' && parent !== 'missing') return { path, status: 'blocked' };
  }
  return { path, status: 'will-create' };
}

/** Check the normalized candidate and keep untouched paths, including uncreated defaults. */
export function validateVaultStructure(
  current: Settings, patch: VaultStructurePatch, kindAt: VaultPathLookup, mode: VaultDirectoryMode = 'existing'
): Settings {
  const next = { ...current };
  for (const key of VAULT_STRUCTURE_KEYS) {
    const raw = patch[key];
    if (raw === undefined || raw === current[key]) continue;
    const inspected = inspectVaultStructurePath(key, raw, kindAt, mode);
    if (inspected.status === 'invalid') throw new VaultStructurePathError(key, inspected.error);
    if (inspected.path === current[key]) continue;
    if (inspected.status !== 'found' && inspected.status !== 'will-create') {
      const message = key === 'taskOverviewPath' ? 'Set an existing Tasks note path in Tangrow settings.'
        : inspected.status === 'blocked' ? 'A file blocks this folder path.' : 'Choose an existing folder.';
      throw new VaultStructurePathError(key, message);
    }
    next[key] = inspected.path;
  }
  validateFolderSettings(next);
  return next;
}
