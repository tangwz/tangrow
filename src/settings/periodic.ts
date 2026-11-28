import { moment } from 'obsidian';
import type TangrowPlugin from '../main';
import { dayKey } from '../model';
import { JOURNAL_LABELS, JOURNAL_PERIODS, journalFormat, previewJournalPath, type PeriodicSettingsPatch } from '../periodic-notes';
import type { RenderedSection } from './sections';
import { VAULT_PATH_STATUS_LABELS, vaultPathKind, vaultPathSuggestions } from './vault-structure';
import { inspectVaultStructurePath } from './vault-structure-data';

const dateTime = moment as unknown as (input: Date) => { format(pattern: string): string };
let panelNumber = 0;

export function renderPeriodicSettings(container: HTMLElement, plugin: TangrowPlugin, canEdit: () => boolean): RenderedSection {
  const t = plugin.t.bind(plugin);
  const panel = container.createDiv({ cls: 'tangrow-periodic-settings' });

  function textField(parent: HTMLElement, id: string, label: string): HTMLInputElement {
    parent.dataset.settingId = id;
    parent.tabIndex = -1;
    return parent.createEl('input', { type: 'text', attr: { 'aria-label': t(label), autocomplete: 'off', spellcheck: 'false' } });
  }

  const idPrefix = `tangrow-periodic-${++panelNumber}`;
  const folderRow = panel.createDiv({ cls: 'tangrow-periodic-folder' });
  const folderLabel = folderRow.createEl('label', { text: t('Journal folder') });
  const folder = textField(folderLabel, 'journalFolder', 'Journal folder');
  const folderStatusId = `${idPrefix}-folder-status`;
  const folderStatus = folderRow.createSpan({ cls: 'tangrow-periodic-path', attr: { id: folderStatusId } });
  folder.setAttribute('aria-describedby', folderStatusId);
  const options = vaultPathSuggestions(plugin.app, 'folder');
  if (options.length) {
    const id = `${idPrefix}-folders`;
    folder.setAttribute('list', id);
    const list = folderRow.createEl('datalist', { attr: { id } });
    for (const value of options) list.createEl('option', { value });
  }

  panel.createEl('p', { cls: 'setting-item-description', text: t('Paths are relative to the Journal folder. Weekly notes use ISO weeks (Monday first); use GGGG and WW for their week-year and week number.') });
  const table = panel.createEl('table', { cls: 'tangrow-periodic-table', attr: { 'aria-label': t('Periodic notes') } });
  const headers = table.createEl('thead').createEl('tr');
  for (const title of ['Period', 'Path format', 'Template (optional)']) {
    headers.createEl('th', { text: t(title), attr: { scope: 'col' } });
  }
  const body = table.createEl('tbody');
  const rows = JOURNAL_PERIODS.map((period) => {
    const label = JOURNAL_LABELS[period];
    const row = body.createEl('tr');
    row.createEl('th', { text: t(label), attr: { scope: 'row' } });
    const formatCell = row.createEl('td');
    const format = textField(formatCell, `format-${period}`, `${label} format`);
    const previewId = `${idPrefix}-preview-${period}`;
    const preview = formatCell.createEl('code', { cls: 'tangrow-periodic-path', attr: { id: previewId } });
    format.setAttribute('aria-describedby', previewId);
    const template = textField(row.createEl('td'), `template-${period}`, `${label} template`);
    template.placeholder = t('No template');
    return { period, format, template, preview };
  });
  panel.createEl('p', { cls: 'setting-item-description', text: t('Optional Markdown path. Supports {{title}}, {{date}}, {{start}}, {{end}}, {{period}}, {{year}}, {{week}} and {{quarter}}. Existing notes are preserved.') });

  const footer = panel.createDiv({ cls: 'tangrow-periodic-footer' });
  const status = footer.createEl('p', { attr: { role: 'status' } });
  const buttons = footer.createDiv({ cls: 'tangrow-periodic-buttons' });
  const discard = buttons.createEl('button', { type: 'button', text: t('Discard') });
  const save = buttons.createEl('button', { type: 'button', text: t('Save changes'), cls: 'mod-cta' });

  const fields = [folder, ...rows.flatMap(({ format, template }) => [format, template])];
  const baseline = new Map<HTMLInputElement, string>();
  let disposed = false;
  let saving = false;

  function syncField(field: HTMLInputElement, stored: string, reset: boolean): void {
    if (reset || !baseline.has(field) || field.value === baseline.get(field)) field.value = stored;
    baseline.set(field, stored);
  }

  function sync(reset = false): void {
    const settings = plugin.settings;
    syncField(folder, settings.journalFolder, reset);
    for (const { period, format, template } of rows) {
      syncField(format, journalFormat(settings, period), reset);
      syncField(template, settings.journalTemplates[period], reset);
    }
  }

  function makePatch(): PeriodicSettingsPatch {
    const patch: PeriodicSettingsPatch = {};
    if (folder.value !== baseline.get(folder)) patch.journalFolder = folder.value;
    for (const { period, format, template } of rows) {
      if (format.value !== baseline.get(format)) (patch.formats ??= {})[period] = format.value;
      if (template.value !== baseline.get(template)) (patch.templates ??= {})[period] = template.value;
    }
    return patch;
  }

  function showStatus(message = '', error = false): void {
    status.textContent = message;
    status.hidden = !message;
    if (error) status.addClass('tangrow-settings-error');
    else status.removeClass('tangrow-settings-error');
  }

  function update(): void {
    const dirty = fields.some((field) => field.value !== baseline.get(field));
    const disabled = saving || !canEdit();
    for (const field of fields) field.disabled = disabled;
    discard.disabled = saving || !dirty;
    save.disabled = disabled || !dirty;

    const result = inspectVaultStructurePath('journalFolder', folder.value, (path) => vaultPathKind(plugin.app, path));
    folderStatus.textContent = result.status === 'invalid' ? t(result.error) : t(VAULT_PATH_STATUS_LABELS[result.status]);
    if (result.status !== 'found' && folder.value !== baseline.get(folder)) {
      folder.setAttribute('aria-invalid', 'true');
      folderStatus.addClass('tangrow-settings-error');
    } else {
      folder.removeAttribute('aria-invalid');
      folderStatus.removeClass('tangrow-settings-error');
    }
    const candidate = {
      journalFolder: folder.value,
      journalFormat: plugin.settings.journalFormat,
      journalFormats: { ...plugin.settings.journalFormats }
    };
    for (const { period, format } of rows) {
      if (period === 'daily') candidate.journalFormat = format.value;
      else candidate.journalFormats[period] = format.value;
    }
    const date = dayKey();
    for (const { period, preview, format } of rows) {
      preview.hidden = result.path === null;
      if (preview.hidden) {
        format.removeAttribute('aria-invalid');
        continue;
      }
      try {
        preview.textContent = previewJournalPath(candidate, period, date, (value, pattern) => dateTime(value).format(pattern));
        preview.removeClass('tangrow-settings-error');
        format.removeAttribute('aria-invalid');
      } catch (error) {
        preview.textContent = plugin.error(error);
        preview.addClass('tangrow-settings-error');
        format.setAttribute('aria-invalid', 'true');
      }
    }
  }

  for (const field of fields) field.oninput = () => { showStatus(); update(); };
  discard.onclick = () => { sync(true); showStatus(); update(); };
  save.onclick = async () => {
    if (save.disabled || !canEdit()) return;
    const patch = makePatch();
    saving = true;
    showStatus();
    update();
    try {
      await plugin.updatePeriodicSettings(patch);
      if (disposed) return;
      sync(true);
      showStatus(t('Journal settings saved.'));
    } catch (error) {
      if (disposed) return;
      sync();
      showStatus(plugin.error(error), true);
    } finally {
      saving = false;
      if (!disposed) update();
    }
  };

  showStatus();
  sync(true);
  update();
  return {
    refresh() {
      if (!saving) sync();
      update();
    },
    dispose() { disposed = true; }
  };
}
