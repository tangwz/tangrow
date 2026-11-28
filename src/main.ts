import { FileView, MarkdownView, Menu, Modal, Notice, Plugin, Setting, TFile, TFolder, moment, parseYaml, getFrontMatterInfo, resolveSubpath, stringifyYaml, stripHeadingForLink, setTooltip, type Command, type EventRef, type WorkspaceLeaf } from 'obsidian';
import { baseDefinitions, setupReadme, managedFileTranslations } from './bases';
import { Platform, requestUrl } from 'obsidian';
import { Access, LICENSE_KEYS, LICENSE_ENDPOINT } from './access';
import { OWNER_BUILD } from './build-flags';
import { accessCoordination } from './access-coordination';
import { TangrowSettings } from './settings/tab';
import { randomBytes } from './license/format';
import { focusMinutes, pauseSession, remainingMs, resumeSession, startSession } from './focus';
import { dayKey, inFolder, readSession, readSettings, recentDays, safeFolder, safeTitle, streak } from './model';
import { openActivationSettings, openNativeSettings, revealInFileList, runNativeCommand } from './compat';
import { TangrowSidebar, VIEW_TYPE } from './sidebar';
import { TangrowReport, REPORT_VIEW_TYPE } from './report';
import { TangrowCapture, CAPTURE_VIEW_TYPE, openCaptureWindow as revealCaptureWindow } from './capture-window';
import { captureCreated, parseNoteTimestamp, sortCaptures } from './capture-data';
import { captureIsProcessed, captureProjectFiles, processCapturedNote } from './capture-processing';
import { AI_SECRET_ID, agentGuide, buildSuggestionPrompt, parseSuggestion, readAiModel, type CaptureSuggestion, type QuickKind } from './ai';
import { CLAUDIAN_OPEN_COMMAND, CLAUDIAN_TURN_ENDED, WORKFLOWS, claudianApi, skillFiles, workflowPrompt, type AgentStatus, type ClaudianAPI, type WorkflowId, type WorkflowRun } from './claudian';
import { runPrompt } from './ai-client';
import { QuickAddModal } from './quick-add';
import { appendTaskLine, completeTaskLine, indexedTaskLabel, taskLine } from './task-tools';
import { parseTaskDisplay } from './task-display';
import { findSubmittedNote, readDraftSubmissions, readRecoveryDrafts, type DraftSubmission, type DraftSubmissions, type RecoveryLabel, type StoredRecoveryDraft, type SubmissionKind } from './draft-submissions';
import { JOURNAL_PERIODS, JOURNAL_LABELS, defaultJournal, journalInterval, journalPath, journalTemplate, type JournalPeriod } from './periodic-notes';
import { ImmersiveCapture, NoteImmersion } from './immersive';
import { normalizeRecentOpened, recordRecentOpened, renameRecentOpened, removeRecentOpened } from './recent-opened';
import { stampHeadingDate } from './note-tools';
import { matchesGeneratedContent } from './managed-files';
import { hasValidSupportFolder, SupportFolderConflictError, validateFolderSettings, type FolderSettingKey } from './folders';
import { moveSupportFolder } from './support-migration';
import { addEditingActivity, createActivityState, normalizeActivityState, summarizeActivity, type EditingActivityState } from './activity';
import { ReportSource } from './report-source';
import { captureWritingNavigation } from './writing-navigation';
import { aggregateReport } from './report-data';
import { buildWorkbenchPara, hasProjectMetadataValue, projectMetadataOwner, readProjectType, workbenchPathIncluded, type ProjectNoteProperty, type WorkbenchArea,
  type WorkbenchLinkCandidate, type WorkbenchParaData, type WorkbenchProject, type WorkbenchProjectRecord, type WorkbenchProjectTaskSource,
  type WorkbenchProjectType } from './project-workbench-data';
import { canonicalEntityNotes, reportStatusSource } from './report-metrics';
import { writeReportStatus } from './report-editing';
import { buildCardReport, buildWorkbenchCards, type CardFilter } from './card-report-data';
import { readCardReviewQueue, type CardReviewQueue } from './card-review';
import { readKnowledgeRecord, resolvePropertyLink } from './knowledge-index';
import { rebaseMarkdownLinks } from './markdown-links';
import type { ReportDestination, ReportPreferences, ReportRange, ReportRecord, ReportResource, ReportSnapshot, ReportStatusChange } from './report-contract';
import { translate, describeError, type TranslationValues } from './i18n';
import { DEFAULT_SETTINGS, type CaptureRequest, type CardSource, type ComposerState, type Habit, type Locale, type ActionId, type BaseId, type FocusSession, type NoteKind, type NoteSummary, type Settings, type SidebarHost, type Snapshot, type TaskSummary, type WritingDraft, type WritingSaveOrigin } from './types';

const dateTime = moment as unknown as (input?: number | string | Date) => { format(pattern: string): string };

interface SavedData { version: number; settings: Settings; focus: FocusSession | null; scratch: string; composer: ComposerState; submissions: DraftSubmissions; recoveryDrafts: StoredRecoveryDraft[]; recentOpened: string[]; activity: EditingActivityState; cardReviews: CardReviewQueue[] }
interface PersistenceCoordinator { owner?: symbol; tail: Promise<void> }
type WorkbenchCards = Awaited<ReturnType<SidebarHost['loadWorkbenchCards']>>;
const PERSISTENCE_COORDINATOR = Symbol.for('tangrow.persistence-coordinator');

class PromptModal extends Modal {
  constructor(app: Plugin['app'], private title: string, private placeholder: string, private submit: (value: string) => Promise<void>, private language: Locale, private readonly onDismiss?: () => void) { super(app); }
  onOpen(): void {
    this.setTitle(translate(this.language, this.title));
    let value = '';
    let saving = false;
    new Setting(this.contentEl).addText((input) => {
      input.setPlaceholder(translate(this.language, this.placeholder)).onChange((text) => { value = text; });
      input.inputEl.style.width = '100%';
      input.inputEl.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        void save();
      });
      input.inputEl.ownerDocument.defaultView?.setTimeout(() => input.inputEl.focus(), 0);
    });
    const save = async (): Promise<void> => {
      if (saving) return;
      saving = true;
      try { await this.submit(value); this.close(); }
      catch (error) { new Notice(describeError(this.language, error)); }
      finally { saving = false; }
    };
    new Setting(this.contentEl).addButton((button) => button.setButtonText(translate(this.language, 'Save')).setCta().onClick(save));
  }
  onClose(): void { this.contentEl.empty(); this.onDismiss?.(); }
}

function uid(): string { return crypto.randomUUID(); }
type LocalSettingsPatch = Partial<Pick<Settings, 'autoOpen' | 'focusMinutes' | 'taskOverviewPath' | 'wideByDefault'>>;
type SecretAccess = { getSecret(id: string): string | null; setSecret(id: string, value: string): void };

export default class TangrowPlugin extends Plugin implements SidebarHost {
  access!: Access;
  settings: Settings = readSettings(DEFAULT_SETTINGS);
  private focus: FocusSession | null = null;
  private scratch = '';
  private scratchRevision = 0;
  private scratchSubmissions = new Map<number, Promise<void>>();
  private scratchEditingView: string | undefined;
  private composer: ComposerState = { capture: '', scratchTitle: '' };
  private composerListeners = new Set<() => void>();
  private captureRevision = 0;
  private captureSubmissions = new Map<number, Promise<void>>();
  private submissions: DraftSubmissions = { capture: null, writing: null };
  private recoveryDrafts = new Map<string, StoredRecoveryDraft>();
  private recoveryListeners = new Set<() => void>();
  private quickAddSaves = new Set<string>();
  private recoverySaves = new Map<StoredRecoveryDraft, Promise<void>>();
  private recentOpened: string[] = [];
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  private persistenceOwner = Symbol('tangrow-instance');
  private persistenceClaimed = false;
  private operations: Promise<unknown> = Promise.resolve();
  private scratchTimer: number | undefined;
  private refreshTimer: number | undefined;
  private cachedSnapshot: Snapshot | null = null;
  private widePages = new Set<string>();
  private finishing = false;
  private cachedDay = dayKey();
  private taskLabels = new Map<string, { mtime: number; lines: Map<number, string> }>();
  private taskReads = new Set<string>();
  private alive = true;
  private dataLoaded = false;
  private commandsRegistered = false;
  private ribbon: HTMLElement | null = null;
  private readonly reportSource = new ReportSource(this.app, resolveSubpath);
  private workbenchCards?: { records: ReportRecord[]; scope: string; cards: WorkbenchCards };
  private workbenchParaIndex?: { openTasks: TaskSummary[]; data: WorkbenchParaData };
  private readonly cardReviews = new Map<string, CardReviewQueue>();
  private editingActivity = createActivityState();
  private lastActivityEvent: number | null = null;
  private activityTimer: number | undefined;
  private watchedWindows = new WeakSet<Window>();
  private quickAdds = new Set<QuickAddModal>();
  private notePrompts = new Set<PromptModal>();
  private immersiveCapture?: ImmersiveCapture;
  private noteImmersion?: NoteImmersion;
  private noteImmersionAction?: HTMLElement;
  private noteImmersionActionView?: MarkdownView;
  /** Replaceable so tests never reach the network. */
  aiRunner: typeof runPrompt = runPrompt;
  private workflow: WorkflowRun | null = null;

