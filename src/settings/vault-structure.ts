import { TFile, TFolder, type App } from 'obsidian';
import { SupportFolderConflictError } from '../folders';
import type TangrowPlugin from '../main';
import { safeFolder } from '../model';
import { inspectVaultStructurePath, PARA_FOLDER_KEYS, VAULT_STRUCTURE_KEYS, VaultStructurePathError, vaultStructureValues,
  type VaultDirectoryMode, type VaultPathInspection, type VaultPathKind, type VaultStructureKey, type VaultStructurePatch,
  type VaultStructureValues } from './vault-structure-data';

const ROLE: Record<VaultStructureKey, readonly [string, string]> = {
  inboxFolder: ['Inbox', 'Where captures wait'],
  projectFolder: ['Projects', 'Actions with a goal and an end'],
  areaFolder: ['Areas', 'Ongoing responsibilities'],
  resourcesFolder: ['Resources', 'Reference kept by topic'],
  archiveFolder: ['Archive', 'Inactive items'],
  cardFolder: ['Card folder', 'Where cards live'],
  taskOverviewPath: ['Task overview note', 'Existing Tasks note'],
  supportFolder: ['Companion folder', 'Bases, focus and habit records']
};

export const VAULT_PATH_STATUS_LABELS: Record<VaultPathInspection['status'], string> = {
  found: 'Found', missing: 'Missing', 'wrong-type': 'Wrong path type', blocked: 'Blocked path', invalid: 'Invalid path', 'will-create': 'Will create'
};

export function vaultPathKind(app: App, path: string): VaultPathKind {
  const item = app.vault.getAbstractFileByPath(path);
  if (item instanceof TFolder) return 'folder';
  if (item instanceof TFile && item.extension === 'md') return 'markdown';
  return item ? 'other' : 'missing';
}

export function vaultPathSuggestions(app: App, kind: 'folder' | 'markdown'): string[] {
  const entries = kind === 'folder' ? app.vault.getAllFolders() : app.vault.getMarkdownFiles();
  return entries.map((entry) => entry.path).filter((path) => {
    try { return safeFolder(path) === path; } catch { return false; }
  }).sort((left, right) => left.localeCompare(right));
}

interface VaultStructureFieldsOptions {
  values: VaultStructureValues;
  keys?: readonly VaultStructureKey[];
  directoryMode?: VaultDirectoryMode;
  onChange?: () => void;
}

