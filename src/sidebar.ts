import { ItemView, Notice, setTooltip } from 'obsidian';
import { describeError } from './i18n';
import type { WorkspaceLeaf } from 'obsidian';
import type { QuickKind } from './ai';
import { QUICK_KINDS } from './quick-add';
import type { ActionId, BaseId, Locale, NoteSummary, Section, SidebarHost, Snapshot } from './types';
import { CapturePanel } from './capture-panel';
import { JOURNAL_LABELS, JOURNAL_PERIODS } from './periodic-notes';
import { AiPanel } from './ai-panel';
import { SidebarUI, icon } from './ui';

export const VIEW_TYPE = 'tangrow-sidebar';

type ToolGroup = 'shortcuts' | 'create' | 'current' | 'workspace' | 'databases';
const TOOL_GROUPS: { id: ToolGroup; label: string }[] = [
  { id: 'shortcuts', label: 'Today' },
  { id: 'create', label: 'Create' },
  { id: 'current', label: 'Current file' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'databases', label: 'Databases' }
];

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'tools', label: 'Home', icon: 'house' },
  { id: 'capture', label: 'Capture', icon: 'inbox' },
  { id: 'pins', label: 'Pins', icon: 'pin' },
  { id: 'studio', label: 'Studio', icon: 'pen-line' },
  { id: 'focus', label: 'Focus', icon: 'timer' },
  { id: 'habits', label: 'Habits', icon: 'calendar-check' },
  { id: 'ai', label: 'Assistant', icon: 'sparkles' }
];

const BASES: { id: BaseId; label: string; icon: string }[] = [
  { id: 'notes', label: 'All notes', icon: 'files' },
  { id: 'recent', label: 'Recently edited', icon: 'history' },
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'projects', label: 'Projects', icon: 'folder-kanban' },
  { id: 'areas', label: 'Areas', icon: 'layers' },
  { id: 'resources', label: 'Resources', icon: 'library' },
  { id: 'sources', label: 'Sources', icon: 'link' },
  { id: 'tasks', label: 'Task notes', icon: 'list-checks' },
  { id: 'captures', label: 'Captures', icon: 'message-square' },
  { id: 'pins', label: 'Pinned notes', icon: 'pin' },
  { id: 'drafts', label: 'Writing drafts', icon: 'pen-line' },
  { id: 'focus', label: 'Focus sessions', icon: 'timer' },
  { id: 'habits', label: 'Habit history', icon: 'calendar-check' }
];

function wordCount(text: string, language: Locale): number {
  const segmenter = new Intl.Segmenter(language, { granularity: 'word' });
  return [...segmenter.segment(text)].filter((segment) => segment.isWordLike).length;
}

export class TangrowSidebar extends ItemView {
  private readonly host: SidebarHost;
  private readonly ui: SidebarUI;
  private readonly viewId = `tangrow-${crypto.randomUUID()}`;
  private isMounted = false;
  private section: Section = 'tools';
  private toolGroup: ToolGroup = 'shortcuts';
  private pane!: HTMLElement;
  private noteLabel!: HTMLElement;
  private setupBanner!: HTMLElement;
  private navButtons = new Map<Section, HTMLButtonElement>();
  private unsubscribe?: () => void;
  private unsubscribeComposer?: () => void;
  private refreshSection: (state: Snapshot) => void = () => undefined;
  private capturePanel?: CapturePanel;
  private readonly aiPanel: AiPanel;
  private shellLabels: Array<{ element: HTMLElement; source: string; tooltip?: boolean }> = [];
  private taskDraft = '';
  private taskSaving = false;
  private recentOpenedLimit = 8;
  private scratch = '';
  private scratchRevision = 0;
  private scratchSaving = false;
  private scratchEditor?: HTMLTextAreaElement;
  private scratchComposingControl?: HTMLInputElement | HTMLTextAreaElement;
  private scratchTitleInput?: HTMLInputElement;
  private studioHeading?: HTMLElement;
  private studioCaption?: HTMLElement;
  private scratchSaveButton?: HTMLButtonElement;
  private scratchCount?: HTMLElement;
  private scratchTitle = '';
  private habitName = '';
  private habitRevision = 0;
  private habitSaving = false;
  private habitInput?: HTMLInputElement;
  private habitAddButton?: HTMLButtonElement;
  private focusMinutes: number;
  private focusDefaultMinutes: number;
  private customFocusMinutes = false;
  private clock?: HTMLElement;
  private clockStatus?: HTMLElement;
  private clockProgress?: HTMLProgressElement;

  constructor(leaf: WorkspaceLeaf, host: SidebarHost) {
    super(leaf);
    this.host = host;
    this.ui = new SidebarUI(() => this.host.settings.language);
    this.focusMinutes = host.settings.focusMinutes;
    this.focusDefaultMinutes = host.settings.focusMinutes;
    this.aiPanel = new AiPanel(host, this);
  }

