import { AccessGate } from './access-gate';
import { ItemView, Notice, Platform, Scope, TFile, setTooltip } from 'obsidian';
import { describeError } from './i18n';
import type { WorkspaceLeaf } from 'obsidian';
import type { QuickKind } from './ai';
import { quickKinds } from './quick-add';
import type { ActionId, BaseId, Locale, NoteSummary, SidebarHost, Snapshot } from './types';
import { CapturePanel } from './capture-panel';
import { DraftComposition, recomposeHint, tracksComposition } from './draft-composition';
import { AiPanel } from './ai-panel';
import { writingStage } from './card-report-data';
import { readKnowledgeRecord } from './knowledge-index';
import { WorkbenchCards } from './workbench-cards';
import { captureDay } from './capture-data';
import { JOURNAL_LABELS, JOURNAL_PERIODS, journalInterval, type JournalPeriod } from './periodic-notes';
import { SidebarUI, icon } from './ui';
import { workbenchDestination, type ComposeTab, type KnowledgeTab, type MoreTab, type WorkbenchEntry, type WorkbenchTab } from './workbench-navigation';

export const VIEW_TYPE = 'tangrow-sidebar';

const SECTIONS: { id: WorkbenchTab; label: string; icon: string }[] = [
  { id: 'today', label: 'Today', icon: 'house' },
  { id: 'compose', label: 'Compose', icon: 'pen-line' },
  { id: 'knowledge', label: 'Knowledge', icon: 'brain' },
  { id: 'ai', label: 'AI', icon: 'sparkles' },
  { id: 'more', label: 'More workspaces', icon: 'ellipsis' }
];