export function renderVaultStructureFields(
  parent: HTMLElement, host: Pick<TangrowPlugin, 'app' | 't'>, options: VaultStructureFieldsOptions
) {
  const t = host.t.bind(host);
  const form = parent.createDiv({ cls: 'tangrow-vault-structure-fields' });
  const instance = `tangrow-vault-structure-${crypto.randomUUID()}`;
  const keys = new Set(options.keys ?? VAULT_STRUCTURE_KEYS);
  const values = vaultStructureValues(options.values);
  const controls = new Map<VaultStructureKey, { input: HTMLInputElement; status: HTMLElement; error: HTMLElement }>();
  const lists = new Map<'folder' | 'markdown', HTMLDataListElement>();
  const listed = new Map<'folder' | 'markdown', string>();

  const syncStatus = (key: VaultStructureKey): void => {
    const control = controls.get(key);
    if (!control) return;
    const result = inspectVaultStructurePath(key, control.input.value, (path) => vaultPathKind(host.app, path), options.directoryMode);
    const status = t(VAULT_PATH_STATUS_LABELS[result.status]);
    if (control.status.textContent !== status) control.status.textContent = status;
    control.status.dataset.pathStatus = result.status;
    const invalid = result.status === 'invalid' || result.status === 'wrong-type' || result.status === 'blocked' || !!control.error.textContent;
    control.input.setAttribute('aria-invalid', String(invalid));
  };

  const addGroup = (label: string, groupKeys: readonly VaultStructureKey[]): void => {
    const selected = groupKeys.filter((key) => keys.has(key));
    if (!selected.length) return;
    const section = form.createEl('section', { cls: 'tangrow-vault-structure-group' });
    section.createEl('h3', { text: label });
    for (const key of selected) {
      const [name, detail] = ROLE[key];
      const id = `${instance}-${key}`;
      const group = key === 'taskOverviewPath' ? 'markdown' : 'folder';
      const listId = `${instance}-${group}`;
      if (!lists.has(group)) lists.set(group, form.createEl('datalist', { attr: { id: listId } }));
      const row = section.createDiv({ cls: 'tangrow-vault-structure-role', attr: { tabindex: '-1' } });
      row.dataset.settingId = key;
      const role = row.createDiv({ cls: 'tangrow-vault-structure-name' });
      role.createEl('label', { text: t(name), attr: { for: id } });
      role.createSpan({ cls: 'setting-item-description', text: t(detail) });
      const input = row.createEl('input', { type: 'text', value: values[key], attr: {
        id, list: listId, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-status ${id}-error`
      } });
      const status = row.createSpan({ cls: 'tangrow-vault-structure-status', attr: { id: `${id}-status`, role: 'status' } });
      const error = row.createDiv({ cls: 'tangrow-vault-structure-error', attr: { id: `${id}-error`, role: 'alert' } });
      controls.set(key, { input, status, error });
      input.oninput = () => {
        error.textContent = '';
        syncStatus(key);
        options.onChange?.();
      };
    }
  };

  const refresh = (): void => {
    for (const [kind, list] of lists) {
      const paths = vaultPathSuggestions(host.app, kind);
      const signature = JSON.stringify(paths);
      if (listed.get(kind) === signature) continue;
      listed.set(kind, signature);
      list.empty();
      for (const path of paths) list.createEl('option', { attr: { value: path } });
    }
    for (const key of controls.keys()) syncStatus(key);
  };

  addGroup('PARA', PARA_FOLDER_KEYS);
  addGroup(t('Used by Tangrow'), ['cardFolder', 'taskOverviewPath', 'supportFolder']);
  refresh();
  return {
    values(): VaultStructureValues {
      const next = { ...values };
      for (const [key, { input }] of controls) next[key] = input.value;
      return next;
    },
    setValues(next: VaultStructureValues): void {
      Object.assign(values, next);
      for (const [key, { input, error }] of controls) {
        if (input.value === next[key]) continue;
        input.value = next[key];
        error.textContent = '';
        syncStatus(key);
      }
    },
    refresh,
    setReadOnly(readOnly: boolean): void {
      for (const { input } of controls.values()) input.readOnly = readOnly;
    },
    setError(key: VaultStructureKey, message: string, focus = false): void {
      const control = controls.get(key);
      if (!control) return;
      control.error.textContent = message;
      syncStatus(key);
      if (focus) control.input.focus();
    },
    dispose(): void { for (const { input } of controls.values()) input.oninput = null; }
  };
}

export function renderVaultStructure(
  parent: HTMLElement, plugin: Pick<TangrowPlugin, 'app' | 't' | 'error' | 'settings' | 'updateVaultStructure'>, canEdit: () => boolean
): { refresh(): void; dispose(): void } {
  const t = plugin.t.bind(plugin);
  const section = parent.createDiv({ cls: 'tangrow-vault-structure' });
  section.createEl('p', { cls: 'setting-item-description', text: t('Your folders stay in place. These paths tell the companion where to read and where to add new files.') });
  let baseline = vaultStructureValues(plugin.settings);
  let saving = false;
  let disposed = false;
  const fields = renderVaultStructureFields(section, plugin, { values: baseline, onChange: () => { feedback.textContent = ''; updateActions(); } });
  const feedback = section.createEl('p', { cls: 'tangrow-vault-structure-feedback', attr: { role: 'status' } });
  const actions = section.createDiv({ cls: 'tangrow-vault-structure-actions' });
  const dirty = actions.createSpan({ cls: 'setting-item-description' });
  const discard = actions.createEl('button', { type: 'button', text: t('Discard changes') });
  const save = actions.createEl('button', { type: 'button', text: t('Save changes'), cls: 'mod-cta' });

  function patch(): VaultStructurePatch {
    const values = fields.values();
    return Object.fromEntries(VAULT_STRUCTURE_KEYS.filter((key) => values[key] !== baseline[key]).map((key) => [key, values[key]]));
  }
  function updateActions(): void {
    const count = Object.keys(patch()).length;
    actions.hidden = count === 0 && !saving;
    dirty.textContent = t(count === 1 ? '1 unsaved change' : '{count} unsaved changes', { count });
    discard.disabled = save.disabled = !count || saving || !canEdit();
    fields.setReadOnly(saving);
  }
  function refresh(): void {
    if (disposed) return;
    if (!saving) {
      const current = vaultStructureValues(plugin.settings);
      const values = fields.values();
      for (const key of VAULT_STRUCTURE_KEYS) if (values[key] === baseline[key]) values[key] = current[key];
      baseline = current;
      fields.setValues(values);
    }
    fields.refresh();
    updateActions();
  }
  discard.onclick = () => {
    if (disposed || saving || !canEdit()) return;
    baseline = vaultStructureValues(plugin.settings);
    fields.setValues(baseline);
    for (const key of VAULT_STRUCTURE_KEYS) fields.setError(key, '');
    feedback.textContent = '';
    updateActions();
  };
  save.onclick = async () => {
    if (disposed || saving || !canEdit()) return;
    const changes = patch();
    if (!Object.keys(changes).length) return;
    saving = true;
    for (const key of VAULT_STRUCTURE_KEYS) fields.setError(key, '');
    feedback.textContent = '';
    feedback.removeClass('tangrow-vault-structure-error');
    updateActions();
    try {
      await plugin.updateVaultStructure(changes);
      if (disposed) return;
      baseline = vaultStructureValues(plugin.settings);
      fields.setValues(baseline);
      feedback.textContent = t('Vault structure saved. Existing Bases keep their current filters.');
    } catch (error) {
      if (disposed) return;
      if (error instanceof VaultStructurePathError) fields.setError(error.key, plugin.error(error), true);
      else if (error instanceof SupportFolderConflictError) fields.setError('supportFolder', plugin.error(error), true);
      else {
        feedback.textContent = plugin.error(error);
        feedback.addClass('tangrow-vault-structure-error');
      }
    } finally {
      saving = false;
      refresh();
    }
  };
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      fields.dispose();
      discard.onclick = save.onclick = null;
    }
  };
}