  /** Opens a workspace from a command or menu item. */
  showSection(section: Section): void {
    if (this.isMounted && this.section !== section) this.selectSection(section);
    else this.section = section;
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Tangrow'; }
  getIcon(): string { return 'sprout'; }

  async onOpen(): Promise<void> {
    this.isMounted = true;
    this.syncStudio();
    this.renderShell();
    this.unsubscribe = this.host.subscribe(() => this.refresh());
    this.unsubscribeComposer = this.host.subscribeComposer(() => this.syncStudio());
    this.registerInterval(window.setInterval(() => this.updateClock(), 1000));
  }

  refreshLanguage(): void {
    if (!this.isMounted) return;
    const active = this.contentEl.ownerDocument.activeElement;
    const inputs = [this.scratchEditor, this.scratchTitleInput, this.habitInput];
    const focusedInput = inputs.findIndex((input) => input === active);
    const selection = focusedInput < 0 ? null : {
      start: inputs[focusedInput]?.selectionStart ?? 0,
      end: inputs[focusedInput]?.selectionEnd ?? 0
    };
    const focusedTab = Array.from(this.navButtons).find(([, control]) => control === active)?.[0];
    const composing = this.scratchComposingControl?.isConnected ?? false;
    const scrollTop = this.contentEl.scrollTop;
    this.preserveFocus(() => {
      this.refreshShellLabels();
      if (this.section === 'capture' && this.capturePanel) {
        this.capturePanel.refresh();
        this.refresh();
      } else if (this.section === 'studio') {
        this.refreshStudioLabels();
        this.refresh();
      } else this.selectSection(this.section);
    });
    this.contentEl.scrollTop = scrollTop;
    if (composing) return;
    const replacement = [this.scratchEditor, this.scratchTitleInput, this.habitInput][focusedInput];
    if (selection && replacement?.isConnected) {
      replacement.focus({ preventScroll: true });
      replacement.setSelectionRange(selection.start, selection.end);
    } else if (focusedTab) this.navButtons.get(focusedTab)?.focus({ preventScroll: true });
  }

  private refreshShellLabels(): void {
    const badge = this.contentEl.querySelector<HTMLElement>('.tangrow-local-badge');
    if (badge) {
      badge.textContent = this.ui.t('LOCAL');
      setTooltip(badge, this.ui.t('Your notes and companion data stay in this vault.'));
    }
    this.contentEl.querySelector('.tangrow-nav')?.setAttribute('aria-label', this.ui.t('Companion workspaces'));
    for (const { element, source, tooltip } of this.shellLabels) {
      const text = this.ui.t(source);
      if (tooltip) { element.setAttribute('aria-label', text); setTooltip(element, text); }
      else element.textContent = text;
    }
    for (const item of SECTIONS) {
      const control = this.navButtons.get(item.id);
      const label = control?.querySelector('.tangrow-nav-label');
      if (label) label.textContent = this.ui.t(item.label);
      if (control) setTooltip(control, this.ui.t(item.label));
    }
    this.setupBanner.empty();
  }

  private renderShell(): void {
    this.contentEl.empty();
    this.navButtons.clear();
    this.contentEl.addClass('tangrow-sidebar');
    const header = this.contentEl.createDiv({ cls: 'tangrow-header' });
    const brand = header.createDiv({ cls: 'tangrow-brand' });
    icon(brand, 'sprout');
    brand.createEl('strong', { text: 'Tangrow' });
    this.shellLabels = [];
    const headerTools = header.createDiv({ cls: 'tangrow-header-tools' });
    const badge = headerTools.createSpan({ cls: 'tangrow-local-badge', text: this.ui.t('LOCAL') });
    setTooltip(badge, this.ui.t('Your notes and companion data stay in this vault.'));
    const add = headerTools.createEl('button', { cls: 'tangrow-header-add', attr: { type: 'button', 'aria-label': this.ui.t('Quick add') } });
    icon(add, 'plus');
    setTooltip(add, this.ui.t('Quick add'));
    add.addEventListener('click', () => this.host.openQuickAdd());
    this.shellLabels.push({ element: add, source: 'Quick add', tooltip: true });
    this.noteLabel = this.contentEl.createDiv({ cls: 'tangrow-context', attr: { 'aria-live': 'polite' } });
    const quick = this.contentEl.createDiv({ cls: 'tangrow-quickbar', attr: { role: 'group' } });
    for (const kind of QUICK_KINDS) {
      const control = quick.createEl('button', { cls: 'tangrow-quickbar-item', attr: { type: 'button' } });
      icon(control, kind.icon);
      const label = control.createSpan({ text: this.ui.t(kind.label) });
      control.addEventListener('click', () => this.openCreate(kind.id));
      this.shellLabels.push({ element: label, source: kind.label });
    }
    const nav = this.contentEl.createDiv({ cls: 'tangrow-nav', attr: { role: 'tablist', 'aria-label': this.ui.t('Companion workspaces') } });
    for (const item of SECTIONS) {
      const itemButton = nav.createEl('button', {
        cls: 'tangrow-nav-item',
        attr: { type: 'button', role: 'tab', id: `${this.viewId}-tab-${item.id}`, 'aria-controls': `${this.viewId}-pane`, 'aria-selected': 'false' }
      });
      icon(itemButton, item.icon);
      itemButton.createSpan({ cls: 'tangrow-nav-label', text: this.ui.t(item.label) });
      setTooltip(itemButton, this.ui.t(item.label));
      itemButton.addEventListener('click', () => {
        if (this.section !== item.id) this.selectSection(item.id);
      });
      itemButton.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = SECTIONS.findIndex((entry) => entry.id === item.id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length;
        const target = SECTIONS[next];
        if (target) {
          if (this.section !== target.id) this.selectSection(target.id);
          this.navButtons.get(target.id)?.focus({ preventScroll: true });
        }
      });
      this.navButtons.set(item.id, itemButton);
    }
    this.setupBanner = this.contentEl.createDiv({ cls: 'tangrow-setup' });
    this.pane = this.contentEl.createDiv({ cls: 'tangrow-pane', attr: { role: 'tabpanel', id: `${this.viewId}-pane` } });
    this.selectSection(this.section);
  }

  async onClose(): Promise<void> {
    this.isMounted = false;
    this.capturePanel?.destroy();
    this.capturePanel = undefined;
    this.aiPanel.destroy();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeComposer?.();
    this.unsubscribeComposer = undefined;
    this.clearStudioControls();
    this.contentEl.empty();
    this.navButtons.clear();
  }