  async onload(): Promise<void> {
    const coordinator = this.persistenceCoordinator();
    await coordinator.tail;
    if (!this.alive) return;
    const stored = (await this.loadData() ?? null) as Partial<SavedData> | null;
    if (!this.alive) return;
    coordinator.owner = this.persistenceOwner;
    this.persistenceClaimed = true;
    this.settings = readSettings(stored?.settings);
    if (Array.isArray(stored?.cardReviews)) {
      for (const entry of stored.cardReviews) {
        const queue = readCardReviewQueue(entry);
        if (queue) this.cardReviews.set(queue.day, queue);
      }
    }
    this.editingActivity = normalizeActivityState(stored?.activity);
    if (!hasValidSupportFolder(this.settings)) {
      new Notice(this.t('The companion folder conflicts with a content folder. Update the folder settings before creating companion files.'));
    }
    this.focus = readSession(stored?.focus);
    this.scratch = typeof stored?.scratch === 'string' ? stored.scratch : '';
    this.composer = {
      capture: typeof stored?.composer?.capture === 'string' ? stored.composer.capture : '',
      scratchTitle: typeof stored?.composer?.scratchTitle === 'string' ? stored.composer.scratchTitle : ''
    };
    this.submissions = readDraftSubmissions(stored?.submissions);
    this.recoveryDrafts = readRecoveryDrafts(stored?.recoveryDrafts);
    const hasHistory = stored !== null && Object.hasOwn(stored, 'recentOpened');
    this.recentOpened = normalizeRecentOpened(hasHistory ? stored.recentOpened : this.app.workspace.getLastOpenFiles(), (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
    this.dataLoaded = true;
    try { await this.recoverSubmittedDrafts(); }
    catch (error) { new Notice(this.error(error)); }
    if (!this.alive) return;
    if (this.focus) {
      const session = this.focus;
      try {
        const recordedMinutes = await this.recordedFocusMinutes(session);
        if (!this.alive) return;
        if (recordedMinutes !== null) {
          this.focus = { ...session, remainingMs: Math.max(0, session.durationMs - recordedMinutes * 60_000), endsAt: null };
          await this.persist();
        }
      } catch (error) { new Notice(this.error(error)); }
    }
    if (!this.alive) return;
    this.access = new Access({
      storage: () => window.localStorage, coordination: accessCoordination(window),
      now: Date.now, bytes: randomBytes, jitter: Math.random, keys: LICENSE_KEYS, ownerBuild: OWNER_BUILD,
      platform: Platform.isIosApp ? 'iOS' : Platform.isAndroidApp ? 'Android' : Platform.isMacOS ? 'macOS' : Platform.isWin ? 'Windows' : 'Linux',
      version: this.manifest.version, later: (callback, delay) => window.setTimeout(callback, delay), cancel: timer => window.clearTimeout(timer),
      warn: message => console.warn(message), request: (path, body) => requestUrl({ url: LICENSE_ENDPOINT + path, method: 'POST',
        contentType: 'application/json', body: JSON.stringify(body), throw: false })
    });
    this.access.start();
    let usable = this.access.canUse();
    this.access.subscribe(event => {
      const next = this.access.canUse();
      if (event !== 'change' || (usable && !next)) {
        this.lastActivityEvent = null;
        // The write queue snapshots after all synchronous draft listeners have flushed.
        void this.persist().catch(error => new Notice(this.error(error)));
      }
      usable = next;
    });
    this.registerDomEvent(window, 'storage', event => {
      if (event.key === null || /^tangrow:(device|lease|trial):v1$/.test(event.key)) this.access.refresh(false, false);
    });
    this.registerDomEvent(window, 'online', () => this.access.onResume('online'));
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new TangrowSidebar(leaf, this));
    this.registerView(REPORT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TangrowReport(leaf, this));
    this.registerView(CAPTURE_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TangrowCapture(leaf, this));
    if (!stored?.settings?.language && this.settings.language === 'zh-CN') {
      await this.localizeManagedFiles('en');
      await this.persist();
    }
    if (stored?.version !== 5 || !hasHistory || JSON.stringify(stored.recentOpened) !== JSON.stringify(this.recentOpened)) {
      try { await this.persist(); } catch (error) { new Notice(this.error(error)); }
    }
    if (!this.alive) return;
    this.ribbon = this.addRibbonIcon('sprout', this.t('Open Tangrow'), () => { void this.openSidebar().catch((error) => new Notice(this.error(error))); });
    this.registerCommands();
    this.addSettingTab(new TangrowSettings(this));
    const refresh = (): void => this.scheduleRefresh();
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (file instanceof TFile) this.updateRecentOpened(recordRecentOpened(this.recentOpened, file.path, (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile));
      refresh();
    }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      this.noteImmersion?.close();
      this.bindNoteImmersionAction();
      this.lastActivityEvent = null;
      refresh();
    }));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => this.recordEditingActivity(info)));
    this.registerEvent(this.app.workspace.on('editor-menu', (menu: Menu, editor, info) => {
      const selection = editor.getSelection().trim();
      if (!selection) return;
      const add = (title: string, iconName: string, run: () => void): void => {
        menu.addItem((item) => item.setTitle(this.t(title)).setIcon(iconName).onClick(() => { if (this.requireAccess()) run(); }));
      };
      add('Tangrow: add selection as task', 'square-check-big', () => this.openQuickAdd('task', selection));
      add('Tangrow: capture selection', 'inbox', () => this.openQuickAdd('capture', selection));
      if (this.settings.knowledgeEnabled && info?.file?.extension === 'md') {
        const file = info.file;
        const line = editor.getCursor('from').line;
        const heading = this.app.metadataCache.getFileCache(file)?.headings?.filter((entry) => entry.position.start.line <= line).at(-1);
        // Raw heading text can contain `|`, `#` or `]]`, which would split or end the generated link.
        const anchor = heading ? stripHeadingForLink(heading.heading) : '';
        const source: CardSource = { path: file.path, anchor: anchor ? `#${anchor}` : undefined };
        add('Tangrow: extract selection to card', 'sticky-note', () => this.openQuickAdd('card', `${file.basename}\n\n${selection}`, source));
      }
    }));
    // Claudian announces every finished turn; only the session a workflow was sent to matters here.
    this.registerEvent((this.app.workspace as unknown as { on(name: string, callback: (event: { sessionId?: string }) => void): EventRef })
      .on(CLAUDIAN_TURN_ENDED, (event) => { void this.finishWorkflow(event?.sessionId); }));
    this.registerEvent(this.app.workspace.on('window-open', (_workspaceWindow, win) => this.watchWindow(win)));
    if (typeof window !== 'undefined' && window.document) this.watchWindow(window);
    this.registerEvent(this.app.metadataCache.on('changed', () => { this.reportSource.markLinksDirty(); refresh(); }));
    this.registerEvent(this.app.metadataCache.on('resolved', () => { this.reportSource.markLinksResolved(); refresh(); }));
    this.registerEvent(this.app.vault.on('create', (file) => { if (file instanceof TFile && file.extension === 'md') this.reportSource.markLinksDirty(); refresh(); }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file instanceof TFile && file.extension === 'md') this.reportSource.markLinksDirty();
      this.updateRecentOpened(removeRecentOpened(this.recentOpened, file.path));
      refresh();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if ((file instanceof TFile && file.extension === 'md') || (file instanceof TFolder && this.app.vault.getMarkdownFiles().some((note) => inFolder(note.path, file.path)))) this.reportSource.markLinksDirty();
      if (this.widePages.delete(oldPath)) this.widePages.add(file.path);
      this.updateRecentOpened(renameRecentOpened(this.recentOpened, oldPath, file.path, (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile));
      refresh();
    }));
    this.registerMarkdownPostProcessor((element, context) => {
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!(file instanceof TFile)) return;
      const cover = this.app.metadataCache.getFileCache(file)?.frontmatter?.tangrow_cover;
      if (typeof cover !== 'string' || element.parentElement?.querySelector('.tangrow-note-cover')) return;
      if (!element.querySelector('h1')) return;
      const image = this.app.metadataCache.getFirstLinkpathDest(cover, file.path);
      if (!image || !['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(image.extension.toLowerCase())) return;
      const banner = element.createEl('img', { cls: 'tangrow-note-cover', attr: { src: this.app.vault.getResourcePath(image), alt: this.t('Note cover') } });
      element.prepend(banner);
    });
    this.registerInterval(window.setInterval(() => {
      if (this.cachedDay !== dayKey()) { this.cachedDay = dayKey(); this.notify(); }
      if (this.focus?.endsAt !== null && this.focus && remainingMs(this.focus, Date.now()) <= 0 && !this.finishing && hasValidSupportFolder(this.settings)) {
        void this.finishFocus().catch((error) => new Notice(this.t('Could not save focus session: {error}', { error: this.error(error) })));
      }
    }, 1000));
    this.app.workspace.onLayoutReady(() => {
      if (!this.alive) return;
      this.bindNoteImmersionAction();
      this.applyWidths();
      if (this.settings.autoOpen) void this.openSidebar().catch((error) => new Notice(this.error(error)));
    });
  }

  onunload(): void {
    this.access?.refresh();
    for (const modal of this.quickAdds) modal.close();
    for (const modal of this.notePrompts) modal.close();
    this.access?.dispose();
    this.immersiveCapture?.close();
    this.noteImmersion?.close();
    this.noteImmersionAction?.remove();
    if (this.dataLoaded) {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof TangrowSidebar) leaf.view.flushWritingDraft();
      }
    }
    this.alive = false;
    if (this.dataLoaded) {
      this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
      this.app.workspace.getLeavesOfType(REPORT_VIEW_TYPE).forEach((leaf) => leaf.detach());
      this.app.workspace.getLeavesOfType(CAPTURE_VIEW_TYPE).forEach((leaf) => leaf.detach());
      void this.persist(true).catch((error) => console.error('Tangrow save failed', error));
      this.app.workspace.iterateAllLeaves((leaf) => leaf.view.containerEl.removeClass('tangrow-wide'));
    }
    window.clearTimeout(this.scratchTimer);
    window.clearTimeout(this.refreshTimer);
    window.clearTimeout(this.activityTimer);
    this.lastActivityEvent = null;
    this.listeners.clear();
    this.composerListeners.clear();
    this.recoveryListeners.clear();
  }

  t(source: string, values?: TranslationValues): string { return translate(this.settings.language, source, values); }
  error(error: unknown): string {
    if (error instanceof SupportFolderConflictError) return this.t('The companion folder {support} must not equal or contain the content folder {content}.', { support: error.supportFolder, content: error.contentFolder });
    return describeError(this.settings.language, error);
  }

  openActivationSettings(): void {
    if (!openActivationSettings(this.app, this.manifest.id)) {
      new Notice(this.t('Open Settings → Tangrow → Activation and updates.'));
    }
  }

  requireAccess(): boolean {
    if (this.access.canUse()) return true;
    this.access.refresh();
    new Notice(this.t('Activate Tangrow to use this feature.'));
    this.openActivationSettings();
    return false;
  }

  private registerAccessCommand(command: Pick<Command, 'id' | 'name' | 'callback' | 'checkCallback'>): void {
    const { callback, checkCallback, id } = command;
    if (checkCallback) {
      this.addCommand({ ...command, checkCallback: checking => {
        if (id === 'toggle-note-immersion' && this.noteImmersion) {
          if (!checking) this.toggleNoteImmersion();
          return true;
        }
        if (this.access.canUse()) return checkCallback(checking);
        // Stay listed only where the command would otherwise run, then ask for activation instead of running it.
        if (!checkCallback(true)) return false;
        if (!checking) this.requireAccess();
        return true;
      } });
    } else {
      this.addCommand({ ...command, callback: () => { if (id === 'open-companion' || this.requireAccess()) callback?.(); } });
    }
  }

  private registerCommands(): void {
    if (this.commandsRegistered) {
      for (const id of ['quick-add', 'new-note', 'new-task', 'new-project', 'new-card', 'open-assistant', 'open-companion', 'open-report', 'open-capture-window', 'open-immersive-capture', 'toggle-note-immersion', ...JOURNAL_PERIODS.map((period) => `open-${period}-note`), 'setup-bases', 'migrate-companion-folder', 'quick-capture', 'pin-note']) this.removeCommand(id);
    }
    this.registerAccessCommand({ id: 'open-companion', name: this.t('Open companion'), callback: () => { void this.openSidebar().catch((error) => new Notice(this.error(error))); } });
    this.registerAccessCommand({ id: 'quick-add', name: this.t('Quick add'), callback: () => this.openQuickAdd() });
    for (const [id, name, kind] of [['new-note', 'New note', 'note'], ['new-task', 'New task', 'task'], ['new-project', 'New project', 'project']] as const) {
      this.registerAccessCommand({ id, name: this.t(name), callback: () => this.openQuickAdd(kind) });
    }
    this.registerAccessCommand({ id: 'new-card', name: this.t('New card'), checkCallback: (checking) => {
      if (!this.settings.knowledgeEnabled) return false;
      if (!checking) this.openQuickAdd('card');
      return true;
    } });
    this.registerAccessCommand({ id: 'open-assistant', name: this.t('Open assistant'), callback: () => { void this.openAssistant().catch((error) => new Notice(this.error(error))); } });
    this.registerAccessCommand({ id: 'open-report', name: this.t('Open report'), callback: () => { void this.openReport().catch((error) => new Notice(this.error(error))); } });
    this.registerAccessCommand({ id: 'setup-bases', name: this.t('Set up companion Bases'), callback: () => { void this.setup().catch((error) => new Notice(this.error(error))); } });
    this.registerAccessCommand({ id: 'migrate-companion-folder', name: this.t('Move companion folder to 99-Tangrow'), callback: () => { void this.migrateCompanionFolder().catch((error) => new Notice(this.error(error))); } });
    const captureWindow = (): void => { void this.openCaptureWindow().catch((error) => new Notice(this.error(error))); };
    this.registerAccessCommand({ id: 'quick-capture', name: this.t('Quick capture'), callback: captureWindow });
    this.registerAccessCommand({ id: 'open-capture-window', name: this.t('Open capture window'), callback: captureWindow });
    this.registerAccessCommand({ id: 'open-immersive-capture', name: this.t('Immersive capture'), callback: () => this.openImmersiveCapture() });
    this.registerAccessCommand({ id: 'toggle-note-immersion', name: this.t('Toggle immersive writing'), checkCallback: (checking) => {
      if (!this.app.workspace.getActiveViewOfType(MarkdownView)) return false;
      if (!checking) this.toggleNoteImmersion();
      return true;
    } });
    for (const period of JOURNAL_PERIODS) {
      this.registerAccessCommand({ id: `open-${period}-note`, name: this.t(JOURNAL_LABELS[period]), callback: () => {
        void this.openPeriodicNote(period).catch((error) => new Notice(this.error(error)));
      } });
    }
    this.registerAccessCommand({ id: 'pin-note', name: this.t('Pin or unpin current note'), checkCallback: (checking) => {
      if (!this.activeMarkdown()) return false;
      if (!checking) void this.action('toggle-pin').catch((error) => new Notice(this.error(error)));
      return true;
    } });
    this.commandsRegistered = true;
  }

  private async localizeManagedFiles(previousLanguage: Locale): Promise<number> {
    if (!this.alive || !hasValidSupportFolder(this.settings)) return 0;
    let updated = 0;
    for (const change of managedFileTranslations(this.settings, previousLanguage)) {
      const file = this.app.vault.getAbstractFileByPath(`${this.settings.supportFolder}/${change.filename}`);
      if (!(file instanceof TFile) || change.previous === change.next) continue;
      if (!matchesGeneratedContent(change.filename, await this.app.vault.cachedRead(file), change.previous, parseYaml)) continue;
      if (!this.alive) break;
      await this.app.vault.process(file, (content) => {
        if (!this.alive) return content;
        if (!matchesGeneratedContent(change.filename, content, change.previous, parseYaml)) return content;
        updated++;
        return change.next;
      });
    }
    return updated;
  }

  async setLanguage(language: Locale): Promise<void> {
    if (language !== 'zh-CN' && language !== 'en') throw new Error('Unsupported language.');
    await this.exclusive(async () => {
      const previous = this.settings.language;
      if (previous === language) return;
      this.settings.language = language;
      try { await this.persist(); } catch (error) { this.settings.language = previous; this.notifyAfterRollback(); throw error; }
      if (!this.alive) return;
      try { await this.localizeManagedFiles(previous); }
      finally {
        if (this.alive) {
          if (this.commandsRegistered) this.registerCommands();
          if (this.ribbon) setTooltip(this.ribbon, this.t('Open Tangrow'));
          this.bindNoteImmersionAction();
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
            if (leaf.view instanceof TangrowSidebar) leaf.view.refreshLanguage();
          }
          for (const leaf of this.app.workspace.getLeavesOfType(REPORT_VIEW_TYPE)) {
            if (leaf.view instanceof TangrowReport) leaf.view.refreshLanguage();
          }
          for (const leaf of this.app.workspace.getLeavesOfType(CAPTURE_VIEW_TYPE)) {
            if (leaf.view instanceof TangrowCapture) leaf.view.refreshLanguage();
          }
          this.notify();
        }
      }
    });
  }

  async openSidebar(): Promise<void> { await this.app.workspace.ensureSideLeaf(VIEW_TYPE, 'right', { active: false }); }
  async openAssistant(): Promise<void> {
    const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE, 'right', { active: true });
    if (leaf.view instanceof TangrowSidebar) leaf.view.showSection('ai');
  }
  openQuickAdd(kind: QuickKind = 'capture', text = '', source?: CardSource): void {
    const modal = new QuickAddModal(this, kind, text, source, () => this.quickAdds.delete(modal));
    this.quickAdds.add(modal);
    modal.open();
  }
  async openCardFromCapture(path: string, beforeOpen?: () => boolean): Promise<boolean> {
    if (!this.alive || !this.requireAccess()) return false;
    if (!this.settings.knowledgeEnabled) throw new Error('Knowledge features are disabled.');
    const { file, body } = await this.readCaptureSource(path);
    if (!this.alive || !this.requireAccess()) return false;
    if (!this.settings.knowledgeEnabled) throw new Error('Knowledge features are disabled.');
    const heading = /^# ([^\r\n]+)(?:\r?\n|$)/.exec(body);
    const duplicateTitle = heading && (heading[1] === file.basename || heading[1] === file.basename.replace(/ \(\d+\)$/, ''));
    const text = duplicateTitle ? body.slice(heading[0].length).replace(/^(?:\r?\n)+/, '') : body;
    if (beforeOpen && !beforeOpen()) return false;
    this.openQuickAdd('card', `${file.basename}\n\n${text}`, { path, captureFile: file });
    return true;
  }
  openNewHub(): void {
    if (!this.alive || !this.requireAccess()) return;
    if (!this.settings.knowledgeEnabled) throw new Error('Knowledge features are disabled.');
    this.openNotePrompt('New hub', 'Hub title', (title) => this.createHub(title));
  }
  private openNotePrompt(title: string, placeholder: string, submit: (value: string) => Promise<void>): void {
    const modal = new PromptModal(this.app, title, placeholder, submit, this.settings.language, () => this.notePrompts.delete(modal));
    this.notePrompts.add(modal);
    modal.open();
  }
  openCaptureWindow(): Promise<void> { return revealCaptureWindow(this.app, this); }
  openImmersiveCapture(): void {
    if (this.immersiveCapture) { this.immersiveCapture.contentEl.querySelector('textarea')?.focus(); return; }
    this.noteImmersion?.close();
    this.immersiveCapture = new ImmersiveCapture(this, () => { this.immersiveCapture = undefined; });
    this.immersiveCapture.open();
  }

  toggleNoteImmersion(view = this.app.workspace.getActiveViewOfType(MarkdownView)): void {
    if (this.noteImmersion) { this.noteImmersion.close(); return; }
    if (!view || !this.requireAccess()) return;
    this.noteImmersion = new NoteImmersion(view, this, () => { this.noteImmersion = undefined; });
  }

  private bindNoteImmersionAction(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
      ?? this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)?.view;
    if (view === this.noteImmersionActionView && this.noteImmersionAction) {
      setTooltip(this.noteImmersionAction, this.t('Toggle immersive writing'));
      return;
    }
    this.noteImmersionAction?.remove();
    this.noteImmersionAction = undefined;
    this.noteImmersionActionView = undefined;
    if (view instanceof MarkdownView && typeof view.addAction === 'function') {
      this.noteImmersionAction = view.addAction('expand', this.t('Toggle immersive writing'), () => this.toggleNoteImmersion(view));
      this.noteImmersionActionView = view;
    }
  }

  async openPeriodicNote(period: JournalPeriod, date = dayKey(), immersive = false): Promise<void> {
    const path = await this.ensurePeriodicNote(period, date);
    if (!this.alive) return;
    await this.openNote(path);
    this.bindNoteImmersionAction();
    if (immersive && !this.noteImmersion) this.toggleNoteImmersion();
  }

  private async ensurePeriodicNote(period: JournalPeriod, date: string): Promise<string> {
    const path = journalPath(this.settings, period, date, (value, pattern) => dateTime(value).format(pattern));
    const templatePath = this.settings.journalTemplates[period];
    const interval = journalInterval(period, date);
    await this.exclusive(async () => {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) {
        if (!(existing instanceof TFile)) throw new Error('The journal path is occupied by a folder.');
        return;
      }
      let content = defaultJournal(interval);
      if (templatePath) {
        const template = this.app.vault.getAbstractFileByPath(templatePath);
        if (!(template instanceof TFile) || template.extension !== 'md') throw new Error('Choose an existing Markdown journal template.');
        content = journalTemplate(await this.app.vault.read(template), interval);
      }
      await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
      const latest = this.app.vault.getAbstractFileByPath(path);
      if (!latest) await this.app.vault.create(path, content);
      else if (!(latest instanceof TFile)) throw new Error('The journal path is occupied by a folder.');
    });
    return path;
  }

  async updateJournalSettings(period: JournalPeriod, format?: string, template?: string): Promise<void> {
    await this.exclusive(async () => {
      const previous = this.settings;
      format ??= period === 'daily' ? previous.journalFormat : previous.journalFormats[period];
      template ??= previous.journalTemplates[period];
      if (!format.trim() || format.length >= 100) throw new Error('Use a date format of 1-99 characters.');
      template = template.trim() ? safeFolder(template) : '';
      if (template) {
        const file = this.app.vault.getAbstractFileByPath(template);
        if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('Choose an existing Markdown journal template.');
      }
      const next = { ...previous, journalFormats: { ...previous.journalFormats }, journalTemplates: { ...previous.journalTemplates, [period]: template } };
      if (period === 'daily') next.journalFormat = format;
      else next.journalFormats[period] = format;
      journalPath(next, period, dayKey(), (value, pattern) => dateTime(value).format(pattern));
      this.settings = next;
      try { await this.persist(); }
      catch (error) { this.settings = previous; this.notifyAfterRollback(); throw error; }
      this.notify();
    });
  }
  async openReport(): Promise<void> { await this.revealReport({ page: 'overview' }); }
  async openCardReport(filter?: CardFilter): Promise<void> {
    await this.revealReport(this.settings.knowledgeEnabled ? { page: 'cards', filter } : { page: 'overview' });
  }
  private async revealReport(destination: ReportDestination): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(REPORT_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.setViewState({ type: REPORT_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof TangrowReport) leaf.view.navigate(destination);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeComposer(listener: () => void): () => void { this.composerListeners.add(listener); return () => this.composerListeners.delete(listener); }
  subscribeRecoveryDrafts(listener: () => void): () => void { this.recoveryListeners.add(listener); return () => this.recoveryListeners.delete(listener); }
  private updateRecentOpened(paths: string[]): void {
    if (JSON.stringify(paths) === JSON.stringify(this.recentOpened)) return;
    this.recentOpened = paths;
    this.cachedSnapshot = null;
    this.scheduleComposerSave();
  }
  private notify(): void {
    if (!this.alive) return;
    this.cachedSnapshot = null;
    this.applyWidths();
    // One view failing to refresh must not leave the others showing stale state.
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.error('Tangrow view refresh failed', error); }
    }
  }
  /** After a failed write is undone, views that rendered the unsaved value must show the restored one. */
  private notifyAfterRollback(): void {
    // The caller rethrows the write error, which must not be replaced by a refresh error.
    try { this.notify(); } catch (error) { console.error('Tangrow view refresh failed', error); }
  }
  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.notify(), 180);
  }
  private persistenceCoordinator(): PersistenceCoordinator {
    const app = this.app as unknown as Record<symbol, PersistenceCoordinator | undefined>;
    return app[PERSISTENCE_COORDINATOR] ??= { tail: Promise.resolve() };
  }
  private persistenceSnapshot(): SavedData {
    return structuredClone({ version: 5, settings: this.settings, focus: this.focus, scratch: this.scratch, composer: this.composer, submissions: this.submissions, recoveryDrafts: [...this.recoveryDrafts.values()], recentOpened: this.recentOpened, activity: this.editingActivity, cardReviews: [...this.cardReviews.values()] });
  }
  private persist(finalFlush = false): Promise<void> {
    if (!this.alive && !finalFlush) return Promise.resolve();
    const coordinator = this.persistenceCoordinator();
    if (!this.persistenceClaimed) {
      coordinator.owner = this.persistenceOwner;
      this.persistenceClaimed = true;
    }
    const next = coordinator.tail.then(async () => {
      if (coordinator.owner !== this.persistenceOwner || (!this.alive && !finalFlush)) return;
      // Earlier failed transactions must roll back before the final reload flush reads state.
      await this.saveData(this.persistenceSnapshot());
    });
    coordinator.tail = next.then(() => undefined, () => undefined);
    this.writes = next;
    return this.writes;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.catch(() => undefined).then(operation);
    this.operations = next;
    return next;
  }
  private async replaceFocus(next: FocusSession | null): Promise<void> {
    const previous = this.focus;
    this.focus = next;
    try { await this.persist(); } catch (error) { this.focus = previous; this.notifyAfterRollback(); throw error; }
    this.notify();
  }
  async saveSettings(patch: LocalSettingsPatch | ((current: Settings) => LocalSettingsPatch) = {}): Promise<void> {
    await this.exclusive(async () => {
      const previous = this.settings;
      const changes = typeof patch === 'function' ? patch(previous) : patch;
      this.settings = { ...previous, ...changes };
      try { await this.persist(); }
      catch (error) { this.settings = previous; this.notifyAfterRollback(); throw error; }
      if (changes.wideByDefault !== undefined) this.widePages.clear();
      this.notify();
    });
  }
  async loadReport(range: ReportRange): Promise<ReportSnapshot> {
    const settings = structuredClone(this.settings);
    const source = await this.reportSource.collect(settings);
    const now = Date.now();
    const data = aggregateReport(source.records, settings, now, { range, folders: source.folders });
    return {
      data,
      records: source.records,
      cards: settings.knowledgeEnabled ? buildCardReport(source.records, data.notes, source.linksReady, now) : undefined,
      activity: summarizeActivity(this.editingActivity, range, now),
      generatedAt: now,
      quality: { unreadable: source.unreadable, linksReady: source.linksReady }
    };
  }
  async loadWorkbenchCards(): Promise<WorkbenchCards> {
    const settings = { ...this.settings };
    const source = await this.reportSource.collectKnowledge(settings);
    const now = Date.now();
    const scope = JSON.stringify([dayKey(now), settings.resourcesFolder, settings.journalFolder, settings.journalFormat]);
    if (this.workbenchCards?.records === source.records && this.workbenchCards.scope === scope) return this.workbenchCards.cards;
    const { workspace: knowledge, report, materials, hubs } = buildWorkbenchCards(source.records, settings, source.linksReady, now);
    const cards = { knowledge, report, materials, hubs };
    this.workbenchCards = { records: source.records, scope, cards };
    return cards;
  }
  workbenchProjects(): WorkbenchProject[] { return this.workbenchPara().projects; }
  workbenchProjectTypes(): WorkbenchProjectType[] { return this.workbenchPara().types; }
  workbenchDrafts(): NoteSummary[] { return this.workbenchPara().drafts; }
  workbenchAreas(): WorkbenchArea[] { return this.workbenchPara().areas; }
  workbenchResources(): ReportResource[] { return this.workbenchPara().resources; }
  workbenchLinkCandidates(): WorkbenchLinkCandidate[] { return this.workbenchPara().candidates; }
  private workbenchPara(): WorkbenchParaData {
    const state = this.snapshot();
    if (this.workbenchParaIndex?.openTasks === state.tasks) return this.workbenchParaIndex.data;
    const metadata = this.app.metadataCache;
    const overviewPath = this.settings.taskOverviewPath;
    const included = workbenchPathIncluded(this.settings);
    const records: WorkbenchProjectRecord[] = [];
    const completed: WorkbenchProjectTaskSource[] = [];
    const overviewLinks = new Map<number, Array<{ raw: string; path: string }>>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!included(file.path)) continue;
      const cache = metadata.getFileCache(file);
      const frontmatter = cache?.frontmatter;
      const propertyLink = (value: unknown): string | undefined => typeof value === 'string' ? resolvePropertyLink(metadata, file, value)?.path ?? undefined : undefined;
      const kind = frontmatter?.tangrow_kind;
      const knowledge = cache && (kind === undefined || kind === 'note') && (frontmatter?.tangrow_sources || frontmatter?.tangrow_capture_action_id)
        ? readKnowledgeRecord(metadata, file, cache) : undefined;
      records.push({ path: file.path, name: file.basename, created: file.stat.ctime, modified: file.stat.mtime, frontmatter, knowledge,
        tags: cache?.tags?.map((entry) => entry.tag), linkedProjectPath: propertyLink(frontmatter?.tangrow_project), linkedAreaPath: propertyLink(frontmatter?.tangrow_area) });
      for (const item of cache?.listItems ?? []) {
        if (item.task !== 'x' && item.task !== 'X') continue;
        const line = item.position.start.line;
        if (file.path === overviewPath) this.indexTaskLabels(file);
        completed.push({ path: file.path, line, text: this.indexedTaskText(file, line) ?? '', done: true });
      }
      if (file.path === overviewPath) for (const link of cache?.links ?? []) {
        const line = link.position.start.line;
        if (link.position.end.line !== line || link.original.startsWith('!')) continue;
        const paths = overviewLinks.get(line) ?? [];
        const resolved = resolvePropertyLink(metadata, file, link.original)?.path;
        if (resolved) { paths.push({ raw: link.original, path: resolved }); overviewLinks.set(line, paths); }
      }
    }
    const overview = this.app.vault.getAbstractFileByPath(overviewPath);
    const tasks = [...state.tasks, ...completed].map((task): WorkbenchProjectTaskSource => {
      if (!(overview instanceof TFile) || task.path !== overviewPath) return task;
      const original = this.indexedTaskText(overview, task.line);
      const rawLinks = original === undefined ? [] : parseTaskDisplay(original).links.flatMap((link) => resolvePropertyLink(metadata, overview, link)?.path ?? []);
      // When the exact line is available, parse its wikilinks. The host cache can still contain the previous line.
      const cachedLinks = (overviewLinks.get(task.line) ?? []).flatMap((link) =>
        original === undefined || (!link.raw.startsWith('[[') && original.includes(link.raw)) ? [link.path] : []);
      return { ...task, overviewLinks: [...cachedLinks, ...rawLinks] };
    });
    const folders = this.app.vault.getAllFolders().map((folder) => folder.path);
    const data = buildWorkbenchPara(records, tasks, folders, this.settings);
    this.workbenchParaIndex = { openTasks: state.tasks, data };
    return data;
  }
  async updateKnowledgeEnabled(enabled: boolean): Promise<void> {
    await this.exclusive(async () => {
      if (this.settings.knowledgeEnabled === enabled) return;
      const previous = this.settings;
      this.settings = { ...previous, knowledgeEnabled: enabled };
      try { await this.persist(); }
      catch (error) { this.settings = previous; this.notifyAfterRollback(); throw error; }
      if (!enabled) this.workbenchCards = undefined;
      this.notify();
    });
  }
  loadCardReview(day: string): CardReviewQueue | null {
    const queue = this.cardReviews.get(day);
    return queue ? structuredClone(queue) : null;
  }
  async saveCardReview(queue: CardReviewQueue, rebuild = false): Promise<CardReviewQueue> {
    const candidate = readCardReviewQueue(queue);
    if (!candidate) throw new Error('Invalid card review queue.');
    return this.exclusive(async () => {
      if (!this.settings.knowledgeEnabled) throw new Error('Knowledge features are disabled.');
      if (candidate.day !== dayKey()) throw new Error('The review day has changed. Open today’s review again.');
      const existing = this.loadCardReview(candidate.day);
      if (existing && !rebuild) return existing;
      if (existing) {
        const completed = new Set(existing.completed);
        candidate.completed = candidate.entries.filter((entry) => {
          const atPath = existing.entries.find((previous) => previous.path === entry.path);
          if (atPath && atPath.id === entry.id) return completed.has(atPath.path);
          if (!entry.id) return false;

          const byId = existing.entries.filter((previous) => previous.id === entry.id);
          if (!byId.length) return !!atPath && !atPath.id && completed.has(atPath.path);
          if (byId.length !== 1 || !completed.has(byId[0]!.path)) return false;
          return !candidate.entries.some((other) => other !== entry && other.id === entry.id);
        }).map((entry) => entry.path);
      }
      await this.replaceCardReview(candidate);
      this.notify();
      return structuredClone(candidate);
    });
  }
  async markCardReviewed(path: string, day: string, entryPath: string): Promise<void> {
    await this.exclusive(async () => {
      if (!this.settings.knowledgeEnabled) throw new Error('Knowledge features are disabled.');
      const now = new Date(Date.now());
      if (day !== dayKey(now.getTime())) throw new Error('The review day has changed. Open today’s review again.');
      const queue = this.loadCardReview(day);
      const entry = queue?.entries.find((item) => item.path === entryPath);
      if (!queue || !entry || (path !== entry.path && !entry.id)) throw new Error('The review queue has changed.');
      if (queue.completed.includes(entryPath)) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('This note no longer exists.');
      await this.app.fileManager.processFrontMatter(file, (fields) => {
        const id = typeof fields.tangrow_id === 'string' ? fields.tangrow_id.trim() : '';
        if (fields.tangrow_kind !== 'card' || (entry.id && id !== entry.id)) throw new Error('The selected file is no longer the queued card.');
        const previous = parseNoteTimestamp(fields.tangrow_reviewed_at);
        if (previous === null || dayKey(previous) !== day) fields.tangrow_reviewed_at = now.toISOString();
      });
      try { await this.replaceCardReview({ ...queue, completed: [...queue.completed, entryPath] }); }
      finally { this.notify(); }
    });
  }
  private async replaceCardReview(queue: CardReviewQueue): Promise<void> {
    const previous = this.cardReviews.get(queue.day);
    this.cardReviews.set(queue.day, queue);
    try { await this.persist(); }
    catch (error) {
      if (previous) this.cardReviews.set(queue.day, previous);
      else this.cardReviews.delete(queue.day);
      throw error;
    }
  }
  async updateReportSettings(patch: Partial<ReportPreferences>): Promise<void> {
    await this.exclusive(async () => {
      const previous = this.settings;
      const next = { ...previous };
      if (patch.reportExcludedFolders !== undefined) {
        if (!Array.isArray(patch.reportExcludedFolders) || patch.reportExcludedFolders.length > 100 || patch.reportExcludedFolders.some((path) => typeof path !== 'string')) throw new Error('Use at most 100 relative folder exclusions.');
        next.reportExcludedFolders = [...new Set(patch.reportExcludedFolders.map(safeFolder))];
      }
      if (patch.activityGoalMinutes !== undefined) {
        if (!Number.isInteger(patch.activityGoalMinutes) || patch.activityGoalMinutes < 1 || patch.activityGoalMinutes > 1440) throw new Error('Use an activity goal from 1 to 1440 whole minutes.');
        next.activityGoalMinutes = patch.activityGoalMinutes;
      }
      if (patch.trackEditingActivity !== undefined) {
        if (typeof patch.trackEditingActivity !== 'boolean') throw new Error('Choose whether editing activity is enabled.');
        next.trackEditingActivity = patch.trackEditingActivity;
      }
      this.settings = next;
      try { await this.persist(); }
      catch (error) { this.settings = previous; this.notifyAfterRollback(); throw error; }
      this.lastActivityEvent = null;
      this.reportSource.invalidate();
      this.notify();
      new Notice(this.t('Report preferences saved. Existing notes and Bases were preserved.'));
    });
  }
  private watchWindow(win: Window): void {
    if (this.watchedWindows.has(win) || typeof this.registerDomEvent !== 'function') return;
    this.watchedWindows.add(win);
    this.registerDomEvent(win, 'focus', () => this.access.onResume('foreground'));
    this.registerDomEvent(win, 'blur', () => { this.lastActivityEvent = null; });
    this.registerDomEvent(win.document, 'visibilitychange', () => {
      this.lastActivityEvent = null;
      if (win.document.visibilityState === 'visible') this.access.onResume('foreground');
    });
  }
  private recordEditingActivity(info: unknown): void {
    if (!this.alive || !this.settings.trackEditingActivity || !this.access.canUse() || !(info instanceof MarkdownView) || !info.file) { this.lastActivityEvent = null; return; }
    const doc = info.containerEl.ownerDocument;
    const path = info.file.path;
    const excluded = (hasValidSupportFolder(this.settings) && inFolder(path, this.settings.supportFolder))
      || this.settings.reportExcludedFolders.some((folder) => inFolder(path, folder));
    if (!doc || doc.hidden || !doc.hasFocus() || this.activeFile()?.path !== path || excluded) { this.lastActivityEvent = null; return; }
    this.watchWindow(doc.defaultView ?? window);
    const now = Date.now();
    if (this.lastActivityEvent !== null && now >= this.lastActivityEvent && now - this.lastActivityEvent < 1000) return;
    const result = addEditingActivity(this.editingActivity, now, this.lastActivityEvent);
    this.editingActivity = result.state;
    this.lastActivityEvent = result.lastEventMs;
    if (this.activityTimer !== undefined) return;
    this.activityTimer = window.setTimeout(() => {
      this.activityTimer = undefined;
      void this.persist().catch((error) => { if (this.alive) new Notice(this.error(error)); });
    }, 2000);
  }
  async updateFolderSetting(key: FolderSettingKey, path: string): Promise<void> {
    const folder = safeFolder(path);
    await this.exclusive(async () => {
      validateFolderSettings({ ...this.settings, [key]: folder });
      const previous = this.settings[key];
      this.settings[key] = folder;
      try { await this.persist(); }
      catch (error) { this.settings[key] = previous; this.notifyAfterRollback(); throw error; }
      this.notify();
    });
  }
  async migrateCompanionFolder(): Promise<void> {
    await this.exclusive(async () => {
      const previousFolder = this.settings.supportFolder;
      const sourcePath = this.focus?.filePath;
      try {
        const result = await moveSupportFolder(this.app, this.settings, DEFAULT_SETTINGS.supportFolder, () => {
          if (this.focus && sourcePath?.startsWith(`${previousFolder}/`)) this.focus = { ...this.focus, filePath: this.settings.supportFolder + sourcePath.slice(previousFolder.length) };
          return this.persist();
        });
        new Notice(this.t('The companion folder now uses {folder}.', { folder: this.settings.supportFolder }));
        if (result.preservedFiles.length) new Notice(this.t('{count} customized companion files were preserved. Review their folder filters manually.', { count: result.preservedFiles.length }));
      } finally { this.notify(); }
    });
  }
  loadScratch(): string { return this.scratch; }
  loadComposer(): ComposerState { return { ...this.composer }; }
  loadRecoveryDrafts(): ReturnType<SidebarHost['loadRecoveryDrafts']> {
    return Array.from(this.recoveryDrafts.values(), draft => ({
      id: draft.id, label: draft.label, text: draft.text, saving: this.quickAddSaves.has(draft.id) || this.recoverySaves.has(draft)
    }));
  }
  preserveRecoveryDraft(id: string, label: RecoveryLabel, text: string, saving = false): void | Promise<void> {
    if (!this.alive) return;
    const previous = this.recoveryDrafts.get(id);
    const changed = (previous?.text ?? '') !== text;
    const wasSaving = this.quickAddSaves.has(id);
    if (!changed && saving === wasSaving) return;
    if (saving) this.quickAddSaves.add(id);
    else this.quickAddSaves.delete(id);
    if (changed) {
      if (text) this.recoveryDrafts.set(id, { id, label, text, submission: null });
      else this.recoveryDrafts.delete(id);
      if (!saving && !wasSaving) this.scheduleComposerSave();
    }
    for (const listener of this.recoveryListeners) listener();
    // Commit partial task progress and completed saves before the original submission returns.
    if (changed && (saving || wasSaving)) return this.persist().catch(error => {
      new Notice(this.error(error));
      this.scheduleComposerSave();
    });
  }
  loadWritingDraft(): WritingDraft {
    const receipt = this.submissions.writing;
    return {
      text: this.scratch, title: this.composer.scratchTitle, revision: this.scratchRevision,
      ...(this.scratchEditingView ? { editingView: this.scratchEditingView } : {}),
      ...(receipt?.path ? { preparedProjectPath: receipt.project?.path ?? null } : {})
    };
  }
  beginWritingDraftComposition(viewId: string, expectedRevision: number): boolean {
    if (!this.alive) return false;
    if (!viewId || expectedRevision !== this.scratchRevision || (this.scratchEditingView !== undefined && this.scratchEditingView !== viewId)) return false;
    if (this.scratchEditingView === viewId) return true;
    this.scratchEditingView = viewId;
    for (const listener of this.composerListeners) listener();
    return true;
  }
  endWritingDraftComposition(viewId: string): void {
    if (this.scratchEditingView !== viewId) return;
    this.scratchEditingView = undefined;
    for (const listener of this.composerListeners) listener();
  }
  updateWritingDraft(patch: Partial<Pick<WritingDraft, 'text' | 'title'>>, expectedRevision: number, viewId?: string): boolean {
    if (!this.alive) return false;
    if (expectedRevision !== this.scratchRevision || (this.scratchEditingView !== undefined && this.scratchEditingView !== viewId)) return false;
    const text = patch.text ?? this.scratch;
    const title = patch.title ?? this.composer.scratchTitle;
    if (text === this.scratch && title === this.composer.scratchTitle) return true;
    this.scratch = text;
    this.composer.scratchTitle = title;
    this.submissions.writing = null;
    this.scratchRevision++;
    this.scheduleComposerSave();
    for (const listener of this.composerListeners) listener();
    return true;
  }
  saveComposer(patch: Partial<ComposerState>): void {
    if (!this.alive) return;
    let changed = false;
    if (typeof patch.capture === 'string' && patch.capture !== this.composer.capture) {
      this.composer.capture = patch.capture;
      this.submissions.capture = null;
      this.captureRevision++;
      changed = true;
    }
    if (this.scratchEditingView === undefined && typeof patch.scratchTitle === 'string' && patch.scratchTitle !== this.composer.scratchTitle) {
      this.composer.scratchTitle = patch.scratchTitle;
      this.submissions.writing = null;
      this.scratchRevision++;
      changed = true;
    }
    this.scheduleComposerSave();
    if (changed) for (const listener of this.composerListeners) listener();
  }
  saveScratch(value: string): void {
    this.updateWritingDraft({ text: value }, this.scratchRevision);
  }
  private scheduleComposerSave(): void {
    if (!this.alive) { void this.persist().catch((error) => console.error('Tangrow save failed', error)); return; }
    window.clearTimeout(this.scratchTimer);
    this.scratchTimer = window.setTimeout(() => { void this.persist().catch((error) => new Notice(this.error(error))); }, 350);
  }

  private activeFile(): TFile | null {
    const view = this.app.workspace.getMostRecentLeaf()?.view;
    return view instanceof FileView ? view.file : null;
  }
  private activeMarkdown(): TFile | null {
    const file = this.activeFile();
    return file?.extension === 'md' ? file : null;
  }
  private summary(file: TFile): NoteSummary {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return { path: file.path, name: file.basename, folder: file.parent?.path ?? '', modified: file.stat.mtime, kind: String(frontmatter?.tangrow_kind ?? ''), status: String(frontmatter?.tangrow_status ?? '') };
  }
  private indexTaskLabels(file: TFile): void {
    if (this.taskReads.has(file.path) || this.taskLabels.get(file.path)?.mtime === file.stat.mtime) return;
    const path = file.path;
    const mtime = file.stat.mtime;
    this.taskReads.add(path);
    void this.app.vault.cachedRead(file).then((content) => {
      const lines = new Map<number, string>();
      content.split(/\r?\n/).forEach((line, index) => {
        const label = indexedTaskLabel(line);
        if (label !== null) lines.set(index, label);
      });
      this.taskLabels.set(path, { mtime, lines });
    }).catch(() => {
      this.taskLabels.set(path, { mtime, lines: new Map() });
    }).finally(() => {
      this.taskReads.delete(path);
      if (this.alive) this.notify();
    });
  }
  private indexedTaskText(file: TFile, line: number): string | undefined {
    const index = this.taskLabels.get(file.path);
    return index?.mtime === file.stat.mtime ? index.lines.get(line) : undefined;
  }
  snapshot(): Snapshot {
    const active = this.activeFile();
    if (this.cachedSnapshot) return {
      ...this.cachedSnapshot,
      active: active ? this.summary(active) : null,
      activePinned: active ? this.app.metadataCache.getFileCache(active)?.frontmatter?.tangrow_pin === true : false,
      widePage: active?.extension === 'md' ? this.isWide(active.path) : false,
      focus: this.focus,
      focusRemainingMs: remainingMs(this.focus, Date.now())
    };
    const files = this.app.vault.getMarkdownFiles();
    const excludeSupport = hasValidSupportFolder(this.settings);
    const notes = files.filter((file) => !excludeSupport || !inFolder(file.path, this.settings.supportFolder));
    const recent = [...notes].sort((a, b) => b.stat.mtime - a.stat.mtime);
    const taskNotes: TaskSummary[] = [];
    const habitDays = new Map<string, Set<string>>();
    const focusSessions = new Set<string>();
    let totalMinutes = 0;
    const byKind = (file: TFile, kind: string): boolean => this.app.metadataCache.getFileCache(file)?.frontmatter?.tangrow_kind === kind;
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (fm?.tangrow_kind === 'focus' && typeof fm.tangrow_minutes === 'number' && Number.isFinite(fm.tangrow_minutes) && fm.tangrow_minutes >= 0) {
        const identity = typeof fm.tangrow_session_id === 'string' && fm.tangrow_session_id.trim() ? `session:${fm.tangrow_session_id}` : `path:${file.path}`;
        if (!focusSessions.has(identity)) { totalMinutes += fm.tangrow_minutes; focusSessions.add(identity); }
      }
      if (fm?.tangrow_kind === 'habit' && typeof fm.tangrow_habit_id === 'string' && typeof fm.tangrow_day === 'string') {
        const days = habitDays.get(fm.tangrow_habit_id) ?? new Set<string>();
        days.add(fm.tangrow_day);
        habitDays.set(fm.tangrow_habit_id, days);
      }
      if ((excludeSupport && inFolder(file.path, this.settings.supportFolder)) || inFolder(file.path, this.settings.archiveFolder)) continue;
      if (cache?.listItems?.some((item) => item.task === ' ' || item.task === '/')) this.indexTaskLabels(file);
      for (const item of cache?.listItems ?? []) {
        if (item.task !== ' ' && item.task !== '/') continue;
        const line = item.position.start.line;
        const indexed = this.indexedTaskText(file, line);
        taskNotes.push({ path: file.path, line, done: false,
          text: indexed ?? this.t('{name} · line {line}', { name: file.basename, line: line + 1 }),
          ...(indexed === undefined ? { labelPending: true } : {}) });
      }
    }
    const supportFiles = [...baseDefinitions(this.settings).map((definition) => definition.filename), 'README.md'];
    this.cachedSnapshot = {
      active: active ? this.summary(active) : null,
      activePinned: active ? this.app.metadataCache.getFileCache(active)?.frontmatter?.tangrow_pin === true : false,
      counts: { notes: notes.length, projects: notes.filter((file) => inFolder(file.path, this.settings.projectFolder)).length, captures: notes.filter((file) => byKind(file, 'capture')).length, drafts: notes.filter((file) => byKind(file, 'draft')).length, focusMinutes: Math.round(totalMinutes * 100) / 100, tasks: taskNotes.length },
      recent: recent.slice(0, 8).map((file) => this.summary(file)),
      recentOpened: this.recentOpened.flatMap((path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? [this.summary(file)] : [];
      }),
      pins: files.filter((file) => this.app.metadataCache.getFileCache(file)?.frontmatter?.tangrow_pin === true).sort((left, right) => right.stat.mtime - left.stat.mtime || left.path.localeCompare(right.path)).map((file) => this.summary(file)),
      captures: sortCaptures(notes.filter((file) => byKind(file, 'capture')).map((file) => {
        const fields = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        return { ...this.summary(file), created: captureCreated(fields.created, file.stat.ctime, file.stat.mtime),
          processed: captureIsProcessed(fields), processing: Boolean(fields.tangrow_capture_processing) };
      })),
      drafts: recent.filter((file) => byKind(file, 'draft')).map((file) => this.summary(file)),
      tasks: taskNotes,
      habits: this.settings.habits.map((habit) => {
        const days = habitDays.get(habit.id) ?? new Set<string>();
        return { ...habit, completedToday: days.has(dayKey()), streak: streak(days), days: recentDays(14).map((day) => days.has(day)) };
      }),
      focus: this.focus,
      focusRemainingMs: remainingMs(this.focus, Date.now()),
      supportReady: excludeSupport && supportFiles.every((filename) => this.app.vault.getAbstractFileByPath(`${this.settings.supportFolder}/${filename}`) instanceof TFile),
      projectFolders: this.app.vault.getAllFolders().filter((folder) => inFolder(folder.path, this.settings.projectFolder)).map((folder) => folder.path).sort((left, right) => left.localeCompare(right)),
      widePage: active?.extension === 'md' ? this.isWide(active.path) : false
    };
    return this.cachedSnapshot;
  }

  private async ensureFolder(folder: string): Promise<void> {
    const path = safeFolder(folder);
    let current = '';
    for (const segment of path.split('/')) {
      current = current ? `${current}/${segment}` : segment;
      const found = this.app.vault.getAbstractFileByPath(current);
      if (found && !(found instanceof TFolder)) throw new Error(this.t('A file already exists at {path}.', { path: current }));
      if (!found) await this.app.vault.createFolder(current);
    }
  }
  /** Obsidian only indexes and rename-updates wikilinks in properties, so ignore the Markdown link preference here. */
  private propertyLink(file: TFile, sourcePath: string, anchor = ''): string {
    return `[[${this.app.metadataCache.fileToLinktext(file, sourcePath)}${anchor}]]`;
  }
  private async createUnique(folder: string, title: string, body: string, fields: Record<string, unknown>, source?: CardSource): Promise<TFile> {
    folder = safeFolder(folder);
    title = safeTitle(title);
    await this.ensureFolder(folder);
    let path = `${folder}/${title}.md`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${folder}/${title} (${suffix++}).md`;
    if (source) {
      if (source.captureFile || source.includeLink !== false) {
        const file = source.captureFile ? this.captureFile(source.path) : this.app.vault.getAbstractFileByPath(source.path);
        if (source.captureFile && file !== source.captureFile) throw new Error('This capture no longer exists.');
        if (!(file instanceof TFile) || file.extension !== 'md') throw new Error('The card source no longer exists.');
        fields.tangrow_sources = [this.propertyLink(file, path, source.anchor)];
      }
      body = rebaseMarkdownLinks(body, source.path, path,
        (link, from) => this.app.metadataCache.getFirstLinkpathDest(link, from)?.path ?? null, { sourceLocalAnchors: true });
    }
    const content = `---\n${stringifyYaml(fields)}---\n\n# ${title}\n\n${body.trim()}\n`;
    try { return await this.app.vault.create(path, content); }
    catch (error) {
      if (fields.tangrow_kind !== 'card') throw error;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const saved = await this.app.vault.read(existing);
        const info = getFrontMatterInfo(saved);
        const actual = info.exists ? parseYaml(info.frontmatter) as Record<string, unknown> | null : null;
        if (actual?.tangrow_kind === 'card' && actual.tangrow_id === fields.tangrow_id) return existing;
      }
      throw error;
    }
  }
  private async recoverSubmittedDrafts(): Promise<void> {
    let recovered = false;
    for (const key of ['capture', 'writing'] as const) {
      const submission = this.submissions[key];
      if (!submission) continue;
      const file = await findSubmittedNote(this.app, submission, key === 'capture' ? 'capture' : 'draft');
      if (!this.alive) return;
      if (!file || this.submissions[key] !== submission) continue;
      this.submissions[key] = null;
      if (key === 'capture') { this.composer.capture = ''; this.captureRevision++; }
      else { this.scratch = ''; this.composer.scratchTitle = ''; this.scratchRevision++; }
      recovered = true;
    }
    for (const draft of this.recoveryDrafts.values()) {
      if (!draft.submission?.path) continue;
      const file = await findSubmittedNote(this.app, draft.submission, 'capture');
      if (!this.alive) return;
      if (file && this.recoveryDrafts.get(draft.id) === draft) {
        this.recoveryDrafts.delete(draft.id);
        recovered = true;
      }
    }
    if (recovered) {
      try { await this.persist(); }
      catch (error) { this.scheduleComposerSave(); throw error; }
    }
  }
  private async createSubmittedNote(submission: DraftSubmission, kind: SubmissionKind, title: string, body: string, fields: Record<string, unknown>, projectPath?: string): Promise<TFile> {
    if (submission.path !== null) {
      const saved = await findSubmittedNote(this.app, submission, kind);
      if (saved) return saved;
    } else {
      const folder = safeFolder(this.settings.inboxFolder);
      title = safeTitle(title);
      let path = `${folder}/${title}.md`;
      let suffix = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = `${folder}/${title} (${suffix++}).md`;
      if (kind === 'draft' && projectPath) {
        const project = this.workbenchProjectNote(projectPath);
        submission.project = { path: safeFolder(projectPath), notePath: safeFolder(project.path) };
      }
      submission.path = path;
    }
    // Persist the receipt before creating Markdown. A failed barrier must not write a note.
    await this.persist();
    if (!this.alive || this.persistenceCoordinator().owner !== this.persistenceOwner) throw new Error('Tangrow could not complete this action.');
    const path = submission.path;
    await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
    const projectLink = submission.project ? await this.submittedDraftProjectLink(submission, path) : undefined;
    const heading = path.slice(path.lastIndexOf('/') + 1, -3);
    const content = `---\n${stringifyYaml({ ...fields, ...(projectLink ? { tangrow_project: projectLink } : {}), tangrow_submission_id: submission.id })}---\n\n# ${heading}\n\n${body}\n`;
    try { return await this.app.vault.create(path, content); }
    catch (error) {
      // A create can report failure after writing; retry only if no matching receipt exists.
      const saved = await findSubmittedNote(this.app, submission, kind, false);
      if (saved) return saved;
      throw error;
    }
  }
  private async submittedDraftProjectLink(submission: DraftSubmission, path: string): Promise<string | undefined> {
    const project = submission.project;
    if (!project) return;
    try {
      const entity = this.workbenchEntity(project.path, this.settings.projectFolder, 'Choose an existing project.');
      const note = entity instanceof TFile && entity.path === project.notePath ? entity
        : this.workbenchLinkedNote(project.notePath, entity.path, 'Choose an existing project note.');
      const link = this.propertyLink(note, path);
      if (/^\[\[[^\[\]\r\n|]+\]\]$/.test(link)) return link;
    } catch { /* the project or its saved note is no longer usable */ }
    submission.path = null;
    delete submission.project;
    await this.persist();
    throw new Error('The saved project is unavailable. Choose a project again or save as a draft.');
  }
  async setup(): Promise<void> {
    await this.exclusive(async () => {
      validateFolderSettings(this.settings);
      await this.ensureFolder(this.settings.supportFolder);
      const definitions = baseDefinitions(this.settings);
      let created = 0;
      for (const definition of definitions) {
        const path = `${this.settings.supportFolder}/${definition.filename}`;
        if (this.app.vault.getAbstractFileByPath(path)) continue;
        await this.app.vault.create(path, definition.content);
        created++;
      }
      const readmePath = `${this.settings.supportFolder}/README.md`;
      if (!this.app.vault.getAbstractFileByPath(readmePath)) await this.app.vault.create(readmePath, setupReadme(this.settings));
      this.notify();
      new Notice(this.t('Tangrow: created {count} Bases. Existing files were preserved.', { count: created }));
    });
  }
  async openBase(id: BaseId): Promise<void> {
    const definition = baseDefinitions(this.settings).find((item) => item.id === id);
    if (!definition) throw new Error('Unknown Base.');
    const path = `${this.settings.supportFolder}/${definition.filename}`;
    if (!this.app.vault.getAbstractFileByPath(path)) await this.setup();
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'base') throw new Error('The Base path is occupied by another file.');
    await this.app.workspace.getLeaf('tab').openFile(file);
  }
  async openNote(path: string, line?: number, anchor?: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('This note no longer exists.');
    const candidate = this.app.workspace.getLeaf(false);
    const candidateType = candidate.view.getViewType();
    const useNewTab = candidateType === CAPTURE_VIEW_TYPE || candidateType === REPORT_VIEW_TYPE;
    if (anchor) {
      await this.app.workspace.openLinkText(`${file.path}${anchor}`, '', useNewTab ? 'tab' : false);
      return;
    }
    const leaf = useNewTab ? this.app.workspace.getLeaf('tab') : candidate;
    await leaf.openFile(file, { active: true, eState: line === undefined ? undefined : { line } });
  }
  async createNote(kind: NoteKind, title: string, projectFolder?: string, body = '', projectType?: string): Promise<void> {
    if (kind === 'card') return this.createCard(title, body);
    const file = await this.exclusive(() => {
      let folder = this.settings.inboxFolder;
      let type: string | null = null;
      if (kind === 'project') {
        const root = safeFolder(this.settings.projectFolder);
        if (projectFolder) {
          folder = safeFolder(projectFolder);
          if (!inFolder(folder, root) || !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw new Error('Choose an existing project subfolder.');
        } else {
          folder = `${root}/${safeTitle(title)}`;
          if (this.app.vault.getAbstractFileByPath(folder)) throw new Error('This project folder already exists. Choose it from the existing project list.');
          type = readProjectType(projectType);
        }
      }
      return this.createUnique(folder, title, body, { tangrow_kind: kind, tangrow_status: 'open', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ'),
        ...(type ? { tangrow_project_type: type } : {}) });
    });
    if (kind === 'project' && this.alive) this.notify();
    await this.openNote(file.path);
  }
  async createCard(title: string, body: string, source?: CardSource): Promise<void> {
    const file = await this.exclusive(async () => {
      if (!this.settings.knowledgeEnabled) throw new Error('Knowledge features are disabled.');
      validateFolderSettings(this.settings);
      if (source?.captureFile) await this.readCaptureSource(source.path, source.captureFile);
      const fields = { tangrow_kind: 'card', tangrow_id: uid(), tangrow_stage: 'seed', created: new Date().toISOString() };
      return this.createUnique(this.settings.cardFolder, title, body, fields, source);
    });
    try { await this.openNote(file.path); }
    catch (error) { new Notice(this.error(error)); }
  }
  private async createHub(title: string): Promise<void> {
    const file = await this.exclusive(async () => {
      if (!this.alive || !this.requireAccess()) return null;
      if (!this.settings.knowledgeEnabled) throw new Error('Knowledge features are disabled.');
      validateFolderSettings(this.settings);
      return this.createUnique(this.settings.cardFolder, title, '', { tangrow_kind: 'hub', created: new Date().toISOString() });
    });
    if (!file || !this.alive) return;
    try { await this.openNote(file.path); }
    catch (error) { new Notice(this.error(error)); }
  }
  async addWritingMaterial(draftPath: string, sourcePath: string): Promise<void> {
    await this.exclusive(async () => {
      if (!this.settings.knowledgeEnabled) throw new Error('Knowledge features are disabled.');
      const draft = this.app.vault.getAbstractFileByPath(draftPath);
      const source = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(draft instanceof TFile) || draft.extension !== 'md') throw new Error('The selected manuscript no longer exists.');
      if (!(source instanceof TFile) || source.extension !== 'md') throw new Error('The selected material no longer exists.');
      if (draft === source) throw new Error('Choose material from a different note.');
      await this.app.fileManager.processFrontMatter(draft, (fields) => {
        if (fields.tangrow_kind !== 'draft') throw new Error('The selected file is no longer a manuscript.');
        const previous: unknown = fields.tangrow_materials;
        const materials = Array.isArray(previous) ? previous : previous == null ? [] : [previous];
        const link = this.propertyLink(source, draft.path);
        if (materials.some((entry) => {
          if (entry === link) return true;
          const parsed = resolvePropertyLink(this.app.metadataCache, draft, entry);
          return parsed?.path === source.path && !parsed.anchor;
        })) return;
        fields.tangrow_materials = [...materials, link];
      });
    });
    this.notify();
  }
  async createNoteWithBody(title: string, body: string): Promise<void> {
    const file = await this.exclusive(() => this.createUnique(this.settings.inboxFolder, title, body, { tangrow_kind: 'note', tangrow_status: 'open', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') }));
    await this.openNote(file.path);
  }
  private workbenchEntity(path: string, root: string, error: string): TFile | TFolder {
    const entry = this.app.vault.getAbstractFileByPath(path);
    const isEntity = entry instanceof TFolder || (entry instanceof TFile && entry.extension === 'md');
    if (!isEntity || path.slice(0, path.lastIndexOf('/')) !== root || !workbenchPathIncluded(this.settings)(path)) throw new Error(error);
    return entry;
  }
  private workbenchLinkedNote(path: string | null | undefined, root: string, error: string): TFile {
    const entry = path ? this.app.vault.getAbstractFileByPath(path) : null;
    if (!(entry instanceof TFile) || entry.extension !== 'md' || !inFolder(entry.path, root) || !workbenchPathIncluded(this.settings)(entry.path)) throw new Error(error);
    return entry;
  }
  private canonicalWorkbenchNotes(folder: TFolder): TFile[] {
    const included = workbenchPathIncluded(this.settings);
    return canonicalEntityNotes(this.app.vault.getMarkdownFiles().filter((file) => file.parent?.path === folder.path && included(file.path)), folder.path);
  }
  private workbenchProjectNote(path: string): TFile {
    const project = this.workbenchEntity(path, this.settings.projectFolder, 'Choose an existing project.');
    if (project instanceof TFile) return project;
    const notePath = this.workbenchProjects().find((entry) => entry.path === path)?.notePath;
    return this.workbenchLinkedNote(notePath, project.path, 'Choose an existing project note.');
  }
  private workbenchAreaNote(path: string): TFile {
    const area = this.workbenchEntity(path, this.settings.areaFolder, 'Choose an existing area.');
    const notePath = area instanceof TFile ? area.path : this.workbenchAreas().find((entry) => entry.path === path)?.notePath;
    return this.workbenchLinkedNote(notePath, area.path === notePath ? this.settings.areaFolder : area.path, 'This area has no note to link.');
  }
  private async setWorkbenchProjectMetadata(
    projectPath: string, property: ProjectNoteProperty, valueAt: (ownerPath: string) => string | null
  ): Promise<void> {
    const project = this.workbenchEntity(projectPath, this.settings.projectFolder, 'Choose an existing project.');
    const canonical = project instanceof TFile ? [project] : this.canonicalWorkbenchNotes(project);
    const notes = await Promise.all(canonical.map(async (file) => {
      const path = file.path;
      const info = getFrontMatterInfo(await this.app.vault.read(file));
      const parsed: unknown = info.exists ? parseYaml(info.frontmatter) : null;
      const frontmatter = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
      return { file, path, frontmatter };
    }));
    const owner = projectMetadataOwner(notes, property);
    if (!owner || this.app.vault.getAbstractFileByPath(owner.path) !== owner.file) throw new Error('Choose an existing project note.');
    const value = valueAt(owner.path);
    const hasFallback = value === null && notes.some((note) => note !== owner && hasProjectMetadataValue(note.frontmatter?.[property]));
    await this.app.fileManager.processFrontMatter(owner.file, (fields) => {
      if (value === null && !hasFallback) delete fields[property];
      else fields[property] = value;
    });
  }
  async setWorkbenchProjectArea(projectPath: string, areaPath: string | null): Promise<void> {
    await this.exclusive(() => this.setWorkbenchProjectMetadata(projectPath, 'tangrow_area',
      (path) => areaPath === null ? null : this.propertyLink(this.workbenchAreaNote(areaPath), path)));
    this.notify();
  }
  async setWorkbenchProjectType(projectPath: string, type: string | null): Promise<void> {
    const value = readProjectType(type);
    await this.exclusive(() => this.setWorkbenchProjectMetadata(projectPath, 'tangrow_project_type', () => value));
    this.notify();
  }
  async linkWorkbenchNote(notePath: string, projectPath: string): Promise<void> {
    await this.exclusive(async () => {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      const project = this.workbenchProjectNote(projectPath);
      if (!(file instanceof TFile) || file.extension !== 'md' || !workbenchPathIncluded(this.settings)(notePath)
        || !this.workbenchLinkCandidates().some((candidate) => candidate.path === notePath)) throw new Error('Choose an existing note to link.');
      if (file === project) throw new Error('Choose a note outside the project note itself.');
      const link = this.propertyLink(project, notePath);
      await this.app.fileManager.processFrontMatter(file, (fields) => { fields.tangrow_project = link; });
    });
    this.notify();
  }
  openNewAreaNote(areaPath: string): void {
    if (!this.alive || !this.requireAccess()) return;
    this.workbenchEntity(areaPath, this.settings.areaFolder, 'Choose an existing area.');
    this.openNotePrompt('New note in this area', 'Note title', (title) => this.createAreaNote(areaPath, title));
  }
  private async createAreaNote(areaPath: string, title: string): Promise<void> {
    const file = await this.exclusive(async () => {
      if (!this.alive || !this.requireAccess()) return null;
      const area = this.workbenchEntity(areaPath, this.settings.areaFolder, 'Choose an existing area.');
      const folder = area instanceof TFolder ? area.path : this.settings.areaFolder;
      const body = area instanceof TFile ? this.propertyLink(area, '') : '';
      return this.createUnique(folder, title, body, { tangrow_kind: 'note', tangrow_status: 'open', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') });
    });
    if (!file || !this.alive) return;
    try { await this.openNote(file.path); }
    catch (error) { new Notice(this.error(error)); }
  }
  async setWorkbenchProjectStatus(projectPath: string, status: 'open' | 'done'): Promise<void> {
    let affected: string[] = [];
    try {
      await this.exclusive(async () => {
        const project = this.workbenchEntity(projectPath, this.settings.projectFolder, 'Choose an existing project.');
        const statusSource = (file: TFile) => reportStatusSource({ path: file.path, frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter });
        const files = project instanceof TFile ? [project] : this.canonicalWorkbenchNotes(project);
        const change: ReportStatusChange = project instanceof TFile
          ? { kind: 'note', source: statusSource(project), status }
          : { kind: 'entity', collection: 'projects', path: project.path, sources: files.map(statusSource), status };
        affected = files.length ? files.map((file) => file.path) : [`${project.path}/README.md`];
        // Reporting exclusions do not remove a project from the sidebar.
        await writeReportStatus(this.app, { ...this.settings, reportExcludedFolders: [] }, change);
      });
    } finally {
      for (const path of affected) { this.reportSource.invalidate(path); this.taskLabels.delete(path); }
      if (affected.length) this.notify();
    }
  }
  async revealWorkbenchPath(path: string): Promise<void> {
    const entry = this.app.vault.getAbstractFileByPath(path);
    if (!entry) throw new Error('This file or folder no longer exists.');
    if (!await revealInFileList(this.app, entry)) new Notice(this.t('Open the file explorer and locate: {path}', { path }));
  }
  async addTask(text: string, options: { due?: string; target?: 'overview' | 'daily'; projectNotePath?: string; areaPath?: string } = {}): Promise<string> {
    const line = taskLine(text, options.due);
    const path = options.target === 'daily' ? await this.ensurePeriodicNote('daily', dayKey()) : this.settings.taskOverviewPath;
    await this.exclusive(async () => {
      const note = this.app.vault.getAbstractFileByPath(path);
      if (!(note instanceof TFile) || note.extension !== 'md') throw new Error('Set an existing Tasks note path in Tangrow settings.');
      let entry = line;
      if (options.projectNotePath !== undefined) {
        const project = this.app.vault.getAbstractFileByPath(options.projectNotePath);
        if (!(project instanceof TFile) || project.extension !== 'md' || !inFolder(project.path, this.settings.projectFolder)
          || inFolder(project.path, this.settings.archiveFolder) || (hasValidSupportFolder(this.settings) && inFolder(project.path, this.settings.supportFolder))) {
          throw new Error('Choose an existing project note.');
        }
        entry += ` ${this.propertyLink(project, note.path)}`;
      }
      if (options.areaPath !== undefined) entry += ` ${this.propertyLink(this.workbenchAreaNote(options.areaPath), note.path)}`;
      await this.app.vault.process(note, (content) => appendTaskLine(content, entry));
      this.taskLabels.delete(path);
    });
    if (!this.alive) return path;
    this.notify();
    new Notice(this.t('Task added to {path}.', { path }));
    return path;
  }
  async addProjectTask(projectNotePath: string, title: string): Promise<void> {
    await this.addTask(title, { projectNotePath });
  }
  async addAreaTask(areaPath: string, title: string): Promise<void> {
    await this.addTask(title, { areaPath });
  }
  async completeTask(path: string, line: number, expectedLabel?: string): Promise<void> {
    await this.exclusive(async () => {
      const note = this.app.vault.getAbstractFileByPath(path);
      if (!(note instanceof TFile) || note.extension !== 'md') throw new Error('This note no longer exists.');
      // The indexed label, when known, proves the line is still the task the user saw.
      const label = expectedLabel ?? this.taskLabels.get(path)?.lines.get(line);
      await this.app.vault.process(note, (content) => completeTaskLine(content, line, label));
      this.taskLabels.delete(path);
    });
    if (this.alive) this.notify();
  }

  async updateReportStatus(change: ReportStatusChange): Promise<void> {
    const paths = change.kind === 'task' ? [change.task.path] : change.kind === 'note' ? [change.source.path]
      : [...change.sources.map((source) => source.path), `${change.path}/README.md`];
    try { await this.exclusive(() => writeReportStatus(this.app, this.settings, change)); }
    finally {
      for (const path of paths) { this.reportSource.invalidate(path); this.taskLabels.delete(path); }
      this.notify();
    }
  }

  private secrets(): SecretAccess | null {
    const storage = (this.app as unknown as { secretStorage?: Partial<SecretAccess> }).secretStorage;
    return typeof storage?.getSecret === 'function' && typeof storage.setSecret === 'function' ? storage as SecretAccess : null;
  }
  /** Secret storage protects the key only when no plaintext fallback remains in data.json. */
  aiKeyProtected(): boolean { return this.secrets() !== null && !this.settings.aiApiKey; }
  private aiKey(): string {
    try { return this.secrets()?.getSecret(AI_SECRET_ID)?.trim() || this.settings.aiApiKey; }
    catch { return this.settings.aiApiKey; }
  }
  hasAiKey(): boolean { return Boolean(this.aiKey()); }
  async setAiKey(value: string): Promise<void> {
    const key = value.trim();
    if (key.length > 400 || /\s/.test(key)) throw new Error('This does not look like an API key.');
    await this.exclusive(async () => {
      const secrets = this.secrets();
      const previous = this.settings.aiApiKey;
      if (secrets) { secrets.setSecret(AI_SECRET_ID, key); this.settings.aiApiKey = ''; }
      else this.settings.aiApiKey = key;
      try { await this.persist(); }
      catch (error) { this.settings.aiApiKey = previous; this.notifyAfterRollback(); throw error; }
      this.notify();
    });
  }
  async updateAiSettings(patch: { aiEnabled?: boolean; aiModel?: string }): Promise<void> {
    await this.exclusive(async () => {
      const previous = this.settings;
      const next = { ...previous };
      if (patch.aiEnabled !== undefined) next.aiEnabled = patch.aiEnabled;
      if (patch.aiModel !== undefined) {
        if (readAiModel(patch.aiModel) !== patch.aiModel.trim()) throw new Error('Use a model name such as claude-opus-5-5.');
        next.aiModel = patch.aiModel.trim();
      }
      this.settings = next;
      try { await this.persist(); }
      catch (error) { this.settings = previous; this.notifyAfterRollback(); throw error; }
      this.notify();
    });
  }
  aiReady(): boolean { return this.settings.aiEnabled && this.hasAiKey(); }
  private aiConfig(): { apiKey: string; model: string } {
    if (!this.settings.aiEnabled) throw new Error('Turn on AI features in Tangrow settings first.');
    const apiKey = this.aiKey();
    if (!apiKey) throw new Error('Add your Anthropic API key in Tangrow settings first.');
    return { apiKey, model: this.settings.aiModel };
  }
  async suggestCapture(text: string, signal?: AbortSignal): Promise<CaptureSuggestion> {
    const config = this.aiConfig();
    const projects = captureProjectFiles(this.app, this.settings).map((file) => file.path);
    return parseSuggestion(await this.aiRunner(config, buildSuggestionPrompt(text, projects, this.settings.language, dayKey()), undefined, signal), projects);
  }
  agentStatus(): AgentStatus {
    const api = claudianApi(this.app);
    if (typeof api === 'string') return api;
    try { return api.getActiveSessionId() ? 'ready' : 'idle'; }
    catch { return 'incompatible'; }
  }
  agentRun(): WorkflowRun | null { return this.workflow ? { ...this.workflow } : null; }
  private agentApi(): ClaudianAPI {
    const api = claudianApi(this.app);
    if (api === 'missing') throw new Error('Install and enable the Claudian plugin first.');
    if (typeof api === 'string') throw new Error('This Claudian version is not compatible with Tangrow workflows. Update both plugins.');
    return api;
  }
  /** Reveals Claudian's chat view through its own command. */
  async openAgent(): Promise<void> {
    this.agentApi();
    const commands = (this.app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands;
    if (!commands?.executeCommandById?.(CLAUDIAN_OPEN_COMMAND)) throw new Error('Claudian could not be opened. Open it from the ribbon or the command palette.');
  }
  /** Sends one workflow to the focused Claudian session; the agent reads the vault itself. */
  async runWorkflow(id: WorkflowId): Promise<void> {
    const item = WORKFLOWS.find((entry) => entry.id === id);
    if (!item) throw new Error('Unknown workflow.');
    if (this.workflow?.state === 'running') throw new Error('A workflow is already running in Claudian. Stop it or wait for it to finish.');
    const api = this.agentApi();
    const note = this.activeMarkdown();
    if (item.needsNote && !note) throw new Error('Open a Markdown note first.');
    let sessionId = api.getActiveSessionId();
    if (!sessionId) {
      await this.openAgent();
      sessionId = api.getActiveSessionId();
      if (!sessionId) throw new Error('Open a chat in Claudian, then run this again.');
    }
    await this.ensureAiGuide();
    const today = dayKey();
    const weeklyNote = journalPath(this.settings, 'weekly', today, (value, pattern) => dateTime(value).format(pattern));
    const text = workflowPrompt(id, this.settings, { today, weeklyNote, ...(note ? { activeNote: note.path } : {}) });
    const status = await api.send(sessionId, { text });
    if (!this.alive) return;
    // Session-only turn events cannot identify a queued request behind other user inputs.
    // Track replies only when this send starts a new turn; otherwise follow it in Claudian.
    this.workflow = { workflow: id, sessionId, state: status === 'started' ? 'running' : 'delegated', reply: '' };
    this.notify();
    new Notice(this.t(status === 'queued' ? 'Queued in Claudian. It starts when the current work finishes.' : 'Sent to Claudian.'));
    try { await this.openAgent(); } catch { /* The job is already running; the chat can be opened by hand. */ }
  }
  private async finishWorkflow(sessionId?: string): Promise<void> {
    const run = this.workflow;
    if (!run || run.state !== 'running' || run.sessionId !== sessionId) return;
    let reply = '';
    try {
      const api = claudianApi(this.app);
      if (typeof api !== 'string') reply = (await api.read(sessionId)).trim();
    } catch { /* The reply stays readable in Claudian's own chat. */ }
    if (!this.alive || this.workflow !== run) return;
    this.workflow = { ...run, state: 'done', reply };
    this.reportSource.invalidate();
    this.notify();
  }
  /** Stops the running job like Claudian's Stop button, or dismisses a finished one. */
  async stopWorkflow(): Promise<void> {
    const run = this.workflow;
    if (!run) return;
    this.workflow = null;
    this.notify();
    if (run.state !== 'running') return;
    const api = claudianApi(this.app);
    if (typeof api !== 'string') await api.send(run.sessionId, { mode: 'interrupt' });
  }
  /** Writes the workflows as vault skills. A skill file that already exists is never overwritten. */
  async installAgentSkills(): Promise<void> {
    const adapter = this.app.vault.adapter;
    await this.ensureAiGuide();
    let created = 0;
    let kept = 0;
    for (const file of skillFiles(this.settings)) {
      if (await adapter.exists(file.path)) { kept++; continue; }
      const folders = file.path.split('/').slice(0, -1);
      for (let depth = 1; depth <= folders.length; depth++) {
        const folder = folders.slice(0, depth).join('/');
        if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
      }
      await adapter.write(file.path, file.content);
      created++;
    }
    new Notice(this.t(kept ? 'Installed {created} skills; {kept} already existed and were left unchanged.' : 'Installed {created} skills. Type / in Claudian to use them.', { created, kept }));
  }
  private async ensureAiGuide(): Promise<string> {
    const path = `${this.settings.supportFolder}/AGENTS.md`;
    await this.exclusive(async () => {
      validateFolderSettings(this.settings);
      if (this.app.vault.getAbstractFileByPath(path)) return;
      await this.ensureFolder(this.settings.supportFolder);
      await this.app.vault.create(path, agentGuide(this.settings));
      new Notice(this.t('Agent guide created at {path}.', { path }));
    });
    return path;
  }
  async openAiGuide(): Promise<void> { await this.openNote(await this.ensureAiGuide()); }

  async capture(text: string, submission?: DraftSubmission, rescue = false): Promise<void> {
    if (!(rescue ? text : text.trim())) throw new Error('Write something before saving.');
    const title = this.t('Capture {date}', { date: dateTime().format('YYYY-MM-DD HHmmss') });
    await this.exclusive(() => {
      const fields = { tangrow_kind: 'capture', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') };
      // Only a rescue keeps surrounding whitespace; ordinary saves match createUnique and trim it.
      return submission ? this.createSubmittedNote(submission, 'capture', title, rescue ? text : text.trim(), fields) : this.createUnique(this.settings.inboxFolder, title, text, fields);
    });
    if (!this.alive) return;
    this.notify();
    new Notice(this.t('Captured in your inbox.'));
  }
  submitCaptureDraft(rescue = false): Promise<void> {
    const source = this.composer.capture;
    if (!(rescue ? source : source.trim())) return Promise.reject(new Error('Write something before saving.'));
    const revision = this.captureRevision;
    const pending = this.captureSubmissions.get(revision);
    if (pending) return pending;
    const receipt = this.submissions.capture ??= { id: uid(), path: null };
    const submission = this.capture(source, receipt, rescue).then(async () => {
      if (!this.alive) return;
      if (this.captureRevision === revision && this.composer.capture === source) this.saveComposer({ capture: '' });
      try { await this.persist(); }
      catch {
        new Notice(this.t('Capture saved, but draft state could not be saved. It will be retried.'));
        this.scheduleComposerSave();
      }
    }).finally(() => { this.captureSubmissions.delete(revision); });
    this.captureSubmissions.set(revision, submission);
    return submission;
  }
  submitRecoveryDraft(id: string): Promise<void> {
    const draft = this.recoveryDrafts.get(id);
    if (!draft || this.quickAddSaves.has(id)) return Promise.resolve();
    const pending = this.recoverySaves.get(draft);
    if (pending) return pending;
    const receipt = draft.submission ??= { id: uid(), path: null };
    const saving = this.capture(draft.text, receipt, true).then(async () => {
      if (!this.alive || this.recoveryDrafts.get(id) !== draft) return;
      this.preserveRecoveryDraft(id, draft.label, '');
      try { await this.persist(); }
      catch {
        new Notice(this.t('Capture saved, but draft state could not be saved. It will be retried.'));
        this.scheduleComposerSave();
      }
    }).finally(() => {
      this.recoverySaves.delete(draft);
      for (const listener of this.recoveryListeners) listener();
    });
    this.recoverySaves.set(draft, saving);
    for (const listener of this.recoveryListeners) listener();
    return saving;
  }
  discardRecoveryDraft(id: string): void {
    const draft = this.recoveryDrafts.get(id);
    // A draft that is being saved may already have become a note; let that save finish instead.
    if (!draft || this.quickAddSaves.has(id) || this.recoverySaves.has(draft)) return;
    this.preserveRecoveryDraft(id, draft.label, '');
  }
  private captureFile(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md' || this.app.metadataCache.getFileCache(file)?.frontmatter?.tangrow_kind !== 'capture') throw new Error('This capture no longer exists.');
    return file;
  }
  private async readCaptureSource(path: string, expectedFile?: TFile): Promise<{ file: TFile; body: string }> {
    const file = this.captureFile(path);
    if (expectedFile && expectedFile !== file) throw new Error('This capture no longer exists.');
    const content = await this.app.vault.read(file);
    const info = getFrontMatterInfo(content);
    const fields = info.exists ? parseYaml(info.frontmatter) as Record<string, unknown> | null : null;
    if (fields?.tangrow_kind !== 'capture' || this.app.vault.getAbstractFileByPath(path) !== file) throw new Error('This capture no longer exists.');
    return { file, body: content.slice(info.contentStart).replace(/^(?:\r?\n)+/, '') };
  }
  async readCapture(path: string): Promise<string> {
    return this.app.vault.cachedRead(this.captureFile(path));
  }
  async processCapture(path: string, request: CaptureRequest): Promise<string | null> {
    try {
      const result = await this.exclusive(() => processCapturedNote(this.app, this.settings, path, request));
      new Notice(this.t(request.action === 'pending' ? 'Capture moved back to pending.' : 'Capture processed.'));
      return result;
    } finally {
      this.reportSource.invalidate();
      this.notify();
    }
  }
  async saveDraft(text: string, title: string, origin?: WritingSaveOrigin, submission?: DraftSubmission, rescue = false, projectPath?: string): Promise<void> {
    if (!(rescue ? text : text.trim())) throw new Error('Write a draft before saving.');
    const revision = this.scratchRevision;
    const navigation = captureWritingNavigation(this.app.workspace, origin);
    try {
      const file = await this.exclusive(() => {
        const name = title || this.t('Draft {date}', { date: dateTime().format('YYYY-MM-DD HHmmss') });
        const fields = { tangrow_kind: 'draft', tangrow_status: 'draft', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') };
        return submission ? this.createSubmittedNote(submission, 'draft', name, rescue ? text : text.trim(), fields, projectPath) : this.createUnique(this.settings.inboxFolder, name, text, fields);
      });
      if (!this.alive || this.scratchRevision !== revision || this.scratchEditingView !== undefined) return;
      const target = navigation.destination();
      navigation.dispose();
      if (!target) return;
      try { await target.openFile(file, { active: true }); }
      catch (error) { new Notice(this.t('Draft saved, but it could not be opened: {error}', { error: this.error(error) })); }
    } finally { navigation.dispose(); }
  }
  submitWritingDraft(expectedRevision: number, origin?: WritingSaveOrigin, rescue = false, projectPath?: string): Promise<void> {
    const draft = this.loadWritingDraft();
    if (draft.editingView !== undefined) return Promise.reject(new Error('Finish typing before saving this draft.'));
    if (draft.revision !== expectedRevision) return Promise.reject(new Error('The writing draft changed in another view. Review the latest text before saving.'));
    if (!(rescue ? draft.text || draft.title : draft.text.trim())) return Promise.reject(new Error('Write a draft before saving.'));
    const pending = this.scratchSubmissions.get(draft.revision);
    if (pending) return pending;
    const receipt = this.submissions.writing ??= { id: uid(), path: null };
    // A working title may be empty or contain characters forbidden in a filename.
    const body = rescue ? [draft.title, draft.text].filter(Boolean).join('\n\n') : draft.text;
    const submission = this.saveDraft(body, rescue ? '' : draft.title, origin, receipt, rescue, rescue ? undefined : projectPath).then(async () => {
      if (!this.alive) return;
      this.updateWritingDraft({ text: '', title: '' }, draft.revision);
      try { await this.persist(); }
      catch {
        new Notice(this.t('Draft saved, but scratchpad state could not be saved. It will be retried.'));
        this.scheduleComposerSave();
      }
    }, (error: unknown) => {
      if (this.alive && this.submissions.writing === receipt) {
        for (const listener of this.composerListeners) listener();
      }
      throw error;
    }).finally(() => { this.scratchSubmissions.delete(draft.revision); });
    this.scratchSubmissions.set(draft.revision, submission);
    return submission;
  }

  private isWide(path: string): boolean { return this.settings.wideByDefault !== this.widePages.has(path); }
  private applyWidths(): void {
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      view.containerEl.toggleClass('tangrow-wide', view instanceof MarkdownView && !!view.file && this.isWide(view.file.path));
    });
  }
  private editor(): MarkdownView | null {
    const active = this.activeMarkdown();
    if (!active) return null;
    const currentView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (currentView?.file?.path === active.path) return currentView;
    const recentView = this.app.workspace.getMostRecentLeaf()?.view;
    if (recentView instanceof MarkdownView && recentView.file?.path === active.path) return recentView;
    let found: MarkdownView | null = null;
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (!found && leaf.view instanceof MarkdownView && leaf.view.file?.path === active.path) found = leaf.view;
    });
    return found;
  }
  private instructions(title: string, text: string): void {
    const modal = new Modal(this.app);
    modal.setTitle(this.t(title));
    modal.contentEl.createEl('p', { text: this.t(text) });
    new Setting(modal.contentEl).addButton((button) => button.setButtonText(this.t('Done')).onClick(() => modal.close()));
    modal.open();
  }
  async action(id: ActionId): Promise<void> {
    const file = this.activeFile();
    const requireFile = (): TFile => { if (!file) throw new Error('Open a file first.'); return file; };
    const requireMarkdown = (): TFile => {
      if (file?.extension !== 'md') throw new Error('Open a Markdown note first.');
      return file;
    };
    switch (id) {
      case 'copy-link': {
        const note = requireFile();
        await navigator.clipboard.writeText(this.app.fileManager.generateMarkdownLink(note, ''));
        new Notice(this.t('Internal link copied.')); break;
      }
      case 'copy-path': await navigator.clipboard.writeText(requireFile().path); new Notice(this.t('Vault path copied.')); break;
      case 'file-location': if (!await revealInFileList(this.app, requireFile())) this.instructions('Find this file', this.t('Open the file explorer and locate: {path}', { path: requireFile().path })); break;
      case 'fold': case 'unfold': {
        requireMarkdown();
        const view = this.editor();
        if (!view) throw new Error('Open a note in the editor first.');
        view.editor.exec(id === 'fold' ? 'foldAll' : 'unfoldAll'); break;
      }
      case 'page-width': {
        const path = requireMarkdown().path;
        if (!this.widePages.delete(path)) this.widePages.add(path);
        this.notify(); break;
      }
      case 'all-width': await this.saveSettings((settings) => ({ wideByDefault: !settings.wideByDefault })); break;
      case 'refresh': this.taskLabels.clear(); this.notify(); new Notice(this.t('Tangrow index refreshed.')); break;
      case 'cover': {
        const note = requireMarkdown();
        new PromptModal(this.app, 'Set a local note cover', 'Vault image path, or empty to remove', async (value) => {
          const path = value.trim();
          const image = path ? this.app.metadataCache.getFirstLinkpathDest(path, note.path) : null;
          if (path && (!image || !['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(image.extension.toLowerCase()))) throw new Error('Choose an existing PNG, JPG, WebP, GIF or AVIF image in this vault.');
          await this.app.fileManager.processFrontMatter(note, (fm) => {
            if (image) fm.tangrow_cover = image.path;
            else delete fm.tangrow_cover;
          });
          new Notice(this.t('Cover saved. It appears above a heading in reading view.'));
        }, this.settings.language).open(); break;
      }
      case 'timestamp': {
        requireMarkdown();
        const editor = this.editor()?.editor;
        if (!editor) throw new Error('Open a note in the editor first.');
        editor.replaceSelection(dateTime().format('YYYY-MM-DD HH:mm')); break;
      }
      case 'title-date': {
        const note = requireMarkdown();
        const date = dateTime().format('YYYY-MM-DD');
        const editor = this.editor()?.editor;
        if (editor) {
          const content = editor.getValue();
          const next = stampHeadingDate(content, note.basename, date);
          if (content !== next) {
            let from = 0;
            while (from < content.length && from < next.length && content[from] === next[from]) from++;
            let oldEnd = content.length;
            let newEnd = next.length;
            while (oldEnd > from && newEnd > from && content[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
            const delta = newEnd - oldEnd;
            const position = (offset: number): { line: number; ch: number } => {
              const mapped = offset < from ? offset : offset >= oldEnd ? offset + delta : newEnd;
              const before = next.slice(0, mapped);
              return { line: before.split('\n').length - 1, ch: before.length - before.lastIndexOf('\n') - 1 };
            };
            const selections = editor.listSelections().map(({ anchor, head }) => ({ anchor: position(editor.posToOffset(anchor)), head: position(editor.posToOffset(head)) }));
            const start = editor.offsetToPos(from);
            const end = editor.offsetToPos(oldEnd);
            editor.replaceRange(next.slice(from, newEnd), start, end);
            editor.setSelections(selections);
          }
        } else await this.app.vault.process(note, (content) => stampHeadingDate(content, note.basename, date));
        new Notice(this.t('Date added to the first heading.'));
        break;
      }
      case 'toggle-pin': await this.app.fileManager.processFrontMatter(requireMarkdown(), (fm) => {
        if (fm.tangrow_pin === true) {
          delete fm.tangrow_pin;
          delete fm.tangrow_pinned_at;
        } else {
          fm.tangrow_pin = true;
          fm.tangrow_pinned_at = new Date(Date.now()).toISOString();
        }
      }); this.notify(); break;
      case 'settings': if (!openNativeSettings(this.app, this.manifest.id)) this.instructions('Tangrow settings', 'Open Obsidian Settings, then select Tangrow under Community plugins.'); break;
      case 'appearance': if (!openNativeSettings(this.app, 'appearance')) this.instructions('Appearance', 'Open Obsidian Settings > Appearance to change the theme and accent color.'); break;
      case 'toggle-theme': if (!runNativeCommand(this.app, ['theme:toggle-light-dark'])) this.instructions('Appearance', 'Open Obsidian Settings > Appearance to change the theme and accent color.'); break;
      case 'report': await this.openReport(); break;
      case 'task-overview': {
        const note = this.app.vault.getAbstractFileByPath(this.settings.taskOverviewPath);
        if (!(note instanceof TFile) || note.extension !== 'md') throw new Error('Set an existing Tasks note path in Tangrow settings.');
        await this.openNote(note.path);
        break;
      }
      case 'file-list': await this.app.workspace.ensureSideLeaf('file-explorer', 'left', { active: true }); break;
      case 'stack-tabs': {
        const target = this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit);
        if (target) this.app.workspace.setActiveLeaf(target, { focus: false });
        if (!target || !runNativeCommand(this.app, ['workspace:toggle-stacked-tabs'])) this.instructions('Stack tabs', 'Use the tab group menu > Stack tabs. This option depends on your Obsidian version.');
        break;
      }
      case 'hide-panel': this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach()); break;
      case 'random-note': {
        const excludeSupport = hasValidSupportFolder(this.settings);
        const candidates = this.app.vault.getMarkdownFiles().filter((note) => (!excludeSupport || !inFolder(note.path, this.settings.supportFolder)) && !inFolder(note.path, this.settings.archiveFolder));
        const note = candidates[Math.floor(Math.random() * candidates.length)];
        if (note) await this.openNote(note.path); else new Notice(this.t('There are no notes to revisit yet.')); break;
      }
      case 'daily-note': await this.openPeriodicNote('daily'); break;
    }
  }

  async startFocus(minutes: number): Promise<void> {
    await this.exclusive(async () => {
      validateFolderSettings(this.settings);
      if (this.focus) throw new Error('Finish or discard the current session first.');
      await this.replaceFocus(startSession(minutes, Date.now(), uid(), this.activeMarkdown()?.path ?? null));
    });
  }
  async pauseFocus(): Promise<void> {
    await this.exclusive(async () => { if (this.focus) await this.replaceFocus(pauseSession(this.focus, Date.now())); });
  }
  async resumeFocus(): Promise<void> {
    await this.exclusive(async () => {
      if (!this.focus) return;
      if (await this.recordedFocusMinutes(this.focus) !== null) throw new Error('This session has already been recorded. Finish it before starting another session.');
      await this.replaceFocus(resumeSession(this.focus, Date.now()));
    });
  }
  private async recordedFocusMinutes(session: FocusSession): Promise<number | null> {
    validateFolderSettings(this.settings);
    const path = `${this.settings.supportFolder}/Records/Focus/${session.id}.md`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!existing) return null;
    if (!(existing instanceof TFile)) throw new Error('A folder occupies this focus record path. The session was retained.');
    const info = getFrontMatterInfo(await this.app.vault.cachedRead(existing));
    const fields = info.exists ? parseYaml(info.frontmatter) as Record<string, unknown> : null;
    if (fields?.tangrow_kind !== 'focus' || fields.tangrow_session_id !== session.id) throw new Error('An unrelated file occupies this focus record path. The session was retained.');
    if (fields.tangrow_day !== dayKey(session.startedAt) || typeof fields.tangrow_minutes !== 'number' || !Number.isFinite(fields.tangrow_minutes) || fields.tangrow_minutes < 0 || fields.tangrow_minutes > session.durationMs / 60_000) throw new Error('This focus record has invalid values. The session was retained.');
    return fields.tangrow_minutes;
  }
  async finishFocus(): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    try {
      await this.exclusive(async () => {
        const session = this.focus;
        if (!session) return;
        validateFolderSettings(this.settings);
        const stopped = pauseSession(session, Date.now());
        let elapsed = Math.round(focusMinutes(stopped, Date.now()) * 100) / 100;
        const folder = `${this.settings.supportFolder}/Records/Focus`;
        await this.ensureFolder(folder);
        const path = `${folder}/${session.id}.md`;
        const recordedMinutes = await this.recordedFocusMinutes(session);
        if (recordedMinutes !== null) elapsed = recordedMinutes;
        else {
          const fields = { tangrow_kind: 'focus', tangrow_session_id: session.id, tangrow_day: dayKey(session.startedAt), tangrow_minutes: elapsed, tangrow_source: session.filePath ? `[[${session.filePath.replace(/\.md$/, '')}]]` : null, created: new Date(session.startedAt).toISOString(), finished: new Date().toISOString() };
          await this.app.vault.create(path, `---\n${stringifyYaml(fields)}---\n\n# ${this.t('Focus session')}\n\n${this.t('{minutes} active minutes.', { minutes: elapsed })}\n`);
        }
        this.focus = null;
        try { await this.persist(); }
        catch (error) {
          this.focus = { ...stopped, remainingMs: Math.max(0, session.durationMs - elapsed * 60_000) };
          this.notify();
          throw error;
        }
        this.notify();
        new Notice(this.t('Focus saved: {minutes} minutes.', { minutes: elapsed }));
      });
    } finally { this.finishing = false; }
  }
  async cancelFocus(): Promise<void> {
    await this.exclusive(async () => { await this.replaceFocus(null); });
  }
  async addHabit(name: string): Promise<void> {
    name = name.trim();
    if (!name || name.length > 100) throw new Error('Use a habit name of 1-100 characters.');
    await this.exclusive(async () => {
      if (this.settings.habits.some((habit) => habit.name.toLowerCase() === name.toLowerCase())) throw new Error('This habit already exists.');
      await this.replaceHabits([...this.settings.habits, { id: uid(), name }]);
    });
  }
  async checkHabit(id: string): Promise<void> {
    await this.exclusive(async () => {
      validateFolderSettings(this.settings);
      const habit = this.settings.habits.find((item) => item.id === id);
      if (!habit) throw new Error('This habit was archived.');
      const folder = `${this.settings.supportFolder}/Records/Habits`;
      await this.ensureFolder(folder);
      const day = dayKey();
      const path = `${folder}/${day}-${habit.id}.md`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) {
        if (!(existing instanceof TFile)) throw new Error('An unrelated file occupies this habit record path. Existing content was preserved.');
        const info = getFrontMatterInfo(await this.app.vault.cachedRead(existing));
        const fields = info.exists ? parseYaml(info.frontmatter) as Record<string, unknown> : null;
        if (fields?.tangrow_kind !== 'habit' || fields.tangrow_habit_id !== habit.id || fields.tangrow_day !== day) throw new Error('An unrelated file occupies this habit record path. Existing content was preserved.');
        new Notice(this.t('Already checked in today.'));
        return;
      }
      const fields = { tangrow_kind: 'habit', tangrow_day: day, tangrow_habit_id: habit.id, tangrow_habit: habit.name, created: new Date().toISOString() };
      await this.app.vault.create(path, `---\n${stringifyYaml(fields)}---\n\n# ${this.t('Habit check-in')}\n\n${habit.name}\n`);
      this.notify();
    });
  }
  async archiveHabit(id: string): Promise<void> {
    await this.exclusive(async () => { await this.replaceHabits(this.settings.habits.filter((habit) => habit.id !== id)); });
  }
  private async replaceHabits(habits: Habit[]): Promise<void> {
    const previous = this.settings.habits;
    this.settings.habits = habits;
    try { await this.persist(); }
    catch (error) { this.settings.habits = previous; this.notifyAfterRollback(); throw error; }
    this.notify();
  }
}
