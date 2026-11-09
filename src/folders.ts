import { inFolder, safeFolder } from './model';
import type { Settings } from './types';

export const CONTENT_FOLDER_KEYS = ['inboxFolder', 'projectFolder', 'areaFolder', 'resourcesFolder', 'archiveFolder', 'journalFolder'] as const;

export type ContentFolderSettingKey = typeof CONTENT_FOLDER_KEYS[number];
export type FolderSettingKey = 'supportFolder' | ContentFolderSettingKey;
export type FolderSettings = Pick<Settings, FolderSettingKey>;

export class SupportFolderConflictError extends Error {
  constructor(
    readonly supportFolder: string,
    readonly contentKey: ContentFolderSettingKey,
    readonly contentFolder: string
  ) {
    super('The companion folder must not equal or contain a content folder.');
    this.name = 'SupportFolderConflictError';
  }
}

function portableCollisionKey(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

export function validateFolderSettings(settings: FolderSettings): void {
  const supportFolder = safeFolder(settings.supportFolder);
  const supportKey = portableCollisionKey(supportFolder);
  for (const key of CONTENT_FOLDER_KEYS) {
    const contentFolder = safeFolder(settings[key]);
    const contentKey = portableCollisionKey(contentFolder);
    // Content may contain a dedicated support subfolder; the reverse hides user notes.
    // Compare portable aliases without changing the user's stored path spelling.
    if (contentKey === supportKey || inFolder(contentKey, supportKey)) {
      throw new SupportFolderConflictError(supportFolder, key, contentFolder);
    }
  }
}

export function hasValidSupportFolder(settings: FolderSettings): boolean {
  try {
    validateFolderSettings(settings);
    return true;
  } catch {
    return false;
  }
}
