import { TFile, TFolder, parseYaml, type App } from 'obsidian';
import { baseDefinitions, setupReadme } from './bases';
import { validateFolderSettings } from './folders';
import { matchesGeneratedContent } from './managed-files';
import { safeFolder } from './model';
import type { Settings } from './types';

export interface SupportMigrationResult {
  moved: boolean;
  preservedFiles: string[];
}

function managedContents(settings: Settings): Map<string, string> {
  return new Map([
    ...baseDefinitions(settings).map((definition) => [definition.filename, definition.content] as const),
    ['README.md', setupReadme(settings)]
  ]);
}

function normalizeReadmeLinks(content: string, filenames: ReadonlySet<string>, folders: readonly string[]): string {
  return content.replace(/\[\[([^\]|\n]+)(\|[^\]\n]*)?\]\]/g, (link: string, target: string, alias = '') => {
    const filename = [...filenames].find((name) => target === name || folders.some((folder) => target === `${folder}/${name}`));
    return filename ? `[[${filename}${alias}]]` : link;
  });
}

function rewriteGeneratedContent(filename: string, content: string, from: string, to: string, filenames: ReadonlySet<string>, folders: readonly string[]): string | undefined {
  if (filename !== 'README.md') return matchesGeneratedContent(filename, content, from, parseYaml) ? to : undefined;
  if (normalizeReadmeLinks(content, filenames, folders) !== from) return undefined;
  const before = from.split('\n');
  const after = to.split('\n');
  // Keep links rewritten by the host while updating only changed generated lines.
  return content.split('\n').map((line, index) => before[index] === after[index] ? line : after[index]!).join('\n');
}

export async function moveSupportFolder(app: App, settings: Settings, destination: string, persist: () => Promise<void>): Promise<SupportMigrationResult> {
  const previous = settings.supportFolder;
  const target = safeFolder(destination);
  validateFolderSettings(settings);
  validateFolderSettings({ ...settings, supportFolder: target });
  if (target === previous) return { moved: false, preservedFiles: [] };
  if (target.startsWith(`${previous}/`) || previous.startsWith(`${target}/`)) {
    throw new Error('The new companion folder must not contain or be inside the current companion folder.');
  }
  if (app.vault.getAbstractFileByPath(target)) throw new Error('The new companion folder already exists. No files were moved.');
  const source = app.vault.getAbstractFileByPath(previous);
  if (source && !(source instanceof TFolder)) throw new Error('The current companion path is not a folder.');
  const oldContents = managedContents(settings);
  const nextContents = managedContents({ ...settings, supportFolder: target });
  const filenames = new Set(oldContents.keys());
  const folders = [previous, target];
  const plans: Array<{ file: TFile; filename: string; original: string; before: string; after: string }> = [];
  const preservedFiles = new Set<string>();
  for (const [filename, expected] of oldContents) {
    const file = app.vault.getAbstractFileByPath(`${previous}/${filename}`);
    if (!(file instanceof TFile)) continue;
    const original = await app.vault.cachedRead(file);
    if (rewriteGeneratedContent(filename, original, expected, expected, filenames, folders) === undefined) preservedFiles.add(filename);
    else plans.push({ file, filename, original, before: expected, after: nextContents.get(filename)! });
  }
  let moved = false;
  let configurationChanged = false;
  try {
    if (source) {
      await app.fileManager.renameFile(source, target);
      moved = true;
      for (const plan of plans) {
        await app.vault.process(plan.file, (content) => {
          const next = rewriteGeneratedContent(plan.filename, content, plan.before, plan.after, filenames, folders);
          if (next === undefined) preservedFiles.add(plan.filename);
          return next ?? content;
        });
      }
    }
    configurationChanged = true;
    settings.supportFolder = target;
    await persist();
    return { moved, preservedFiles: [...preservedFiles] };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    // renameFile can move the directory before its link-update phase rejects.
    if (source && (source.path === target || app.vault.getAbstractFileByPath(target) === source)) {
      try {
        const occupied = app.vault.getAbstractFileByPath(previous);
        if (occupied && occupied !== source) throw new Error('The original companion path is now occupied. Existing files were preserved.');
        await app.fileManager.renameFile(source, previous);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    settings.supportFolder = source?.path ?? previous;
    const finalContents = managedContents(settings);
    for (const plan of plans) {
      try {
        await app.vault.process(plan.file, (content) => {
          const desired = settings.supportFolder === previous && plan.filename !== 'README.md' ? plan.original : finalContents.get(plan.filename)!;
          // Concurrent user changes remain untouched at either final location.
          return rewriteGeneratedContent(plan.filename, content, plan.after, desired, filenames, [...folders, settings.supportFolder])
            ?? rewriteGeneratedContent(plan.filename, content, plan.before, desired, filenames, [...folders, settings.supportFolder])
            ?? content;
        });
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (configurationChanged || settings.supportFolder !== previous) {
      try { await persist(); } catch (persistError) { rollbackErrors.push(persistError); }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'The companion folder migration failed and could not be fully rolled back. Check the folder paths before retrying.');
    throw error;
  }
}
