import { Notice, Setting } from 'obsidian';
import { DEFAULT_AI_MODEL } from '../ai';
import type TangrowPlugin from '../main';
import { DEFAULT_SETTINGS, type Locale } from '../types';
import { AI_SUGGESTIONS, ITEMS, type SectionId } from './catalog';
import { renderPeriodicSettings } from './periodic';
import { renderVaultStructure } from './vault-structure';

const MODEL_PRESETS = [DEFAULT_AI_MODEL, 'claude-sonnet-5-5', 'claude-haiku-5-5'];

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

export function renderSection(container: HTMLElement, id: Exclude<SectionId, 'activation' | 'welcome'>, plugin: TangrowPlugin, refresh: () => void): RenderedSection {
  const t = plugin.t.bind(plugin);
  const rows = settingRows(plugin, id);
  const pending: (() => void)[] = [];
  // Fields that follow changes made elsewhere, such as the report view, while this section is open.
  const syncs: (() => void)[] = [];
  let disposed = false;
  let form: RenderedSection | undefined;
  if (id === 'guide') {
    const row = rows.row(container, 'tutorial');
    row.controlEl.createEl('a', {
      text: t('Open user guide ↗'),
      href: 'https://github.com/tangwz/tangrow#%E4%BD%BF%E7%94%A8%E6%96%B9%E5%BC%8F',
      attr: { target: '_blank', rel: 'noopener noreferrer' }
    });
    for (const item of ITEMS) if (item.section === id && item.id !== 'tutorial') rows.row(container, item.id);
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
    // The value this field showed when rendered, or last sent to be saved, even if that save is still in flight.
    // Another view can change the setting while this page is open, so only a value that differs from it is the
    // user's change: a field left at, or typed back to, that value never writes it back. change, blur and leaving
    // the section can all fire for one edit, and comparing with it also saves that edit once.
    let committed = get();
    let inFlight = 0;
    // Which commit set `committed`. A value can be committed more than once, so a failure is matched by commit, not
    // by value: 45, 25, 45 with the first 45 failing must keep the last 45.
    let latestCommit = 0;
    // Validate while typing, but save only the committed value: typing 300 must not store 3 and 30 on the way.
    const commit = async () => {
      const value = check();
      if (value === null || value === committed || !canEdit()) return;
      // Save even when the setting already holds this value: another view's write of it may still be in flight and
      // could fail, and an unsaved value cannot stand in for this commit. Saving an unchanged value is harmless.
      const inputRevision = latestCommit = ++revision;
      committed = value;
      inFlight++;
      try { await save(value); }
      catch (failure) {
        // Saves land in order, so when the latest commit fails every earlier one has finished and the stored value
        // is final. A failure that later commits superseded changes nothing.
        if (inputRevision === latestCommit) committed = get();
        if (inputRevision === revision) control.value = String(get());
        presentError(failure);
      } finally { inFlight--; }
    };
    const isFocused = () =>
      control.ownerDocument.activeElement === control && control.ownerDocument.hasFocus?.() !== false;
    // Show a value changed elsewhere unless the user is editing here or a save from this field is still landing, so
    // the field never displays a stale value that typing it again could not restore.
    const sync = () => {
      const stored = get();
      if (disposed || inFlight > 0 || stored === committed || isFocused() || wholeMinutes(control.value, max) !== committed) return;
      committed = stored;
      control.value = String(stored);
      check();
    };
    control.oninput = () => { revision++; check(); };
    control.onchange = commit;
    // Closing settings can remove a focused field without a change event, so leaving the section commits too.
    control.onblur = async () => {
      await commit();
      sync();
    };
    pending.push(() => { void commit(); });
    syncs.push(sync);
  }

  function model(row: Setting): void {
    const control = row.controlEl.createEl('select', { attr: { 'aria-label': t('Model') } });
    for (const preset of MODEL_PRESETS) {
      control.createEl('option', { text: preset === DEFAULT_AI_MODEL ? t('{model} (default)', { model: preset }) : preset, attr: { value: preset } });
    }
    control.createEl('option', { text: t('Custom…'), attr: { value: '' } });
    const custom = row.controlEl.createDiv({ cls: 'tangrow-settings-model-custom' });
    const input = custom.createEl('input', { type: 'text', attr: { 'aria-label': t('Custom model ID') } });
    const save = custom.createEl('button', { text: t('Save model'), attr: { type: 'button' } });
    const error = row.infoEl.createDiv({ cls: 'tangrow-settings-error', attr: { role: 'status' } });
    let saving = false;
    const sync = () => {
      const current = plugin.settings.aiModel;
      control.value = MODEL_PRESETS.includes(current) ? current : '';
      custom.hidden = control.value !== '';
      input.value = custom.hidden ? '' : current;
    };
    const write = async (value: string, fromCustom: boolean) => {
      if (saving || !canEdit()) return;
      saving = control.disabled = input.disabled = save.disabled = true;
      error.textContent = '';
      try {
        if (value.trim() !== plugin.settings.aiModel) await plugin.updateAiSettings({ aiModel: value });
        sync();
      } catch (failure) {
        error.textContent = plugin.error(failure);
        if (!fromCustom) sync();
      } finally {
        saving = control.disabled = input.disabled = save.disabled = false;
      }
    };
    control.onchange = async () => {
      if (!canEdit()) { sync(); return; }
      error.textContent = '';
      custom.hidden = control.value !== '';
      if (custom.hidden) await write(control.value, false);
      else input.focus();
    };
    input.oninput = () => { error.textContent = ''; };
    save.onclick = () => write(input.value, true);
    sync();
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
      break;
    }
    case 'folders': form = renderVaultStructure(fields, plugin, canEdit); break;
    case 'periodic': form = renderPeriodicSettings(fields, plugin, canEdit); break;
    case 'sidebar':
      toggle('knowledgeEnabled', () => plugin.settings.knowledgeEnabled, (enabled) => plugin.updateKnowledgeEnabled(enabled));
      integer('focusMinutes', 240, () => plugin.settings.focusMinutes, (focusMinutes) => plugin.saveSettings({ focusMinutes }));
      toggle('wideByDefault', () => plugin.settings.wideByDefault, (wideByDefault) => plugin.saveSettings({ wideByDefault }));
      break;
    case 'ai': {
      const planning = fields.createDiv();
      const engine = planning.createEl('h3', { text: t('Organizing engine') });
      const hint = engine.createSpan({ cls: 'tangrow-settings-status', text: t('Coming soon') });
      const syncHint = () => { hint.hidden = !plugin.settings.showComingSoon; };
      syncs.push(syncHint);
      syncHint();
      toggle('prepareDailyReview', () => plugin.settings.prepareDailyReview, (prepareDailyReview) => plugin.updateOrganizingPreferences({ prepareDailyReview }), planning);
      toggle('showComingSoon', () => plugin.settings.showComingSoon, (showComingSoon) => plugin.updateOrganizingPreferences({ showComingSoon }), planning);
      const ai = fields.createDiv();
      ai.createEl('h3', { text: t(AI_SUGGESTIONS) });
      toggle('aiEnabled', () => plugin.settings.aiEnabled, (aiEnabled) => plugin.updateAiSettings({ aiEnabled }), ai);
      model(addRow('aiModel', ai));
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
      const agent = fields.createDiv();
      agent.createEl('h3', { text: t('AI workflows (Claudian)') });
      const status = addRow('claudian', agent).controlEl.createSpan({ cls: 'tangrow-settings-status' });
      const statusLabels = { missing: 'Claudian is not installed or enabled', incompatible: 'This Claudian version is not supported', idle: 'No Claudian chat is focused', ready: 'Claudian chat ready' } as const;
      const syncClaudian = () => { status.textContent = t(statusLabels[plugin.agentStatus()]); };
      syncs.push(syncClaudian);
      syncClaudian();
      break;
    }
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
  const unsubscribe = form || syncs.length ? plugin.subscribe(() => {
    form?.refresh();
    for (const sync of syncs) sync();
  }) : undefined;
  return {
    refresh: () => { updateGate(); form?.refresh(); },
    dispose: () => {
      disposed = true;
      form?.dispose();
      unsubscribe?.();
      for (const commit of pending) commit();
    }
  };
}

export function wholeMinutes(value: string, max: number): number | null {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= max ? minutes : null;
}
