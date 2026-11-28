import { validateFolderSettings } from '../folders';
import { inFolder, safeFolder } from '../model';
import type { Settings } from '../types';
import {
  inspectVaultStructurePath, PARA_FOLDER_KEYS, VaultStructurePathError, vaultStructureValues,
  type VaultPathLookup, type VaultStructurePatch, type VaultStructureValues
} from './vault-structure-data';

export const ONBOARDING_FOLDER_KEYS = [...PARA_FOLDER_KEYS, 'cardFolder'] as const;
type OnboardingFolderKey = typeof ONBOARDING_FOLDER_KEYS[number];

const FOLDER_NAMES: Record<OnboardingFolderKey, readonly string[]> = {
  inboxFolder: ['inbox', 'capture', 'captures', '收件箱', '捕获', '捕獲', '速记', '速記'],
  projectFolder: ['project', 'projects', '项目', '項目', '專案', '专案'],
  areaFolder: ['area', 'areas', '领域', '領域'],
  resourcesFolder: ['resource', 'resources', '资源', '資源'],
  archiveFolder: ['archive', 'archives', '归档', '歸檔', '存档', '存檔'],
  cardFolder: ['card', 'cards', 'zettel', 'zettelkasten', '卡片', '卡片盒', '卡片笔记', '卡片筆記']
};

function folderName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).normalize('NFKC').trim().toLowerCase()
    .replace(/^[+-]?\d+[\s._\-–—、]+/u, '');
}

export function suggestOnboardingVault(settings: Settings, existingFolders: readonly string[]): VaultStructureValues {
  const values = vaultStructureValues(settings);
  const folders = [...new Set(existingFolders)].filter((path) => {
    try { return path === safeFolder(path); }
    catch { return false; }
  });
  // Exclude recognized archive branches and the companion folder from new guesses.
  const archives = folders.filter((path) => FOLDER_NAMES.archiveFolder.includes(folderName(path)));
  archives.push(settings.archiveFolder);
  for (const key of ONBOARDING_FOLDER_KEYS) {
    if (folders.includes(settings[key])) continue;
    const candidates = folders.filter((path) => FOLDER_NAMES[key].includes(folderName(path))
      && path !== settings.supportFolder && !inFolder(path, settings.supportFolder)
      && (key === 'archiveFolder' || !archives.some((archive) => inFolder(path, archive))));
    if (candidates.length === 1 && candidates[0]) values[key] = candidates[0];
  }
  return values;
}

export function planOnboardingVault(
  current: Settings, patch: VaultStructurePatch, kindAt: VaultPathLookup, createBases: boolean
): { settings: Settings; folders: string[] } {
  const settings = { ...current };
  const folders = new Set<string>();
  const keys = createBases ? [...ONBOARDING_FOLDER_KEYS, 'supportFolder' as const] : ONBOARDING_FOLDER_KEYS;
  for (const key of keys) {
    const raw = key === 'supportFolder' ? current[key] : patch[key] ?? current[key];
    const inspected = inspectVaultStructurePath(key, raw, kindAt, 'allow-missing-folders');
    if (inspected.status === 'invalid') throw new VaultStructurePathError(key, inspected.error);
    if (inspected.status !== 'found' && inspected.status !== 'will-create') {
      throw new VaultStructurePathError(key, 'A file blocks this folder path.');
    }
    if (key !== 'supportFolder') settings[key] = inspected.path;
    folders.add(inspected.path);
  }
  validateFolderSettings(settings);
  return { settings, folders: [...folders] };
}