  private selectSection(section: Section): void {
    this.capturePanel?.destroy();
    this.capturePanel = undefined;
    this.aiPanel.destroy();
    this.section = section;
    for (const [id, item] of this.navButtons) {
      item.classList.toggle('is-active', id === section);
      item.setAttribute('aria-selected', String(id === section));
      item.tabIndex = id === section ? 0 : -1;
    }
    this.pane.setAttribute('aria-labelledby', `${this.viewId}-tab-${section}`);
    this.pane.empty();
    this.clearStudioControls();
    this.clock = undefined;
    this.clockStatus = undefined;
    this.clockProgress = undefined;
    this.refreshSection = () => undefined;
    const state = this.host.snapshot();
    switch (section) {
      case 'tools': {
        let signature = '';
        this.refreshSection = (snapshot) => {
          const next = JSON.stringify([snapshot.active, snapshot.activePinned, snapshot.counts, snapshot.tasks, snapshot.widePage, this.host.settings.wideByDefault, snapshot.captures.filter((capture) => !capture.processed).length, new Date().toDateString(), this.taskSaving]);
          if (next === signature) return;
          signature = next;
          this.preserveFocus(() => this.renderTools(snapshot));
        };
        break;
      }
      case 'capture': this.mountCapture(); break;
      case 'pins': {
        let signature = '';
        this.refreshSection = (snapshot) => {
          const next = JSON.stringify([snapshot.active?.path, snapshot.activePinned, snapshot.pins, snapshot.recentOpened, this.recentOpenedLimit]);
          if (next === signature) return;
          signature = next;
          this.preserveFocus(() => this.renderPins(snapshot));
        };
        break;
      }
      case 'studio': this.mountStudio(); break;
      case 'focus': this.mountFocus(); break;
      case 'habits': this.mountHabits(); break;
      case 'ai': {
        this.aiPanel.mount(this.pane);
        let signature = '';
        this.refreshSection = (snapshot) => {
          const next = JSON.stringify([snapshot.active?.path, this.host.aiReady(), this.host.agentStatus(), this.host.agentRun()]);
          if (signature && next !== signature) this.aiPanel.refresh();
          signature = next;
        };
        break;
      }
    }
    this.refresh(state);
  }

  private refresh(snapshot = this.host.snapshot()): void {
    this.syncFocusDuration();
    this.noteLabel.empty();
    icon(this.noteLabel, snapshot.active ? 'file-text' : 'compass');
    this.noteLabel.createSpan({ text: snapshot.active?.name ?? this.ui.t('A companion for your existing vault') });
    if (snapshot.active) setTooltip(this.noteLabel, snapshot.active.path);
    const needsSetup = !snapshot.supportReady;
    this.setupBanner.hidden = !needsSetup;
    if (needsSetup && !this.setupBanner.hasChildNodes()) {
      this.setupBanner.createEl('strong', { text: this.ui.t('Add your companion views') });
      this.ui.paragraph(this.setupBanner, 'Create additive Bases in the support folder. Your existing notes stay where they are.');
      this.ui.button(this.setupBanner, 'Set up Bases', () => this.host.setup(), { icon: 'database', cls: 'mod-cta' });
    }
    this.refreshSection(snapshot);
    this.updateClock(snapshot);
  }

  private actionButton(parent: HTMLElement, id: ActionId, label: string, iconName: string, disabled = false, pressed?: boolean): HTMLButtonElement {
    const control = this.ui.button(parent, label, () => this.host.action(id), { icon: iconName, disabled, pressed });
    control.dataset.tangrowAction = id;
    return control;
  }

  private renderTools(state: Snapshot): void {
    this.pane.empty();
    const language = this.host.settings.language;
    const now = new Date();
    const pending = state.captures.filter((capture) => !capture.processed).length;
    const hero = this.pane.createDiv({ cls: 'tangrow-today' });
    hero.createDiv({ cls: 'tangrow-today-date', text: now.toLocaleDateString(language, { month: 'long', day: 'numeric' }) });
    hero.createDiv({ cls: 'tangrow-today-weekday', text: now.toLocaleDateString(language, { weekday: 'long' }) });
    const metrics = this.pane.createDiv({ cls: 'tangrow-overview' });
    const cards: [number, string, string, () => void | Promise<void>][] = [
      [state.counts.tasks, 'open tasks', 'Open task overview', () => this.host.action('task-overview')],
      [pending, 'to sort', 'Review pending captures', () => this.selectSection('capture')],
      [state.counts.projects, 'project notes', 'Browse projects', () => this.host.openBase('projects')],
      [state.counts.notes, 'notes', 'Browse all notes', () => this.host.openBase('notes')]
    ];
    for (const [value, label, title, open] of cards) {
      const metric = this.ui.userButton(metrics, this.ui.t(label), open, { cls: 'tangrow-metric', title: this.ui.t(title) });
      metric.setAttribute('aria-label', `${this.ui.t(title)} · ${this.ui.number(value)}`);
      metric.createEl('strong', { text: this.ui.number(value) });
      metric.prepend(metric.lastElementChild!);
    }
    const groups = this.pane.createDiv({ cls: 'tangrow-chips tangrow-tool-groups', attr: { role: 'tablist', 'aria-label': this.ui.t('Tool groups') } });
    for (const group of TOOL_GROUPS) {
      const chip = groups.createEl('button', { cls: 'tangrow-chip', text: this.ui.t(group.label), attr: { type: 'button', role: 'tab', 'aria-selected': String(group.id === this.toolGroup), 'aria-label': this.ui.t(group.label) } });
      chip.dataset.tangrowAction = `tool-group-${group.id}`;
      chip.addEventListener('click', () => {
        if (this.toolGroup === group.id) return;
        this.toolGroup = group.id;
        this.preserveFocus(() => this.renderTools(this.host.snapshot()));
      });
    }
    switch (this.toolGroup) {
      case 'shortcuts': {
        this.renderTaskPreview(state);
        this.ui.sectionHeading(this.pane, 'Quick actions');
        const shortcuts = this.pane.createDiv({ cls: 'tangrow-actions' });
        this.actionButton(shortcuts, 'daily-note', "Today's journal", 'calendar-days');
        this.actionButton(shortcuts, 'report', 'Open report', 'chart-no-axes-combined');
        this.actionButton(shortcuts, 'toggle-pin', state.activePinned ? 'Unpin note' : 'Pin note', 'pin', !this.isMarkdown(state), state.activePinned);
        this.actionButton(shortcuts, 'random-note', 'Rediscover a note', 'shuffle', state.counts.notes === 0);
        this.ui.button(shortcuts, 'Vault workflows', () => this.selectSection('ai'), { icon: 'sparkles' });
        this.actionButton(shortcuts, 'toggle-theme', 'Toggle light / dark', 'sun-moon');
        break;
      }
      case 'create': this.renderCreateActions(); break;
      case 'current': this.renderCurrentActions(state); break;
      case 'workspace': this.renderWorkspaceActions(); break;
      case 'databases': {
        this.ui.sectionHeading(this.pane, 'Your database views', 'Views query notes in their current folders.');
        const databases = this.pane.createDiv({ cls: 'tangrow-databases' });
        for (const base of BASES) this.ui.button(databases, base.label, () => this.host.openBase(base.id), { icon: base.icon });
        break;
      }
    }
  }

