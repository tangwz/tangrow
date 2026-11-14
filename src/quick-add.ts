import { Modal, Notice } from 'obsidian';
import type { QuickKind } from './ai';
import { describeError } from './i18n';
import { dayKey, safeTitle } from './model';
import { taskText } from './task-tools';
import type { SidebarHost } from './types';
import { SidebarUI, icon } from './ui';

export const QUICK_KINDS: { id: QuickKind; label: string; icon: string; hint: string; placeholder: string }[] = [
  { id: 'capture', label: 'Capture', icon: 'inbox', hint: 'Saved to your inbox as it is. Sort it later.', placeholder: 'An idea, a question, a link...' },
  { id: 'note', label: 'Note', icon: 'file-plus-2', hint: 'The first line is the title. Anything below becomes the body.', placeholder: 'Title on the first line\nOptional body below' },
  { id: 'task', label: 'Task', icon: 'square-check-big', hint: 'One task per line.', placeholder: 'Something to do\nAnother thing to do' },
  { id: 'project', label: 'Project', icon: 'folder-plus', hint: 'The first line names the project and its folder. Anything below becomes the body.', placeholder: 'Project name\nOptional body below' }
];

function offsetDay(days: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return dayKey(date.getTime());
}

/** One dialog for the four things worth writing down quickly. */
export class QuickAddModal extends Modal {
  private readonly ui: SidebarUI;
  private kind: QuickKind;
  private text: string;
  private due = '';
  private target: 'overview' | 'daily' = 'overview';
  private projectFolder = '';
  private keepOpen = false;
  private saving = false;
  private suggesting?: AbortController;
  private original: string | null = null;
  private reason = '';

  constructor(private readonly host: SidebarHost, kind: QuickKind = 'capture', text = '') {
    super(host.app);
    this.ui = new SidebarUI(() => this.host.settings.language);
    this.kind = kind;
    this.text = text;
  }

  onOpen(): void {
    this.modalEl.addClass('tangrow-quick-modal');
    this.contentEl.addClass('tangrow-dialog', 'tangrow-quick');
    this.scope.register(['Mod'], 'Enter', () => { void this.save(); return false; });
    QUICK_KINDS.forEach((entry, index) => this.scope.register(['Mod'], String(index + 1), () => { this.setKind(entry.id); return false; }));
    this.render();
  }

  onClose(): void {
    this.suggesting?.abort();
    this.contentEl.empty();
  }

  private setKind(kind: QuickKind): void {
    if (this.saving || this.kind === kind) return;
    this.kind = kind;
    this.render();
  }

  private lines(): string[] { return this.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }

  private problem(): string | null {
    const lines = this.lines();
    if (!lines.length) return '';
    try {
      if (this.kind === 'task') lines.forEach((line) => taskText(line));
      else if (this.kind !== 'capture') safeTitle(lines[0] ?? '');
    } catch (error) { return describeError(this.host.settings.language, error); }
    return null;
  }

  private destination(): string {
    const settings = this.host.settings;
    const first = this.lines()[0] ?? '';
    if (this.kind === 'task') return this.ui.t('Destination: {path}', { path: this.target === 'daily' ? this.ui.t("Today's journal") : settings.taskOverviewPath });
    if (this.kind !== 'project') return this.ui.t('Destination: {path}', { path: settings.inboxFolder });
    if (this.projectFolder) return this.ui.t('Destination: {path}', { path: this.projectFolder });
    let title = '';
    try { title = safeTitle(first); } catch { /* The validation line explains the problem. */ }
    return title ? this.ui.t('New project folder: {path}', { path: `${settings.projectFolder}/${title}` }) : this.ui.t('Enter a title to preview the new project folder.');
  }

