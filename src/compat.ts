import type { App, TFile } from 'obsidian';

type SettingsAccess = { open: () => void; openTabById: (id: string) => void };
type CommandAccess = { commands: Record<string, unknown>; executeCommandById: (id: string) => boolean };

// These optional host features are not part of the published API. Keep them isolated.
export function openNativeSettings(app: App, tab: string): boolean {
  const settings = (app as unknown as { setting?: Partial<SettingsAccess> }).setting;
  if (typeof settings?.open !== 'function' || typeof settings.openTabById !== 'function') return false;
  try { settings.open(); settings.openTabById(tab); return true; } catch { return false; }
}

export function runNativeCommand(app: App, ids: readonly string[]): boolean {
  const access = (app as unknown as { commands?: Partial<CommandAccess> }).commands;
  if (!access?.commands || typeof access.executeCommandById !== 'function') return false;
  for (const id of ids) {
    if (!Object.hasOwn(access.commands, id)) continue;
    try { if (access.executeCommandById(id)) return true; } catch { return false; }
  }
  return false;
}

export async function revealInFileList(app: App, file: TFile): Promise<boolean> {
  const leaf = await app.workspace.ensureSideLeaf('file-explorer', 'left', { active: false });
  const view = leaf.view as unknown as { revealInFolder?: (file: TFile) => Promise<void> | void };
  if (typeof view.revealInFolder !== 'function') return false;
  try { await view.revealInFolder(file); return true; } catch { return false; }
}