  private isMarkdown(state: Snapshot): boolean {
    return state.active?.path.toLowerCase().endsWith('.md') ?? false;
  }

  private renderCreateActions(): void {
    this.ui.sectionHeading(this.pane, 'Make a little space', 'Start a note, return to today, or pick up a loose thread.');
    const create = this.pane.createDiv({ cls: 'tangrow-actions' });
    this.ui.button(create, 'New note', () => this.openCreate('note'), { icon: 'file-plus-2', cls: 'mod-cta' });
    this.ui.button(create, 'New task', () => this.openCreate('task'), { icon: 'square-check-big' });
    this.ui.button(create, 'New project', () => this.openCreate('project'), { icon: 'folder-plus' });
    this.ui.button(create, 'Quick capture', () => this.openCreate('capture'), { icon: 'inbox' });
    this.actionButton(create, 'daily-note', "Today's journal", 'calendar-days');
    this.ui.button(create, 'Open capture window', () => this.host.openCaptureWindow(), { icon: 'external-link' });
    this.ui.sectionHeading(this.pane, 'Periodic notes');
    const periods = this.pane.createDiv({ cls: 'tangrow-chips' });
    for (const period of JOURNAL_PERIODS) {
      const chip = this.ui.button(periods, JOURNAL_LABELS[period], () => this.host.openPeriodicNote(period), { cls: 'tangrow-chip' });
      chip.dataset.tangrowAction = `period-${period}`;
    }
  }

  private renderCurrentActions(state: Snapshot): void {
    this.ui.sectionHeading(this.pane, 'Current file');
    const current = this.pane.createDiv({ cls: 'tangrow-actions' });
    const noFile = !state.active;
    const noMarkdown = !this.isMarkdown(state);
    this.actionButton(current, 'copy-link', 'Copy file link', 'link', noFile);
    this.actionButton(current, 'copy-path', 'Copy vault path', 'copy', noFile);
    this.actionButton(current, 'file-location', 'Locate this file', 'folder-search', noFile);
    this.actionButton(current, 'toggle-pin', state.activePinned ? 'Unpin note' : 'Pin note', 'pin', noMarkdown, state.activePinned);
    this.actionButton(current, 'fold', 'Fold sections', 'fold-vertical', noMarkdown);
    this.actionButton(current, 'unfold', 'Unfold sections', 'unfold-vertical', noMarkdown);
    this.actionButton(current, 'page-width', 'Roomier page', 'move-horizontal', noMarkdown, state.widePage);
    this.actionButton(current, 'cover', 'Set cover', 'image', noMarkdown);
    const titleDate = this.actionButton(current, 'title-date', 'Date note heading', 'calendar-plus', noMarkdown);
    setTooltip(titleDate, this.ui.t("Adds today's date to the first note heading without renaming the file."));
    this.actionButton(current, 'timestamp', 'Insert body timestamp', 'calendar-clock', noMarkdown);
    this.actionButton(current, 'refresh', 'Refresh index', 'refresh-cw');
    if (noFile) this.ui.paragraph(this.pane, 'Open a file to use its tools.');
  }

  private renderWorkspaceActions(): void {
    this.ui.sectionHeading(this.pane, 'Workspace');
    const workspace = this.pane.createDiv({ cls: 'tangrow-actions' });
    this.actionButton(workspace, 'report', 'Open report', 'chart-no-axes-combined');
    this.actionButton(workspace, 'toggle-theme', 'Toggle light / dark', 'sun-moon');
    this.actionButton(workspace, 'appearance', 'Theme & accent settings', 'palette');
    this.actionButton(workspace, 'all-width', 'Roomier workspace', 'expand', false, this.host.settings.wideByDefault);
    this.actionButton(workspace, 'file-list', 'File navigation', 'folder-tree');
    this.actionButton(workspace, 'stack-tabs', 'Tab layout', 'panels-top-left');
    this.actionButton(workspace, 'settings', 'Companion settings', 'settings-2');
    this.actionButton(workspace, 'hide-panel', 'Close companion', 'panel-right-close');
  }

