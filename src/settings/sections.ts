import { Notice, Setting, TFile } from 'obsidian';
import type TangrowPlugin from '../main';
import type { FolderSettingKey } from '../folders';
import { safeFolder } from '../model';
import { JOURNAL_PERIODS } from '../periodic-notes';
import { DEFAULT_SETTINGS, type Locale } from '../types';
import { AI_SUGGESTIONS, ITEMS, PERIODIC_NOTES, TEMPLATES, type SectionId } from './catalog';

export interface SettingRows {
  row(container: HTMLElement, id: string): Setting;
  text(container: HTMLElement, id: string): HTMLElement;
}

export function settingRows(plugin: TangrowPlugin, section: SectionId): SettingRows {
  const items = new Map(ITEMS.filter((item) => item.section === section).map((item) => [item.id, item]));
  const itemFor = (id: string) => {
    const item = items.get(id);
    if (!item) throw new Error(`Unknown setting in ${section}: ${id}`);
    return item;
  };
  const mark = (element: HTMLElement, id: string) => {
    element.dataset.settingId = id;
    element.tabIndex = -1;
  };
  return {
    row(container, id) {
      const item = itemFor(id);
      const row = new Setting(container).setName(plugin.t(item.name)).setDesc(plugin.t(item.description));
      mark(row.settingEl, id);
      return row;
    },
    text(container, id) {
      itemFor(id);
      const element = container.createEl('p');
      mark(element, id);
      return element;
    }
  };
}

export interface RenderedSection {
  /** Re-reads access and updates the read-only preview. */
  refresh(): void;
  /** Commits valid edits that were not saved yet, before the section is hidden or replaced. */
  dispose(): void;
}

