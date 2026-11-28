import type { SidebarUI } from './ui';

export interface WorkbenchPickerItem {
  path: string;
  label: string;
  detail?: string;
  group?: string;
}

export interface WorkbenchPickerState { query: string; selected: string | null }

interface Options {
  label: string;
  items: readonly WorkbenchPickerItem[];
  selected?: string | null;
  state?: WorkbenchPickerState;
  onConfirm: (path: string) => void | Promise<void>;
  onCancel: () => void;
}

function searchKey(text: string): string { return text.normalize('NFC').trim().toLocaleLowerCase(); }

export function renderWorkbenchPicker(parent: HTMLElement, ui: SidebarUI, options: Options): HTMLInputElement {
  const state = options.state ?? { query: '', selected: options.selected ?? null };
  const picker = parent.createDiv({ cls: 'tangrow-workbench-picker', attr: { role: 'group', 'aria-label': options.label } });
  const search = picker.createEl('input', { cls: 'tangrow-workbench-picker-search', type: 'search', attr: {
    'aria-label': ui.t('Search notes and folders'), placeholder: ui.t('Search notes and folders')
  } });
  search.value = state.query;
  const name = `tangrow-workbench-picker-${crypto.randomUUID()}`;
  const results = picker.createDiv({ cls: 'tangrow-workbench-picker-results' });
  const footer = picker.createDiv({ cls: 'tangrow-workbench-picker-actions' });
  const cancel = ui.button(footer, 'Cancel', options.onCancel, { level: 'text' });
  let saving = false;
  let radios: HTMLInputElement[] = [];
  const selection = () => options.items.find((item) => item.path === state.selected);
  const syncDisabled = () => {
    search.disabled = cancel.disabled = saving;
    for (const radio of radios) radio.disabled = saving;
    confirm.disabled = saving || !selection();
  };
  const confirm = ui.button(footer, 'Confirm selection', async () => {
    const item = selection();
    if (!item || saving) return;
    saving = true;
    syncDisabled();
    try { await options.onConfirm(item.path); }
    finally { saving = false; syncDisabled(); }
  });

  const renderResults = () => {
    results.empty();
    radios = [];
    const query = searchKey(state.query);
    const matches = options.items.filter((item) => !query || searchKey([item.label, item.path, item.detail].join(' ')).includes(query));
    if (state.selected !== null && !matches.some((item) => item.path === state.selected)) state.selected = null;
    if (!matches.length) ui.paragraph(results, 'No matching options');
    const groups = new Map<string | undefined, HTMLElement>();
    for (const item of matches) {
      let group = groups.get(item.group);
      if (!group) {
        group = results.createDiv({ cls: 'tangrow-workbench-picker-group' });
        if (item.group) group.createEl('strong', { text: item.group });
        groups.set(item.group, group);
      }
      const row = group.createEl('label', { cls: 'tangrow-workbench-picker-row' });
      const radio = row.createEl('input', { type: 'radio', attr: { name } });
      radio.checked = state.selected === item.path;
      radios.push(radio);
      radio.addEventListener('change', () => { if (radio.checked) { state.selected = item.path; syncDisabled(); } });
      const label = row.createSpan({ cls: 'tangrow-workbench-picker-title', text: item.label });
      if (item.detail) label.createSpan({ cls: 'tangrow-workbench-picker-detail', text: item.detail });
    }
    syncDisabled();
  };
  search.addEventListener('input', () => { state.query = search.value; renderResults(); });
  picker.addEventListener('keydown', (event) => {
    if (event.isComposing || saving) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); options.onCancel(); }
    if (event.key === 'Enter' && event.target === search && !confirm.disabled) { event.preventDefault(); confirm.click(); }
  });
  renderResults();
  return search;
}