  private render(): void {
    const entry = QUICK_KINDS.find((item) => item.id === this.kind) ?? QUICK_KINDS[0]!;
    this.setTitle(this.ui.t('Quick add'));
    this.contentEl.empty();
    const tabs = this.contentEl.createDiv({ cls: 'tangrow-quick-tabs', attr: { role: 'tablist', 'aria-label': this.ui.t('What to add') } });
    QUICK_KINDS.forEach((item, index) => {
      const tab = tabs.createEl('button', { cls: `tangrow-quick-tab${item.id === this.kind ? ' is-active' : ''}`, attr: { type: 'button', role: 'tab', 'aria-selected': String(item.id === this.kind), title: `${this.ui.t(item.label)} · ⌘/Ctrl+${index + 1}` } });
      tab.tabIndex = item.id === this.kind ? 0 : -1;
      icon(tab, item.icon);
      tab.createSpan({ text: this.ui.t(item.label) });
      tab.addEventListener('click', () => this.setKind(item.id));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = QUICK_KINDS[(index + (event.key === 'ArrowRight' ? 1 : QUICK_KINDS.length - 1)) % QUICK_KINDS.length]!;
        this.setKind(next.id);
        this.contentEl.querySelector<HTMLElement>('.tangrow-quick-tab.is-active')?.focus();
      });
    });

    const editor = this.contentEl.createEl('textarea', { cls: 'tangrow-quick-input', attr: { rows: '5', placeholder: this.ui.t(entry.placeholder), 'aria-label': this.ui.t(entry.label) } });
    editor.value = this.text;
    this.contentEl.createEl('p', { cls: 'tangrow-muted tangrow-quick-hint', text: this.ui.t(entry.hint) });

    const options = this.contentEl.createDiv({ cls: 'tangrow-quick-options' });
    if (this.kind === 'task') {
      const dueRow = options.createDiv({ cls: 'tangrow-quick-row' });
      dueRow.createSpan({ cls: 'tangrow-quick-label', text: this.ui.t('Due') });
      const chips = dueRow.createDiv({ cls: 'tangrow-chips' });
      const date = dueRow.createEl('input', { type: 'date', attr: { 'aria-label': this.ui.t('Due date') } });
      date.value = this.due;
      const choices: [string, string][] = [['No date', ''], ['Today', offsetDay(0)], ['Tomorrow', offsetDay(1)], ['Next week', offsetDay(7)]];
      const chipButtons = choices.map(([label, value]) => {
        const chip = chips.createEl('button', { cls: 'tangrow-chip', text: this.ui.t(label), attr: { type: 'button', 'aria-pressed': String(this.due === value) } });
        chip.addEventListener('click', () => { this.due = value; date.value = value; sync(); });
        return [chip, value] as const;
      });
      const sync = (): void => chipButtons.forEach(([chip, value]) => chip.setAttribute('aria-pressed', String(this.due === value)));
      date.addEventListener('change', () => { this.due = date.value; sync(); });
      const targetRow = options.createDiv({ cls: 'tangrow-quick-row' });
      targetRow.createSpan({ cls: 'tangrow-quick-label', text: this.ui.t('Add to') });
      const targets = targetRow.createDiv({ cls: 'tangrow-chips' });
      for (const [label, value] of [['Task overview', 'overview'], ["Today's journal", 'daily']] as const) {
        const chip = targets.createEl('button', { cls: 'tangrow-chip', text: this.ui.t(label), attr: { type: 'button', 'aria-pressed': String(this.target === value) } });
        chip.addEventListener('click', () => { this.target = value; this.render(); });
      }
    }
    if (this.kind === 'project') {
      const row = options.createDiv({ cls: 'tangrow-quick-row' });
      row.createSpan({ cls: 'tangrow-quick-label', text: this.ui.t('Project location') });
      const select = row.createEl('select', { attr: { 'aria-label': this.ui.t('Project location') } });
      select.createEl('option', { text: this.ui.t('Create a project folder'), value: '' });
      const root = this.host.settings.projectFolder;
      for (const folder of this.host.snapshot().projectFolders.filter((path) => path.startsWith(`${root}/`))) {
        select.createEl('option', { text: this.ui.t('Existing project: {folder}', { folder: folder.slice(root.length + 1) }), value: folder });
      }
      select.value = this.projectFolder;
      if (select.value !== this.projectFolder) this.projectFolder = '';
      select.addEventListener('change', () => { this.projectFolder = select.value; update(); });
    }

    const suggestion = this.contentEl.createDiv({ cls: 'tangrow-quick-suggestion', attr: { 'aria-live': 'polite' } });
    const destination = this.contentEl.createEl('p', { cls: 'tangrow-destination', attr: { 'aria-live': 'polite' } });
    const validation = this.contentEl.createDiv({ cls: 'tangrow-input-error', attr: { 'aria-live': 'polite' } });
    const footer = this.contentEl.createDiv({ cls: 'tangrow-quick-footer' });
    const left = footer.createDiv({ cls: 'tangrow-quick-footer-side' });
    const sort = this.host.aiReady() ? this.ui.button(left, 'Sort with AI', () => this.suggest(), { icon: 'sparkles', title: 'Suggests a type, title and date. Nothing is saved until you confirm.' }) : null;
    const keep = left.createEl('label', { cls: 'tangrow-quick-keep' });
    const keepBox = keep.createEl('input', { type: 'checkbox' });
    keepBox.checked = this.keepOpen;
    keepBox.addEventListener('change', () => { this.keepOpen = keepBox.checked; });
    keep.createSpan({ text: this.ui.t('Keep open') });
    const right = footer.createDiv({ cls: 'tangrow-quick-footer-side' });
    right.createSpan({ cls: 'tangrow-muted tangrow-quick-shortcut', text: '⌘/Ctrl + Enter' });
    const save = this.ui.button(right, 'Save', () => this.save(), { icon: 'check', cls: 'mod-cta' });

    const update = (): void => {
      const problem = this.problem();
      validation.textContent = problem ?? '';
      save.disabled = this.saving || problem !== null;
      if (sort) sort.disabled = this.saving || !this.text.trim();
      destination.textContent = this.destination();
      suggestion.empty();
      if (this.reason) {
        icon(suggestion, 'sparkles');
        suggestion.createSpan({ text: this.reason });
        if (this.original !== null) this.ui.button(suggestion, 'Undo', () => {
          this.text = this.original ?? this.text;
          this.original = null;
          this.reason = '';
          this.kind = 'capture';
          this.render();
        }, { cls: 'tangrow-text-button' });
      }
    };
    editor.addEventListener('input', () => { this.text = editor.value; update(); });
    update();
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  }

  private async suggest(): Promise<void> {
    const source = this.text;
    if (!source.trim() || this.suggesting) return;
    this.suggesting = new AbortController();
    try {
      const result = await this.host.suggestCapture(source, this.suggesting.signal);
      if (this.text !== source) return;
      this.original = source;
      this.reason = result.reason || this.ui.t('Suggestion ready. Review it before saving.');
      this.kind = result.kind;
      if (result.kind === 'task') { this.text = result.title || source; this.due = result.due ?? ''; }
      else if (result.kind === 'note' || result.kind === 'project') this.text = result.title ? `${result.title}\n${source}` : source;
      if (result.kind === 'project') this.projectFolder = '';
      this.render();
    } finally { this.suggesting = undefined; }
  }

  private async save(): Promise<void> {
    if (this.saving || this.problem() !== null) return;
    const lines = this.lines();
    const first = lines[0] ?? '';
    const body = this.text.slice(this.text.indexOf(first) + first.length).trim();
    this.saving = true;
    this.contentEl.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>('button, textarea').forEach((control) => { control.disabled = true; });
    try {
      if (this.kind === 'capture') await this.host.capture(this.text);
      else if (this.kind === 'task') {
        // Remove each saved line so a failure part-way leaves only the unsaved tasks.
        for (const line of lines) {
          await this.host.addTask(line, { due: this.due || undefined, target: this.target });
          this.text = this.text.split(/\r?\n/).filter((entry, index, all) => entry.trim() !== line || all.findIndex((other) => other.trim() === line) !== index).join('\n');
        }
      } else if (this.kind === 'project') await this.host.createNote('project', first, this.projectFolder || undefined, body);
      else {
        if (body) await this.host.createNoteWithBody(first, body);
        else await this.host.createNote('note', first);
      }
      this.text = '';
      this.original = null;
      this.reason = '';
      this.saving = false;
      if (this.keepOpen) this.render();
      else this.close();
    } catch (error) {
      this.saving = false;
      new Notice(describeError(this.host.settings.language, error));
      this.render();
    }
  }
}