export function renderSection(container: HTMLElement, id: Exclude<SectionId, 'activation'>, plugin: TangrowPlugin, refresh: () => void): RenderedSection {
  const t = plugin.t.bind(plugin);
  const rows = settingRows(plugin, id);
  const pending: (() => void)[] = [];
  if (id === 'guide') {
    const row = rows.row(container, 'tutorial');
    row.controlEl.createEl('a', {
      text: t('Open user guide ↗'),
      href: 'https://github.com/tangwz/tangrow#%E4%BD%BF%E7%94%A8%E6%96%B9%E5%BC%8F',
      attr: { target: '_blank', rel: 'noopener noreferrer' }
    });
    return { refresh: () => {}, dispose: () => {} };
  }
  if (id === 'purchase') {
    for (const item of ITEMS.filter((item) => item.section === id)) rows.row(container, item.id);
    return { refresh: () => {}, dispose: () => {} };
  }

  const hint = container.createEl('p', { cls: 'tangrow-settings-gate', attr: { role: 'status' } });
  const fields = container.createEl('fieldset', { cls: 'tangrow-settings-fields' });
  const updateGate = () => {
    fields.disabled = !plugin.access.canUse();
    hint.hidden = !fields.disabled;
    hint.textContent = fields.disabled ? t(plugin.access.snapshot().state === 'needs_network'
      ? 'Connect to the internet to renew access and edit local settings.'
      : 'Start a trial or activate this device to edit local settings.') : '';
  };
  const addRow = (key: string, parent: HTMLElement = fields) => rows.row(parent, key);
  const canEdit = () => {
    updateGate();
    return !fields.disabled;
  };
  const presentError = (error: unknown) => new Notice(plugin.error(error));

  function button(row: Setting, label: string, save: () => Promise<void>, disabled = () => false, done?: () => void): void {
    const control = row.controlEl.createEl('button', { text: t(label), attr: { type: 'button' } });
    control.disabled = disabled();
    control.onclick = async () => {
      if (!canEdit() || control.disabled) return;
      control.disabled = true;
      try { await save(); done?.(); }
      catch (error) { presentError(error); }
      finally { control.disabled = disabled(); }
    };
  }

  function text(row: Setting, value: string): HTMLInputElement {
    return row.controlEl.createEl('input', { type: 'text', value, attr: { 'aria-label': row.nameEl.textContent ?? '' } });
  }

  function applyText(row: Setting, value: string, save: (value: string) => Promise<void>, placeholder = ''): void {
    const control = text(row, value);
    control.placeholder = placeholder;
    button(row, 'Apply', () => save(control.value));
  }

  function toggle(key: string, get: () => boolean, save: (value: boolean) => Promise<void>, parent?: HTMLElement): void {
    const row = addRow(key, parent);
    const control = row.controlEl.createEl('input', { type: 'checkbox', attr: { 'aria-label': row.nameEl.textContent ?? '' } });
    control.checked = get();
    control.onchange = async () => {
      if (!canEdit()) { control.checked = get(); return; }
      control.disabled = true;
      try { await save(control.checked); }
      catch (error) { presentError(error); }
      finally { control.checked = get(); control.disabled = false; }
    };
  }

  function integer(key: string, max: number, get: () => number, save: (value: number) => Promise<void>): void {
    const row = addRow(key);
    const control = row.controlEl.createEl('input', {
      type: 'number', value: String(get()),
      attr: { min: '1', max: String(max), step: '1', 'aria-label': row.nameEl.textContent ?? '' }
    });
    const error = row.infoEl.createDiv({
      cls: 'tangrow-settings-error', attr: { role: 'status', id: `tangrow-settings-${key}-range` }
    });
    control.setAttribute('aria-describedby', error.id);
    error.hidden = true;
    let revision = 0;
    const check = (): number | null => {
      const value = wholeMinutes(control.value, max);
      error.hidden = value !== null;
      error.textContent = value === null ? t('Enter a whole number from 1 to {max}.', { max }) : '';
      control.setAttribute('aria-invalid', String(value === null));
      return value;
    };
    // change, blur and leaving the section can all fire for one edit; only one save per value may be in flight.
    let saving: number | null = null;
    // Another view can change the setting while this page is open. Only a value that differs from what this field
    // last showed or saved is the user's change, so a field left at, or typed back to, that value never writes it back.
    let shown = get();
    // Validate while typing, but save only the committed value: typing 300 must not store 3 and 30 on the way.
    const commit = async () => {
      const value = check();
      if (value === null || value === shown || value === saving || !canEdit()) return;
      if (value === get()) { shown = value; return; }
      const inputRevision = ++revision;
      saving = value;
      try {
        await save(value);
        shown = value;
      } catch (failure) {
        if (inputRevision === revision) control.value = String(shown = get());
        presentError(failure);
      } finally {
        if (saving === value) saving = null;
      }
    };
    control.oninput = () => { revision++; check(); };
    control.onchange = commit;
    // Closing settings can remove a focused field without a change event, so leaving the section commits too.
    control.onblur = commit;
    pending.push(() => { void commit(); });
  }

  function folder(key: FolderSettingKey, parent?: HTMLElement): void {
    applyText(addRow(key, parent), plugin.settings[key], async (value) => {
      await plugin.updateFolderSetting(key, value);
      new Notice(t('Path saved. Existing Bases keep their filters: edit them manually or choose a new companion folder and run setup.'));
    });
  }

  switch (id) {
    case 'defaults': {
      const language = addRow('language', container);
      container.insertBefore(language.settingEl, fields);
      language.addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute('aria-label', t('Interface language'));
        dropdown.addOption('zh-CN', t('Simplified Chinese')).addOption('en', 'English')
          .setValue(plugin.settings.language).onChange(async (value) => {
            dropdown.setDisabled(true);
            try { await plugin.setLanguage(value as Locale); refresh(); }
            catch (error) { presentError(error); dropdown.setValue(plugin.settings.language); }
            finally { dropdown.setDisabled(false); }
          });
      });
      toggle('autoOpen', () => plugin.settings.autoOpen, (autoOpen) => plugin.saveSettings({ autoOpen }));
      const periodic = fields.createDiv();
      periodic.createEl('h3', { text: t(PERIODIC_NOTES) });
      periodic.createEl('p', { text: t('Paths are relative to the Journal folder. Weekly notes use ISO weeks (Monday first); use GGGG and WW for their week-year and week number.') });
      folder('journalFolder', periodic);
      for (const period of JOURNAL_PERIODS) {
        const initial = period === 'daily' ? plugin.settings.journalFormat : plugin.settings.journalFormats[period];
        applyText(addRow(`format-${period}`, periodic), initial, async (value) => {
          await plugin.updateJournalSettings(period, value);
          new Notice(t('Journal settings saved.'));
        });
      }
      const templates = fields.createEl('details');
      templates.createEl('summary', { text: t(TEMPLATES) });
      for (const period of JOURNAL_PERIODS) {
        applyText(addRow(`template-${period}`, templates), plugin.settings.journalTemplates[period], async (value) => {
          await plugin.updateJournalSettings(period, undefined, value);
          new Notice(t('Journal settings saved.'));
        }, t('No template'));
      }
      break;
    }
    case 'folders':
      for (const key of ['inboxFolder', 'projectFolder', 'areaFolder', 'resourcesFolder', 'archiveFolder', 'supportFolder'] as const) folder(key);
      applyText(addRow('taskOverviewPath'), plugin.settings.taskOverviewPath, async (value) => {
        const path = safeFolder(value);
        const note = plugin.app.vault.getAbstractFileByPath(path);
        if (!(note instanceof TFile) || note.extension !== 'md') throw new Error('Set an existing Tasks note path in Tangrow settings.');
        await plugin.saveSettings({ taskOverviewPath: path });
        new Notice(t('Task overview path saved.'));
      });
      break;
    case 'sidebar': {
      integer('focusMinutes', 240, () => plugin.settings.focusMinutes, (focusMinutes) => plugin.saveSettings({ focusMinutes }));
      const ai = fields.createDiv();
      ai.createEl('h3', { text: t(AI_SUGGESTIONS) });
      toggle('aiEnabled', () => plugin.settings.aiEnabled, (aiEnabled) => plugin.updateAiSettings({ aiEnabled }), ai);
      applyText(addRow('aiModel', ai), plugin.settings.aiModel, async (aiModel) => {
        await plugin.updateAiSettings({ aiModel });
        new Notice(t('Model saved.'));
      });
      const key = addRow('aiApiKey', ai);
      const updateKeyDescription = () => key.setDesc(t(plugin.hasAiKey()
        ? (plugin.aiKeyProtected() ? "A key is saved in Obsidian's secret storage. Enter a new one to replace it, or save an empty value to remove it." : "A key is saved in this plugin's data.json. Enter a new one to replace it, or save an empty value to remove it.")
        : (plugin.aiKeyProtected() ? "Stored in Obsidian's secret storage, outside your notes." : "This Obsidian version has no secret storage, so the key is stored in this plugin's data.json. Keep that file out of shared or public sync.")));
      updateKeyDescription();
      const control = text(key, '');
      control.type = 'password';
      control.autocomplete = 'off';
      control.placeholder = 'sk-ant-...';
      button(key, 'Save', async () => {
        const value = control.value;
        await plugin.setAiKey(value);
        if (control.value === value) control.value = '';
        updateKeyDescription();
        new Notice(t(value.trim() ? 'API key saved.' : 'API key removed.'));
      });
      break;
    }
    case 'views':
      toggle('wideByDefault', () => plugin.settings.wideByDefault, (wideByDefault) => plugin.saveSettings({ wideByDefault }));
      toggle('knowledgeEnabled', () => plugin.settings.knowledgeEnabled, (enabled) => plugin.updateKnowledgeEnabled(enabled));
      folder('cardFolder');
      break;
    case 'reports': {
      toggle('trackEditingActivity', () => plugin.settings.trackEditingActivity, (trackEditingActivity) => plugin.updateReportSettings({ trackEditingActivity }));
      integer('activityGoalMinutes', 1440, () => plugin.settings.activityGoalMinutes, (activityGoalMinutes) => plugin.updateReportSettings({ activityGoalMinutes }));
      const row = addRow('reportExcludedFolders');
      const textarea = row.controlEl.createEl('textarea', { attr: { rows: '3', 'aria-label': row.nameEl.textContent ?? '' } });
      textarea.value = plugin.settings.reportExcludedFolders.join('\n');
      button(row, 'Apply', () => plugin.updateReportSettings({
        reportExcludedFolders: textarea.value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean)
      }));
      break;
    }
    case 'maintenance':
      button(addRow('setup'), 'Set up Bases', () => plugin.setup());
      button(addRow('migration'), 'Move to 99-Tangrow', () => plugin.migrateCompanionFolder(),
        () => plugin.settings.supportFolder === DEFAULT_SETTINGS.supportFolder);
      button(addRow('agentGuide'), 'Open agent guide', () => plugin.openAiGuide());
      break;
  }
  updateGate();
  return { refresh: updateGate, dispose: () => { for (const commit of pending) commit(); } };
}

export function wholeMinutes(value: string, max: number): number | null {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= max ? minutes : null;
}