  private renderTaskPreview(state: Snapshot): void {
    const taskSection = this.pane.createDiv({ cls: 'tangrow-task-preview' });
    const openTasks = state.tasks.filter((entry) => !entry.done);
    const heading = taskSection.createDiv({ cls: 'tangrow-list-heading' });
    heading.createEl('h3', { cls: 'tangrow-section-title', text: this.ui.t('Tasks') });
    const overview = this.ui.userButton(heading, this.ui.t('View all · {count}', { count: this.ui.number(openTasks.length) }), () => this.host.action('task-overview'), { cls: 'tangrow-text-button' });
    overview.dataset.tangrowAction = 'task-overview';
    const form = taskSection.createEl('form', { cls: 'tangrow-task-add' });
    icon(form, 'plus');
    const input = form.createEl('input', { type: 'text', attr: { placeholder: this.ui.t('Add a task and press Enter'), 'aria-label': this.ui.t('New task'), maxlength: '240' } });
    input.value = this.taskDraft;
    input.disabled = this.taskSaving;
    input.dataset.tangrowAction = 'task-add';
    input.addEventListener('input', () => { this.taskDraft = input.value; });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.taskDraft.trim();
      if (!text || this.taskSaving) return;
      this.taskSaving = true;
      input.disabled = true;
      void this.host.addTask(text).then(() => { if (this.taskDraft.trim() === text) this.taskDraft = ''; })
        .catch((error: unknown) => new Notice(describeError(this.host.settings.language, error)))
        .finally(() => {
          this.taskSaving = false;
          if (this.section !== 'tools' || this.toolGroup !== 'shortcuts') return;
          this.renderTools(this.host.snapshot());
          this.pane.querySelector<HTMLInputElement>('.tangrow-task-add input')?.focus({ preventScroll: true });
        });
    });
    if (!openTasks.length) {
      this.ui.empty(taskSection, 'A clear task list', 'Open checkboxes from your notes will appear here.', 'list-checks');
      return;
    }
    const list = taskSection.createDiv({ cls: 'tangrow-task-list' });
    for (const task of openTasks.slice(0, 6)) {
      const label = task.text || this.ui.t('Untitled task');
      const row = list.createDiv({ cls: 'tangrow-task-item' });
      const check = row.createEl('button', { cls: 'tangrow-task-check', attr: { type: 'button', 'aria-label': this.ui.t('Complete: {task}', { task: label }) } });
      check.dataset.tangrowAction = `task-check-${task.path}:${task.line}`;
      setTooltip(check, this.ui.t('Mark done in the note'));
      check.addEventListener('click', () => {
        if (check.disabled) return;
        check.disabled = true;
        row.addClass('is-completing');
        void this.host.completeTask(task.path, task.line).catch((error: unknown) => {
          check.disabled = false;
          row.removeClass('is-completing');
          new Notice(describeError(this.host.settings.language, error));
        });
      });
      const open = this.ui.userButton(row, label, () => this.host.openNote(task.path, task.line), { cls: 'tangrow-task-row' });
      setTooltip(open, task.path);
    }
  }

  private mountCapture(): void {
    this.capturePanel = new CapturePanel(this.host);
    this.capturePanel.mount(this.pane);
  }

  private renderPins(state: Snapshot): void {
    this.pane.empty();
    this.ui.sectionHeading(this.pane, 'Keep it within reach', 'Pin important notes without changing their location.');
    this.ui.button(this.pane, state.activePinned ? 'Unpin current note' : 'Pin current note', () => this.host.action('toggle-pin'), {
      icon: state.activePinned ? 'pin-off' : 'pin', cls: 'tangrow-full-width', disabled: !state.active?.path.toLowerCase().endsWith('.md')
    });
    this.listHeading(this.pane, 'Your pinned notes', state.pins.length, 'pins');
    this.noteList(this.pane, state.pins, 'Save your bearings', 'Open a note and pin it to make it easy to find again.', 'pin');
    this.ui.sectionHeading(this.pane, 'Recently opened');
    this.noteList(this.pane, state.recentOpened.slice(0, this.recentOpenedLimit), 'Return to a recent file', 'Files you open will appear here.', 'history');
    if (state.recentOpened.length > this.recentOpenedLimit && this.recentOpenedLimit < 50) this.ui.button(this.pane, 'Show more opened files', () => {
      this.recentOpenedLimit = Math.min(50, this.recentOpenedLimit + 8);
      this.preserveFocus(() => this.renderPins(this.host.snapshot()));
    }, { icon: 'chevrons-down', cls: 'tangrow-full-width' });
  }

  private mountStudio(): void {
    this.syncStudio();
    this.studioHeading = this.pane.createEl('h3', { cls: 'tangrow-section-title', text: this.ui.t('A quiet writing corner') });
    this.studioCaption = this.pane.createEl('p', { cls: 'tangrow-section-caption', text: this.ui.t('Your scratchpad stays here until you turn it into a draft.') });
    const composer = this.pane.createDiv({ cls: 'tangrow-composer' });
    const title = composer.createEl('input', {
      cls: 'tangrow-title-input', type: 'text', attr: { placeholder: this.ui.t('Working title'), 'aria-label': this.ui.t('Draft title') }
    });
    title.value = this.scratchTitle;
    this.scratchTitleInput = title;
    // Unconfirmed IME text must not enter the shared, automatically saved draft.
    title.addEventListener('input', () => {
      if (!this.isMounted || this.scratchTitleInput !== title || !title.isConnected) return;
      if (this.scratchComposingControl === title) return;
      if (!this.host.updateWritingDraft({ title: title.value }, this.scratchRevision, this.viewId)) this.syncStudio();
    });
    const text = composer.createEl('textarea', {
      cls: 'tangrow-textarea tangrow-writing-area', attr: { placeholder: this.ui.t('Start with a sentence...'), 'aria-label': this.ui.t('Writing scratchpad'), rows: '12' }
    });
    text.value = this.scratch;
    this.scratchEditor = text;
    const footer = composer.createDiv({ cls: 'tangrow-composer-footer' });
    this.scratchCount = footer.createSpan({ cls: 'tangrow-muted' });
    this.scratchSaveButton = this.ui.button(footer, 'Save as draft', async () => {
      if (this.scratchSaving || !this.scratch.trim()) return;
      this.scratchSaving = true;
      this.updateStudioControls();
      try {
        await this.host.submitWritingDraft(this.scratchRevision, { leaf: this.leaf, editor: text });
      } finally {
        this.scratchSaving = false;
        this.updateStudioControls();
      }
    }, { icon: 'file-plus-2', cls: 'mod-cta' });
    text.addEventListener('input', () => {
      if (!this.isMounted || this.scratchEditor !== text || !text.isConnected) return;
      if (this.scratchComposingControl === text) return;
      if (!this.host.updateWritingDraft({ text: text.value }, this.scratchRevision, this.viewId)) this.syncStudio();
    });
    for (const control of [title, text]) {
      control.addEventListener('compositionstart', () => {
        if (!this.isStudioControl(control)) return;
        if (this.host.beginWritingDraftComposition(this.viewId, this.scratchRevision)) this.scratchComposingControl = control;
        this.syncStudio();
      });
      control.addEventListener('compositionend', () => {
        if (!this.isStudioControl(control) || this.scratchComposingControl !== control) return;
        this.host.updateWritingDraft(control === title ? { title: title.value } : { text: text.value }, this.scratchRevision, this.viewId);
        this.scratchComposingControl = undefined;
        this.host.endWritingDraftComposition(this.viewId);
        this.syncStudio();
      });
    }
    this.syncStudio();
    const history = this.pane.createDiv();
    this.refreshSection = (state) => {
      history.empty();
      this.listHeading(history, 'Drafts to return to', state.counts.drafts, 'drafts');
      this.noteList(history, state.drafts, 'Give an idea a little room', 'Drafts you save from the studio will appear here.', 'pen-line');
    };
  }

  private clearStudioControls(): void {
    if (this.host.loadWritingDraft().editingView === this.viewId) {
      if (this.scratchComposingControl === this.scratchEditor && this.scratchEditor) {
        this.host.updateWritingDraft({ title: this.scratchTitleInput?.value ?? this.scratchTitle }, this.scratchRevision, this.viewId);
      } else if (this.scratchComposingControl === this.scratchTitleInput && this.scratchTitleInput) {
        this.host.updateWritingDraft({ text: this.scratchEditor?.value ?? this.scratch }, this.scratchRevision, this.viewId);
      }
      this.host.endWritingDraftComposition(this.viewId);
    }
    this.scratchEditor = undefined;
    this.scratchComposingControl = undefined;
    this.scratchTitleInput = undefined;
    this.scratchSaveButton = undefined;
    this.scratchCount = undefined;
    this.studioHeading = undefined;
    this.studioCaption = undefined;
  }

  flushWritingDraft(): void { this.clearStudioControls(); }

  private refreshStudioLabels(): void {
    if (this.studioHeading) this.studioHeading.textContent = this.ui.t('A quiet writing corner');
    if (this.studioCaption) this.studioCaption.textContent = this.ui.t('Your scratchpad stays here until you turn it into a draft.');
    if (this.scratchTitleInput) {
      this.scratchTitleInput.placeholder = this.ui.t('Working title');
      this.scratchTitleInput.setAttribute('aria-label', this.ui.t('Draft title'));
    }
    if (this.scratchEditor) {
      this.scratchEditor.placeholder = this.ui.t('Start with a sentence...');
      this.scratchEditor.setAttribute('aria-label', this.ui.t('Writing scratchpad'));
    }
    if (this.scratchSaveButton) {
      const label = this.ui.t('Save as draft');
      this.scratchSaveButton.setAttribute('aria-label', label);
      const text = this.scratchSaveButton.querySelector('span:not(.tangrow-icon)');
      if (text) text.textContent = label;
    }
    this.updateStudioControls();
  }

  private isStudioControl(control: HTMLInputElement | HTMLTextAreaElement): boolean {
    return this.isMounted && control.isConnected && (control === this.scratchEditor || control === this.scratchTitleInput);
  }

  private syncStudio(): void {
    const draft = this.host.loadWritingDraft();
    this.scratch = draft.text;
    this.scratchTitle = draft.title;
    this.scratchRevision = draft.revision;
    const readOnly = draft.editingView !== undefined && draft.editingView !== this.viewId;
    for (const [control, value] of [[this.scratchEditor, draft.text], [this.scratchTitleInput, draft.title]] as const) {
      if (!control?.isConnected) continue;
      control.readOnly = readOnly;
      // IME can update the control before its input event reaches the shared draft.
      if (draft.editingView === this.viewId || control.value === value) continue;
      const focused = control.ownerDocument.activeElement === control;
      const start = control.selectionStart ?? 0;
      const end = control.selectionEnd ?? start;
      const direction = control.selectionDirection ?? undefined;
      const scrollTop = control.scrollTop;
      control.value = value;
      if (focused) control.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length), direction);
      control.scrollTop = scrollTop;
    }
    this.updateStudioControls();
  }

  private mountFocus(): void {
    this.ui.sectionHeading(this.pane, 'One thing at a time', 'Choose a session length. Completed sessions become local records.');
    const session = this.pane.createDiv();
    let signature: string | null = null;
    this.refreshSection = (state) => {
      const next = JSON.stringify([state.focus?.id, state.focus?.endsAt, state.focus?.remainingMs, state.counts.focusMinutes, this.focusMinutes, this.focusDefaultMinutes, this.customFocusMinutes]);
      if (next === signature) return;
      signature = next;
      session.empty();
      const card = session.createDiv({ cls: 'tangrow-focus-card' });
      card.createSpan({ cls: 'tangrow-eyebrow', text: this.ui.t(state.focus ? 'CURRENT SESSION' : 'A FRESH START') });
      this.clock = card.createDiv({ cls: 'tangrow-clock', attr: { role: 'timer', 'aria-label': this.ui.t('Focus time remaining') } });
      this.clockStatus = card.createDiv({ cls: 'tangrow-muted' });
      this.clockProgress = card.createEl('progress', { cls: 'tangrow-focus-progress', attr: { max: '1', value: '0', 'aria-label': this.ui.t('Focus session progress') } });
      if (state.focus?.filePath) {
        const path = state.focus.filePath;
        this.ui.userButton(card, path.split('/').pop()?.replace(/\.md$/, '') ?? path, () => this.host.openNote(path), { icon: 'file-text', cls: 'tangrow-focus-note' });
      }
      const controls = session.createDiv({ cls: 'tangrow-focus-controls' });
      if (!state.focus) {
        const options = controls.createDiv({ cls: 'tangrow-minute-presets', attr: { 'aria-label': this.ui.t('Session length presets') } });
        const inputRow = controls.createDiv({ cls: 'tangrow-minute-input' });
        const inputId = `${this.viewId}-focus-minutes`;
        inputRow.createEl('label', { text: this.ui.t('Minutes'), attr: { for: inputId } });
        const input = inputRow.createEl('input', { type: 'number', attr: { id: inputId, min: '1', max: '240', step: '1' } });
        input.value = String(this.focusMinutes);
        const hint = controls.createDiv({ cls: 'tangrow-duration-hint tangrow-muted' });
        const updateHint = () => { hint.textContent = this.customFocusMinutes ? this.ui.t('Custom session length') : this.ui.t('Using your default: {count} minutes', { count: this.ui.number(this.focusDefaultMinutes) }); };
        const updateMinutes = (value: number, useDefault = false) => {
          this.focusMinutes = Math.max(1, Math.min(240, Math.round(value || this.host.settings.focusMinutes)));
          this.customFocusMinutes = !useDefault && this.focusMinutes !== this.focusDefaultMinutes;
          input.value = String(this.focusMinutes);
          updateHint();
          this.updateClock();
        };
        input.addEventListener('input', () => {
          const value = Number(input.value);
          if (!Number.isInteger(value) || value < 1 || value > 240) return;
          this.focusMinutes = value;
          this.customFocusMinutes = value !== this.focusDefaultMinutes;
          updateHint();
          this.updateClock();
        });
        input.addEventListener('change', () => updateMinutes(Number(input.value)));
        for (const minutes of [15, 25, 45]) this.ui.userButton(options, this.ui.t('{count}m', { count: this.ui.number(minutes) }), () => updateMinutes(minutes), { cls: 'tangrow-preset' });
        this.ui.button(controls, 'Use default duration', () => updateMinutes(this.host.settings.focusMinutes, true), { cls: 'tangrow-text-button' });
        updateHint();
        this.ui.button(controls, 'Begin focus', () => {
          updateMinutes(Number(input.value));
          return this.host.startFocus(this.focusMinutes);
        }, { icon: 'play', cls: 'mod-cta tangrow-full-width' });
      } else {
        const actions = controls.createDiv({ cls: 'tangrow-actions' });
        if (state.focus.endsAt === null) this.ui.button(actions, 'Resume', () => this.host.resumeFocus(), { icon: 'play', cls: 'mod-cta' });
        else this.ui.button(actions, 'Pause', () => this.host.pauseFocus(), { icon: 'pause' });
        this.ui.button(actions, 'Finish & record', () => this.host.finishFocus(), { icon: 'check' });
        this.ui.button(controls, 'Discard session', () => this.host.cancelFocus(), { icon: 'x', cls: 'tangrow-text-button' });
      }
      const total = session.createDiv({ cls: 'tangrow-focus-total' });
      icon(total, 'timer');
      total.createSpan({ text: this.ui.t('{count} minutes recorded', { count: this.ui.number(state.counts.focusMinutes) }) });
      this.ui.button(session, 'Browse focus history', () => this.host.openBase('focus'), { icon: 'table', cls: 'tangrow-full-width' });
      this.ui.paragraph(session, 'The timer can recover after restart. Only time spent running counts toward a record.');
      this.updateClock(state);
    };
  }

  private syncFocusDuration(): void {
    const configured = this.host.settings.focusMinutes;
    if (configured === this.focusDefaultMinutes) return;
    this.focusDefaultMinutes = configured;
    if (!this.customFocusMinutes) this.focusMinutes = configured;
  }

  private updateClock(state = this.host.snapshot()): void {
    if (!this.clock) return;
    const remaining = state.focus ? state.focusRemainingMs : this.focusMinutes * 60_000;
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    this.clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    if (this.clockStatus) this.clockStatus.textContent = this.ui.t(!state.focus ? 'Ready when you are' : state.focus.endsAt === null ? 'Paused · take your time' : 'Focusing · keep going');
    if (this.clockProgress) this.clockProgress.value = state.focus ? Math.min(1, Math.max(0, 1 - remaining / state.focus.durationMs)) : 0;
  }

  private mountHabits(): void {
    this.ui.sectionHeading(this.pane, 'Small things, repeated', 'One check-in per habit per day. The last two weeks tell the story.');
    const form = this.pane.createEl('form', { cls: 'tangrow-habit-form' });
    const input = form.createEl('input', { type: 'text', attr: { placeholder: this.ui.t('Name a small habit'), 'aria-label': this.ui.t('New habit'), maxlength: '80' } });
    input.value = this.habitName;
    this.habitInput = input;
    this.habitAddButton = this.ui.button(form, 'Add habit', async () => {
      if (this.habitSaving) return;
      const name = this.habitName.trim();
      if (!name) return;
      const revision = this.habitRevision;
      this.habitSaving = true;
      this.updateHabitControls();
      try {
        await this.host.addHabit(name);
        if (this.isMounted && this.habitRevision === revision) {
          this.habitName = '';
          this.habitRevision++;
          if (this.habitInput?.isConnected) this.habitInput.value = '';
        }
        if (input.isConnected) input.focus();
      } finally {
        this.habitSaving = false;
        this.updateHabitControls();
      }
    }, { icon: 'plus' });
    input.addEventListener('input', () => { this.habitName = input.value; this.habitRevision++; this.updateHabitControls(); });
    form.addEventListener('submit', (event) => { event.preventDefault(); this.habitAddButton?.click(); });
    this.updateHabitControls();
    const list = this.pane.createDiv({ cls: 'tangrow-habit-list' });
    this.refreshSection = (state) => {
      list.empty();
      if (!state.habits.length) this.ui.empty(list, 'Start with something small', 'Try reading a page, taking a walk, or writing one paragraph.', 'calendar-check');
      for (const habit of state.habits) {
        const card = list.createDiv({ cls: 'tangrow-habit-card' });
        const heading = card.createDiv({ cls: 'tangrow-habit-heading' });
        const copy = heading.createDiv();
        copy.createEl('strong', { text: habit.name });
        copy.createDiv({ cls: 'tangrow-muted', text: this.ui.t(habit.streak === 1 ? '{count} day in a row' : '{count} days in a row', { count: this.ui.number(habit.streak) }) });
        this.ui.button(heading, habit.completedToday ? 'Done today' : 'Check in', () => this.host.checkHabit(habit.id), {
          icon: habit.completedToday ? 'circle-check' : 'circle', disabled: habit.completedToday,
          cls: habit.completedToday ? 'tangrow-checked' : ''
        });
        const days = card.createDiv({ cls: 'tangrow-habit-days', attr: { role: 'img', 'aria-label': this.ui.t('{name}: {count} check-ins in the last {days} days', { name: habit.name, count: this.ui.number(habit.days.filter(Boolean).length), days: this.ui.number(habit.days.length) }) } });
        for (const [index, completed] of habit.days.entries()) {
          const date = new Date();
          date.setDate(date.getDate() - (habit.days.length - index - 1));
          const day = days.createSpan({ cls: `tangrow-habit-day${completed ? ' is-complete' : ''}` });
          setTooltip(day, this.ui.t('{date}: {status}', { date: date.toLocaleDateString(this.host.settings.language), status: this.ui.t(completed ? 'checked in' : 'no check-in') }));
        }
        const footer = card.createDiv({ cls: 'tangrow-habit-footer' });
        footer.createSpan({ cls: 'tangrow-muted', text: this.ui.t('14 days · oldest to newest') });
        this.ui.button(footer, 'Archive', () => this.host.archiveHabit(habit.id), { icon: 'archive', cls: 'tangrow-text-button', title: 'Hide this habit. Existing check-in records are retained.' });
      }
      this.ui.button(list, 'Browse habit history', () => this.host.openBase('habits'), { icon: 'table', cls: 'tangrow-full-width' });
    };
  }

  private preserveFocus(render: () => void): void {
    const active = this.contentEl.ownerDocument.activeElement as HTMLElement | null;
    const hadFocus = active !== null && this.pane.contains(active);
    const action = active?.dataset.tangrowAction;
    const label = active?.getAttribute('aria-label');
    const previousButtons = Array.from(this.pane.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select'));
    const previousIndex = previousButtons.findIndex((entry) => entry === active);
    render();
    if (!hadFocus) return;
    const buttons = Array.from(this.pane.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select'));
    const replacement = buttons.find((entry) => action ? entry.dataset.tangrowAction === action : label && entry.getAttribute('aria-label') === label)
      ?? buttons[Math.min(previousIndex, buttons.length - 1)];
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  }

  private updateStudioControls(): void {
    if (this.scratchSaveButton) this.scratchSaveButton.disabled = this.scratchSaving || !this.scratch.trim() || this.host.loadWritingDraft().editingView !== undefined;
    if (this.scratchCount) this.scratchCount.textContent = this.ui.t('{count} words · saved locally', { count: this.ui.number(wordCount(this.scratch, this.host.settings.language)) });
  }

  private updateHabitControls(): void {
    if (this.habitAddButton) this.habitAddButton.disabled = this.habitSaving || !this.habitName.trim();
  }

  private listHeading(parent: HTMLElement, title: string, count: number, base: BaseId): void {
    const heading = parent.createDiv({ cls: 'tangrow-list-heading' });
    heading.createEl('h3', { cls: 'tangrow-section-title', text: this.ui.t(title) });
    this.ui.userButton(heading, this.ui.t('View all · {count}', { count: this.ui.number(count) }), () => this.host.openBase(base), { cls: 'tangrow-text-button' });
  }

  private noteList(parent: HTMLElement, notes: NoteSummary[], emptyTitle: string, emptyDetail: string, iconName: string): void {
    if (!notes.length) { this.ui.empty(parent, emptyTitle, emptyDetail, iconName); return; }
    const list = parent.createDiv({ cls: 'tangrow-note-list' });
    for (const note of notes) {
      const row = this.ui.userButton(list, note.name, () => this.host.openNote(note.path), { icon: iconName, cls: 'tangrow-note-row' });
      row.createSpan({ cls: 'tangrow-note-folder', text: note.folder || '/' });
      setTooltip(row, note.path);
    }
  }

  private openCreate(kind: QuickKind): void { this.host.openQuickAdd(kind); }
}