const COMPOSE_TABS: Record<ComposeTab, string> = {
  captures: 'Captures', journal: 'Journal', scratchpad: 'Writing scratchpad', manuscripts: 'Manuscripts'
};
const KNOWLEDGE_TABS: Record<KnowledgeTab, string> = {
  materials: 'Knowledge materials', cards: 'Cards', hubs: 'Knowledge hubs', review: 'Card review'
};
const MORE_TABS: Record<MoreTab, string> = { pins: 'Pins', focus: 'Focus', habits: 'Habits', tools: 'File tools', databases: 'Databases' };

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
  private gate?: AccessGate;
  private trialDeadline?: HTMLElement;
  private unsubscribeAccess?: () => void;
  private isMounted = false;
  private section: WorkbenchTab = 'today';
  private composeTab: ComposeTab = 'captures';
  private knowledgeTab: KnowledgeTab = 'materials';
  private moreTab: MoreTab = 'pins';
  private workspacePane!: HTMLElement;
  private pane!: HTMLElement;
  private noteLabel!: HTMLElement;
  private setupBanner!: HTMLElement;
  private navButtons = new Map<WorkbenchTab, HTMLButtonElement>();
  private unsubscribe?: () => void;
  private dismissCreateMenu?: (restoreFocus?: boolean) => void;
  private unsubscribeComposer?: () => void;
  private refreshSection: (state: Snapshot) => void = () => undefined;
  private capturePanel?: CapturePanel;
  private readonly aiPanel: AiPanel;
  private readonly workbenchCards: WorkbenchCards;
  private selectedManuscript?: string;
  private journalPeriod: JournalPeriod = 'daily';
  private journalDay?: string;
  private shellLabels: Array<{ element: HTMLElement; source: string; tooltip?: boolean }> = [];
  private taskDraft = '';
  private taskSaving = false;
  private recentOpenedLimit = 8;
  private scratch = '';
  private scratchRevision = 0;
  private scratchSaving = false;
  private scratchEditor?: HTMLTextAreaElement;
  private scratchComposition?: DraftComposition;
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
    this.workbenchCards = new WorkbenchCards(host, this.ui, () => {
      if (this.isMounted && (this.section === 'today' || this.section === 'knowledge')) this.refreshSection(this.host.snapshot());
    }, (tab) => this.showKnowledge(tab), () => this.manuscript(this.host.snapshot())?.path, () => this.showCompose('manuscripts'));
  }

  /** Opens a workspace from a command or menu item. */
  showSection(entry: WorkbenchEntry): void {
    if (this.gate?.locked) return;
    const destination = workbenchDestination(entry);
    if (destination.tab === 'compose' && destination.page) this.showCompose(destination.page);
    else if (destination.tab === 'more' && destination.page) this.showMore(destination.page);
    else this.showWorkbench(destination.tab);
  }

  private showWorkbench(section: WorkbenchTab, changed = false): void {
    if (section === 'knowledge' && !this.host.settings.knowledgeEnabled) section = 'today';
    if (this.isMounted && (changed || this.section !== section)) this.selectSection(section);
    else this.section = section;
  }

  private showCompose(tab: ComposeTab): void {
    const changed = this.composeTab !== tab;
    this.composeTab = tab;
    this.showWorkbench('compose', changed);
  }

  private showKnowledge(tab: KnowledgeTab): void {
    const changed = this.knowledgeTab !== tab;
    this.knowledgeTab = tab;
    this.showWorkbench('knowledge', changed);
  }

  private showMore(tab: MoreTab): void {
    const changed = this.moreTab !== tab;
    this.moreTab = tab;
    this.showWorkbench('more', changed);
  }

  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return 'Tangrow'; }
  getIcon(): string { return 'sprout'; }

  async onOpen(): Promise<void> {
    this.isMounted = true;
    this.gate = new AccessGate(this.host, this.contentEl, locked => this.protectDrafts(locked), () => {
      this.capturePanel?.destroy();
      this.clearStudioControls();
      this.syncStudio();
      this.renderShell();
    });
    this.gate.mount();
    this.unsubscribeAccess = this.host.access.subscribe(event => { if (event === 'change') this.refreshTrialDeadline(); });
    this.syncStudio();
    if (!this.gate.locked) this.renderShell();
    this.unsubscribe = this.host.subscribe(() => { if (!this.gate?.locked) this.refresh(); });
    this.unsubscribeComposer = this.host.subscribeComposer(() => this.syncStudio());
    this.registerInterval(window.setInterval(() => { if (!this.gate?.locked) this.updateClock(); }, 1000));
  }

  refreshLanguage(): void {
    if (!this.isMounted) return;
    if (this.gate?.locked) { this.gate.refresh(); return; }
    this.dismissCreateMenu?.(true);
    const active = this.contentEl.ownerDocument.activeElement;
    const inputs = [this.scratchEditor, this.scratchTitleInput, this.habitInput];
    const focusedInput = inputs.findIndex((input) => input === active);
    const selection = focusedInput < 0 ? null : {
      start: inputs[focusedInput]?.selectionStart ?? 0,
      end: inputs[focusedInput]?.selectionEnd ?? 0
    };
    const focusedTab = Array.from(this.navButtons).find(([, control]) => control === active)?.[0];
    const composing = this.scratchComposition?.control.isConnected ?? false;
    const scrollTop = this.contentEl.scrollTop;
    this.preserveFocus(() => {
      this.refreshShellLabels();
      this.refreshNestedLabels();
      if (this.section === 'compose' && this.composeTab === 'captures' && this.capturePanel) {
        this.capturePanel.refresh();
        this.refresh();
      } else if (this.section === 'compose' && this.composeTab === 'scratchpad') {
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
      if (control) {
        control.setAttribute('aria-label', this.ui.t(item.label));
        setTooltip(control, this.ui.t(item.label));
      }
    }
    this.setupBanner.empty();
    this.refreshTrialDeadline();
  }

  private refreshTrialDeadline(): void {
    if (!this.trialDeadline) return;
    const { state, expiresAt } = this.host.access.snapshot();
    this.trialDeadline.hidden = state !== 'trial';
    this.trialDeadline.textContent = state === 'trial' && expiresAt !== null
      ? this.ui.t('Trial ends {date}', { date: new Date(expiresAt).toLocaleString(this.host.settings.language) }) : '';
  }

  private renderShell(): void {
    this.dismissCreateMenu?.();
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
    const add = headerTools.createEl('button', {
      cls: 'tangrow-header-add mod-cta',
      attr: { type: 'button', 'aria-label': this.ui.t('New'), 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': `${this.viewId}-create-menu` }
    });
    icon(add, 'plus');
    const addLabel = add.createSpan({ text: this.ui.t('New') });
    add.createSpan({ text: '▾', attr: { 'aria-hidden': 'true' } });
    setTooltip(add, this.ui.t('New'));
    add.addEventListener('click', () => {
      if (this.dismissCreateMenu) this.dismissCreateMenu(true);
      else this.openCreateMenu(add);
    });
    add.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      this.openCreateMenu(add, event.key === 'ArrowUp');
    });
    this.shellLabels.push({ element: add, source: 'New', tooltip: true }, { element: addLabel, source: 'New' });
    this.trialDeadline = this.contentEl.createEl('p', { cls: 'tangrow-muted' });
    this.refreshTrialDeadline();
    this.noteLabel = this.contentEl.createDiv({ cls: 'tangrow-context', attr: { 'aria-live': 'polite', hidden: '' } });
    const nav = this.contentEl.createDiv({ cls: 'tangrow-nav', attr: { role: 'tablist', 'aria-label': this.ui.t('Companion workspaces') } });
    for (const item of SECTIONS) {
      const itemButton = nav.createEl('button', {
        cls: 'tangrow-nav-item',
        attr: { type: 'button', role: 'tab', id: `${this.viewId}-tab-${item.id}`, 'aria-controls': `${this.viewId}-pane`, 'aria-selected': 'false', 'aria-label': this.ui.t(item.label) }
      });
      icon(itemButton, item.icon);
      itemButton.createSpan({ cls: 'tangrow-nav-label', text: this.ui.t(item.label) });
      setTooltip(itemButton, this.ui.t(item.label));
      itemButton.addEventListener('click', () => {
        this.showWorkbench(item.id);
      });
      itemButton.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const available = SECTIONS.filter((entry) => !this.navButtons.get(entry.id)?.hidden);
        const index = available.findIndex((entry) => entry.id === item.id);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length;
        const target = available[next];
        if (target) {
          this.showWorkbench(target.id);
          this.navButtons.get(target.id)?.focus({ preventScroll: true });
        }
      });
      this.navButtons.set(item.id, itemButton);
    }
    this.setupBanner = this.contentEl.createDiv({ cls: 'tangrow-setup' });
    this.workspacePane = this.contentEl.createDiv({ cls: 'tangrow-workspace-pane', attr: { role: 'tabpanel', id: `${this.viewId}-pane` } });
    this.selectSection(this.section);
  }

  private openCreateMenu(trigger: HTMLButtonElement, selectLast = false): void {
    this.dismissCreateMenu?.();
    const doc = trigger.ownerDocument;
    const win = doc.defaultView ?? window;
    const menu = doc.body.createDiv({
      cls: 'tangrow-create-menu',
      attr: { id: `${this.viewId}-create-menu`, role: 'menu', 'aria-label': this.ui.t('Quick add') }
    });
    // Menu's scope is not public, so keep these shortcuts in our own temporary scope.
    const scope = new Scope();
    const controls: HTMLButtonElement[] = [];
    const choose = (kind: QuickKind) => {
      this.dismissCreateMenu?.(true);
      if (this.host.requireAccess()) this.host.openQuickAdd(kind);
    };
    for (const [index, kind] of quickKinds(this.host.settings.knowledgeEnabled).entries()) {
      const shortcut = `${Platform.isMacOS ? '⌘' : 'Ctrl+'}${index + 1}`;
      const control = menu.createEl('button', {
        cls: 'tangrow-create-menu-item',
        attr: { type: 'button', role: 'menuitem', tabindex: '-1', 'aria-label': this.ui.t(kind.label) }
      });
      icon(control, kind.icon);
      control.createSpan({ cls: 'tangrow-create-menu-label', text: this.ui.t(kind.label) });
      control.createEl('kbd', { cls: 'tangrow-create-menu-shortcut', text: shortcut, attr: { 'aria-hidden': 'true' } });
      control.addEventListener('click', (event) => { event.stopPropagation(); choose(kind.id); });
      controls.push(control);
      scope.register(['Mod'], String(index + 1), (event) => { event.stopPropagation(); choose(kind.id); return false; });
    }
    const focus = (index: number) => controls[(index + controls.length) % controls.length]?.focus({ preventScroll: true });
    for (const [key, step] of [['ArrowDown', 1], ['ArrowUp', -1]] as const) {
      scope.register([], key, () => {
        const index = controls.findIndex((control) => control === doc.activeElement);
        focus(index < 0 ? (step > 0 ? 0 : controls.length - 1) : index + step);
        return false;
      });
    }
    scope.register([], 'Home', () => { focus(0); return false; });
    scope.register([], 'End', () => { focus(controls.length - 1); return false; });
    scope.register([], 'Escape', () => { this.dismissCreateMenu?.(true); return false; });
    for (const modifiers of [[], ['Shift']] as const) {
      scope.register([...modifiers], 'Tab', () => { this.dismissCreateMenu?.(true); });
    }
    const position = () => {
      const anchor = trigger.getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, win.innerWidth - bounds.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, win.innerHeight - bounds.height - 8))}px`;
    };
    const outsidePointer = (event: PointerEvent) => {
      const path = event.composedPath();
      if (!path.includes(menu) && !path.includes(trigger)) this.dismissCreateMenu?.();
    };
    const outsideFocus = () => {
      if (!menu.contains(doc.activeElement) && doc.activeElement !== trigger) this.dismissCreateMenu?.();
    };
    const blur = () => this.dismissCreateMenu?.();
    this.dismissCreateMenu = (restoreFocus = false) => {
      this.dismissCreateMenu = undefined;
      this.host.app.keymap.popScope(scope);
      doc.removeEventListener('pointerdown', outsidePointer, true);
      doc.removeEventListener('focusin', outsideFocus);
      doc.removeEventListener('scroll', position, true);
      win.removeEventListener('resize', position);
      win.removeEventListener('blur', blur);
      menu.remove();
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
    trigger.setAttribute('aria-expanded', 'true');
    this.host.app.keymap.pushScope(scope);
    doc.addEventListener('pointerdown', outsidePointer, true);
    doc.addEventListener('focusin', outsideFocus);
    doc.addEventListener('scroll', position, true);
    win.addEventListener('resize', position);
    win.addEventListener('blur', blur);
    position();
    focus(selectLast ? controls.length - 1 : 0);
  }

  async onClose(): Promise<void> {
    // The deadline can pass before its timer fires. Lock first so the gate rescues unsaved text, including a writing
    // preedit that closing would otherwise discard, before the controls are torn down.
    if (this.gate && !this.gate.locked && !this.host.access.canUse()) this.host.access.refresh();
    this.unsubscribeAccess?.();
    this.gate?.dispose();
    this.isMounted = false;
    this.workbenchCards.pause();
    this.dismissCreateMenu?.();
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

  private selectSection(section: WorkbenchTab): void {
    this.dismissCreateMenu?.();
    this.capturePanel?.destroy();
    this.capturePanel = undefined;
    this.aiPanel.destroy();
    this.section = section;
    for (const [id, item] of this.navButtons) {
      item.classList.toggle('is-active', id === section);
      item.setAttribute('aria-selected', String(id === section));
      item.tabIndex = id === section ? 0 : -1;
    }
    this.workspacePane.setAttribute('aria-labelledby', `${this.viewId}-tab-${section}`);
    this.workspacePane.empty();
    if (section === 'compose') this.renderNestedTabs('Compose views', COMPOSE_TABS, this.composeTab, (tab) => this.showCompose(tab));
    if (section === 'knowledge') this.renderNestedTabs('Knowledge views', KNOWLEDGE_TABS, this.knowledgeTab, (tab) => this.showKnowledge(tab));
    if (section === 'more') this.renderNestedTabs('More views', MORE_TABS, this.moreTab, (tab) => this.showMore(tab));
    this.pane = this.workspacePane.createDiv({ cls: 'tangrow-pane' });
    this.clearStudioControls();
    this.clock = undefined;
    this.clockStatus = undefined;
    this.clockProgress = undefined;
    this.refreshSection = () => undefined;
    const state = this.host.snapshot();
    switch (section) {
      case 'today': {
        let signature = '';
        this.refreshSection = (snapshot) => {
          const next = JSON.stringify([snapshot.counts, snapshot.tasks, snapshot.captures.filter((capture) => !capture.processed).length,
            this.manuscript(snapshot) ?? snapshot.drafts[0], new Date().toDateString(), this.taskSaving, this.host.settings.knowledgeEnabled, this.workbenchCards.homeSignature]);
          if (next === signature) return;
          signature = next;
          this.preserveFocus(() => this.renderToday(snapshot));
        };
        break;
      }
      case 'compose': {
        switch (this.composeTab) {
          case 'captures': this.mountCapture(); break;
          case 'journal': this.renderJournal(); break;
          case 'scratchpad': this.mountStudio(); break;
          case 'manuscripts': {
            let signature = '';
            this.refreshSection = (snapshot) => {
              const next = JSON.stringify([snapshot.drafts, snapshot.active?.path, this.selectedManuscript]);
              if (next === signature) return;
              signature = next;
              this.preserveFocus(() => this.renderManuscripts(snapshot));
            };
            break;
          }
        }
        break;
      }
      case 'knowledge': {
        this.refreshSection = () => this.preserveFocus(() => this.workbenchCards.renderKnowledge(this.pane, this.knowledgeTab));
        break;
      }
      case 'more': {
        const reportButton = this.actionButton(this.workspacePane, 'report', 'Open report', 'chart-no-axes-combined');
        reportButton.addClass('tangrow-more-report', 'tangrow-full-width');
        this.workspacePane.insertBefore(reportButton, this.pane);
        switch (this.moreTab) {
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
          case 'focus': this.mountFocus(); break;
          case 'habits': this.mountHabits(); break;
          case 'tools': {
            let signature = '';
            this.refreshSection = (snapshot) => {
              const next = JSON.stringify([snapshot.active?.path, snapshot.activePinned, snapshot.widePage, this.host.settings.wideByDefault, snapshot.counts.notes]);
              if (next === signature) return;
              signature = next;
              this.preserveFocus(() => {
                this.pane.empty();
                this.renderCurrentActions(snapshot);
                this.renderWorkspaceActions();
              });
            };
            break;
          }
          case 'databases': {
            this.ui.sectionHeading(this.pane, 'Your database views', 'Views query notes in their current folders.');
            const databases = this.pane.createDiv({ cls: 'tangrow-databases' });
            for (const base of BASES) this.ui.button(databases, base.label, () => this.host.openBase(base.id), { icon: base.icon });
            break;
          }
        }
        break;
      }
      case 'ai': {
        this.aiPanel.mount(this.pane);
        let signature = '';
        this.refreshSection = (snapshot) => {
          const next = JSON.stringify([snapshot.active?.path, this.host.aiReady(), this.host.agentStatus(), this.host.agentRun()]);
          if (signature && next !== signature) this.preserveFocus(() => this.aiPanel.refresh());
          signature = next;
        };
        break;
      }
    }
    this.refresh(state);
  }

  private renderNestedTabs<T extends string>(label: string, tabs: Record<T, string>, active: T, select: (tab: T) => void): void {
    const nav = this.workspacePane.createDiv({ cls: 'tangrow-chips tangrow-subnav', attr: { role: 'group', 'aria-label': this.ui.t(label) } });
    nav.dataset.workbenchLabel = label;
    for (const tab of Object.keys(tabs) as T[]) {
      const chip = nav.createEl('button', { cls: 'tangrow-chip', text: this.ui.t(tabs[tab]), attr: { type: 'button', 'aria-pressed': String(tab === active) } });
      chip.dataset.workbenchLabel = tabs[tab];
      chip.addEventListener('click', () => {
        if (tab === active) return;
        select(tab);
        this.workspacePane.querySelector<HTMLButtonElement>('.tangrow-subnav button[aria-pressed="true"]')?.focus({ preventScroll: true });
      });
    }
  }

  private refreshNestedLabels(): void {
    const elements = this.workspacePane.querySelectorAll<HTMLElement>('.tangrow-subnav[data-workbench-label], .tangrow-subnav button[data-workbench-label]');
    for (const element of Array.from(elements)) {
      const key = element.dataset.workbenchLabel;
      if (!key) continue;
      if (element.matches('button')) element.textContent = this.ui.t(key);
      else element.setAttribute('aria-label', this.ui.t(key));
    }
  }

  private refresh(snapshot = this.host.snapshot()): void {
    const enabled = this.host.settings.knowledgeEnabled;
    const knowledgeButton = this.navButtons.get('knowledge');
    if (knowledgeButton) {
      if (knowledgeButton.hidden !== !enabled) this.dismissCreateMenu?.(true);
      knowledgeButton.hidden = !enabled;
      knowledgeButton.parentElement?.classList.toggle('is-knowledge-disabled', !enabled);
    }
    if (!enabled && this.section === 'knowledge') {
      const focusedInWorkbench = this.contentEl.contains(this.contentEl.ownerDocument.activeElement);
      this.selectSection('today');
      if (focusedInWorkbench) this.navButtons.get('today')?.focus({ preventScroll: true });
      return;
    }
    this.syncFocusDuration();
    this.noteLabel.empty();
    this.noteLabel.hidden = !snapshot.active;
    if (snapshot.active) {
      icon(this.noteLabel, 'file-text');
      this.noteLabel.createSpan({ text: snapshot.active.name });
      setTooltip(this.noteLabel, snapshot.active.path);
    }
    const needsSetup = !snapshot.supportReady;
    this.setupBanner.hidden = !needsSetup;
    if (needsSetup && !this.setupBanner.hasChildNodes()) {
      this.setupBanner.createEl('strong', { text: this.ui.t('Add your companion views') });
      this.ui.paragraph(this.setupBanner, 'Create additive Bases in the support folder. Your existing notes stay where they are.');
      this.ui.button(this.setupBanner, 'Set up Bases', () => this.host.setup(), { icon: 'database', cls: 'mod-cta' });
    }
    this.refreshSection(snapshot);
    if (enabled && (this.section === 'today' || this.section === 'knowledge')) this.workbenchCards.refresh(this.section === 'knowledge' && this.knowledgeTab === 'review');
    else this.workbenchCards.pause();
    this.updateClock(snapshot);
  }

  private actionButton(parent: HTMLElement, id: ActionId, label: string, iconName: string, disabled = false, pressed?: boolean): HTMLButtonElement {
    const control = this.ui.button(parent, label, () => this.host.action(id), { icon: iconName, disabled, pressed });
    control.dataset.tangrowAction = id;
    return control;
  }

  private renderToday(state: Snapshot): void {
    this.pane.empty();
    const language = this.host.settings.language;
    const now = new Date();
    const pending = state.captures.filter((capture) => !capture.processed).length;
    const hero = this.pane.createDiv({ cls: 'tangrow-today' });
    hero.createDiv({ cls: 'tangrow-today-date', text: now.toLocaleDateString(language, { month: 'long', day: 'numeric' }) });
    hero.createDiv({ cls: 'tangrow-today-weekday', text: now.toLocaleDateString(language, { weekday: 'long' }) });
    const metrics = this.pane.createDiv({ cls: 'tangrow-overview tangrow-today-overview' });
    const cards: [number, string, string, () => void | Promise<void>][] = [
      [state.counts.tasks, 'open tasks', 'Open task overview', () => this.host.action('task-overview')],
      [pending, 'Pending captures', 'Review pending captures', () => {
        this.showCompose('captures');
        this.capturePanel?.showPending();
      }],
      [state.counts.drafts, 'Manuscripts', 'Browse manuscripts', () => this.showCompose('manuscripts')]
    ];
    for (const [value, label, title, open] of cards) {
      const metric = this.ui.userButton(metrics, this.ui.t(label), open, { cls: 'tangrow-metric', title: this.ui.t(title) });
      metric.setAttribute('aria-label', `${this.ui.t(title)} · ${this.ui.number(value)}`);
      metric.dataset.tangrowAction = title;
      metric.createEl('strong', { text: this.ui.number(value) });
      metric.prepend(metric.lastElementChild!);
    }
    const shortcuts = this.pane.createDiv({ cls: 'tangrow-actions tangrow-today-shortcuts' });
    const journal = this.ui.button(shortcuts, "Open today's journal", () => {
      this.journalPeriod = 'daily';
      this.journalDay = undefined;
      this.showCompose('journal');
      return this.host.openPeriodicNote('daily');
    }, { icon: 'calendar-days' });
    journal.dataset.tangrowAction = 'today-journal';
    this.actionButton(shortcuts, 'report', 'Open report', 'chart-no-axes-combined');
    if (this.host.settings.knowledgeEnabled) this.workbenchCards.renderToday(this.pane);
    const manuscript = this.manuscript(state) ?? state.drafts[0];
    if (manuscript) {
      this.ui.sectionHeading(this.pane, 'Continue writing');
      const open = this.ui.userButton(this.pane, manuscript.name, () => {
        this.selectedManuscript = manuscript.path;
        this.showCompose('manuscripts');
      }, { icon: 'pen-line', title: manuscript.path, cls: 'tangrow-full-width' });
      open.dataset.tangrowAction = 'today-manuscript';
    }
    this.renderTaskPreview(state);
  }

  private isMarkdown(state: Snapshot): boolean {
    return state.active?.path.toLowerCase().endsWith('.md') ?? false;
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
    this.actionButton(workspace, 'random-note', 'Rediscover a note', 'shuffle', this.host.snapshot().counts.notes === 0);
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
          if (this.section !== 'today') return;
          this.renderToday(this.host.snapshot());
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

  private renderJournal(): void {
    const day = this.journalDay ?? captureDay(Date.now());
    const controls = this.pane.createDiv({ cls: 'tangrow-journal-controls' });
    const group = controls.createDiv({ cls: 'tangrow-chips', attr: { role: 'group', 'aria-label': this.ui.t('Periodic notes') } });
    const periodButtons = new Map<JournalPeriod, HTMLButtonElement>();
    const summary = this.pane.createEl('p', { cls: 'tangrow-muted', attr: { 'aria-live': 'polite' } });
    const label = controls.createEl('label', { text: this.ui.t('Journal date'), cls: 'tangrow-workbench-field' });
    const date = label.createEl('input', { type: 'date', value: day, attr: { min: '0001-01-01', max: '9999-12-31' } });
    const open = this.ui.button(this.pane, 'Open journal', () => this.host.openPeriodicNote(this.journalPeriod, date.value), { icon: 'book-open', cls: 'mod-cta' });
    const update = () => {
      for (const [period, control] of periodButtons) control.setAttribute('aria-pressed', String(period === this.journalPeriod));
      open.disabled = !date.value || !date.validity.valid;
      if (open.disabled) { summary.textContent = ''; return; }
      const interval = journalInterval(this.journalPeriod, date.value);
      summary.textContent = interval.start === interval.end ? interval.start : `${interval.start} – ${interval.end}`;
    };
    for (const period of JOURNAL_PERIODS) {
      periodButtons.set(period, this.ui.button(group, JOURNAL_LABELS[period], () => {
        this.journalPeriod = period;
        update();
      }, { cls: 'tangrow-chip' }));
    }
    date.addEventListener('input', () => {
      this.journalDay = date.value && date.validity.valid ? date.value : undefined;
      update();
    });
    update();
  }

  private manuscript(state: Snapshot): NoteSummary | undefined {
    return state.drafts.find((draft) => draft.path === this.selectedManuscript);
  }

  private renderManuscripts(state: Snapshot): void {
    this.pane.empty();
    const target = this.manuscript(state);
    if (state.drafts.length) {
      const label = this.pane.createEl('label', { text: this.ui.t('Writing target'), cls: 'tangrow-workbench-field' });
      const selector = label.createEl('select');
      selector.dataset.tangrowAction = 'writing-target';
      selector.createEl('option', { text: this.ui.t('Choose a manuscript'), value: '' });
      for (const draft of state.drafts) selector.createEl('option', { text: draft.name, value: draft.path, attr: { title: draft.path } });
      selector.value = target?.path ?? '';
      selector.addEventListener('change', () => {
        this.selectedManuscript = selector.value || undefined;
        this.refreshSection(state);
      });
    }
    if (target) {
      const details = this.pane.createDiv({ cls: 'tangrow-workbench-card' });
      this.ui.sectionHeading(details, 'Continue writing');
      this.ui.userButton(details, target.name, () => this.host.openNote(target.path), { icon: 'file-pen-line', title: target.path, cls: 'tangrow-full-width' });
      this.renderManuscriptRelations(details, target);
      if (this.host.settings.knowledgeEnabled && state.active?.path && state.active.path !== target.path && this.isMarkdown(state)) {
        const source = state.active;
        this.ui.button(details, 'Add current note as a manuscript candidate', async () => {
          await this.host.addWritingMaterial(target.path, source.path);
          new Notice(this.ui.t('Added to manuscript candidates.'));
        }, { icon: 'link', cls: 'tangrow-full-width tangrow-text-button' });
      }
    } else if (!state.drafts.length) {
      this.ui.empty(this.pane, 'No manuscripts yet', 'A draft saved from the writing scratchpad appears here.', 'pen-line');
      this.ui.button(this.pane, 'Writing scratchpad', () => this.showCompose('scratchpad'), { icon: 'pen-line', cls: 'tangrow-full-width' });
    }
    if (state.drafts.length) this.listHeading(this.pane, 'Drafts to return to', state.counts.drafts, 'drafts');
  }

  private renderManuscriptRelations(parent: HTMLElement, target: NoteSummary): void {
    const file = this.host.app.vault.getAbstractFileByPath(target.path);
    if (!(file instanceof TFile)) return;
    const cache = this.host.app.metadataCache.getFileCache(file);
    if (!cache) {
      this.ui.paragraph(parent, 'Building knowledge links…');
      return;
    }
    const stage = writingStage({ path: file.path, name: file.basename, created: file.stat.ctime, modified: file.stat.mtime, frontmatter: cache.frontmatter });
    const stageLabel = { outline: 'Outline', drafting: 'Drafting', revising: 'Revising', finished: 'Finished', published: 'Published',
      unset: 'Writing stage not set', unknown: 'Unrecognized writing stage' }[stage];
    this.ui.paragraph(parent, stageLabel);
    const record = readKnowledgeRecord(this.host.app.metadataCache, file, cache);
    if (!record) return;
    for (const [title, entries] of [['Candidate material', record.materials], ['Body citations', record.body]] as const) {
      const group = parent.createEl('details', { cls: 'tangrow-manuscript-links' });
      group.createEl('summary', { text: `${this.ui.t(title)} · ${this.ui.number(entries.length)}` });
      for (const link of entries) {
        const path = link.path;
        if (!path) {
          group.createEl('p', { text: `${link.raw} · ${this.ui.t('Unavailable')}`, cls: 'tangrow-muted' });
          continue;
        }
        const related = this.host.app.vault.getAbstractFileByPath(path);
        this.ui.userButton(group, related instanceof TFile ? related.basename : path, () => this.host.openNote(path, undefined, link.anchor || undefined),
          { cls: 'tangrow-full-width tangrow-text-button', title: `${path}${link.anchor}` });
      }
    }
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
    for (const [field, control] of [['title', title], ['text', text]] as const) {
      const compositionForControl = () => {
        const composition = this.scratchComposition;
        return composition?.control === control ? composition : undefined;
      };
      const updateField = () => {
        if (!this.host.updateWritingDraft({ [field]: control.value }, this.scratchRevision, this.viewId)) this.syncStudio();
      };
      const suggestRecomposition = () => {
        if (this.isStudioControl(control) && this.host.access.canUse()) new Notice(this.ui.t(recomposeHint));
      };
      control.addEventListener('input', event => {
        if (!this.isStudioControl(control)) return;
        if (compositionForControl()) return;
        if ((event as InputEvent).isComposing && tracksComposition()) return;
        updateField();
      });
      control.addEventListener('compositionstart', () => {
        if (!this.isStudioControl(control) || !tracksComposition()) return;
        this.scratchComposition?.flush();
        if (!this.isStudioControl(control)) return;
        if (this.host.beginWritingDraftComposition(this.viewId, this.scratchRevision)) {
          this.scratchComposition?.dispose();
          this.scratchComposition = new DraftComposition(control);
        }
        this.syncStudio();
      });
      control.addEventListener('keydown', event => {
        if (this.isStudioControl(control)) compositionForControl()?.keyDown(event as KeyboardEvent);
      });
      control.addEventListener('compositionend', () => {
        const composition = compositionForControl();
        if (!this.isStudioControl(control)) {
          if (!composition) return;
          // The control stopped being editable mid-composition. Drop the tracking and lease so neither lingers.
          composition.dispose();
          this.scratchComposition = undefined;
          this.host.endWritingDraftComposition(this.viewId);
          return;
        }
        if (!composition && tracksComposition()) return;
        if (!this.host.access.canUse()) {
          this.host.access.refresh();
          return;
        }
        if (!composition) {
          // Android keyboards can deliver the final replacement without another input event.
          updateField();
          return;
        }
        composition.settle(confirmed => {
          // Closing, a lock or a new composition took over in the meantime and already released the lease.
          if (this.scratchComposition !== composition) return;
          if (!this.host.access.canUse()) {
            this.host.access.refresh();
            return;
          }
          composition.dispose();
          this.scratchComposition = undefined;
          if (this.isStudioControl(control)) {
            if (confirmed) this.host.updateWritingDraft({ [field]: control.value }, this.scratchRevision, this.viewId);
            else composition.restore(suggestRecomposition);
          }
          this.host.endWritingDraftComposition(this.viewId);
          this.syncStudio();
        });
      });
    }
    this.syncStudio();
    const history = this.pane.createDiv();
    this.refreshSection = (state) => {
      history.empty();
      this.listHeading(history, 'Drafts to return to', state.counts.drafts, 'drafts');
      this.noteList(history, state.drafts.slice(0, 12), 'Give an idea a little room', 'Drafts you save from the studio will appear here.', 'pen-line');
    };
  }

  private clearStudioControls(): void {
    if (this.host.loadWritingDraft().editingView === this.viewId) {
      const control = this.scratchComposition?.control;
      if (control && control === this.scratchEditor) {
        this.host.updateWritingDraft({ title: this.scratchTitleInput?.value ?? this.scratchTitle }, this.scratchRevision, this.viewId);
      } else if (control && control === this.scratchTitleInput) {
        this.host.updateWritingDraft({ text: this.scratchEditor?.value ?? this.scratch }, this.scratchRevision, this.viewId);
      }
      this.host.endWritingDraftComposition(this.viewId);
    }
    this.scratchEditor = undefined;
    this.scratchComposition?.dispose();
    this.scratchComposition = undefined;
    this.scratchTitleInput = undefined;
    this.scratchSaveButton = undefined;
    this.scratchCount = undefined;
    this.studioHeading = undefined;
    this.studioCaption = undefined;
  }

  private protectDrafts(locked: boolean): void {
    this.dismissCreateMenu?.();
    if (locked) this.workbenchCards.pause();
    this.capturePanel?.protectDraft(locked);
    const editor = this.scratchEditor;
    const title = this.scratchTitleInput;
    if (!editor || !title) return;
    if (!editor.readOnly || this.host.loadWritingDraft().editingView === this.viewId) {
      this.scratchComposition?.restoreIfEscaped();
      this.host.updateWritingDraft({ text: editor.value, title: title.value }, this.scratchRevision, this.viewId);
      this.scratchComposition?.dispose();
      this.scratchComposition = undefined;
      this.host.endWritingDraftComposition(this.viewId);
    }
    if (locked) editor.readOnly = title.readOnly = true;
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
    return !this.gate?.locked && this.isMounted && control.isConnected && !control.readOnly &&
      (control === this.scratchEditor || control === this.scratchTitleInput);
  }

  private syncStudio(): void {
    const draft = this.host.loadWritingDraft();
    this.scratch = draft.text;
    this.scratchTitle = draft.title;
    this.scratchRevision = draft.revision;
    const readOnly = !!this.gate?.locked || draft.editingView !== undefined && draft.editingView !== this.viewId;
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

}
