import { FileView, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, moment, normalizePath, parseYaml, getFrontMatterInfo, stringifyYaml, setTooltip, type WorkspaceLeaf } from 'obsidian';
import { baseDefinitions, setupReadme, managedFileTranslations } from './bases';
import { focusMinutes, pauseSession, remainingMs, resumeSession, startSession } from './focus';
import { dayKey, inFolder, readSession, readSettings, recentDays, safeFolder, safeTitle, streak } from './model';
import { openNativeSettings, revealInFileList, runNativeCommand } from './compat';
import { TangrowSidebar, VIEW_TYPE } from './sidebar';
import { TangrowReport, REPORT_VIEW_TYPE } from './report';
import { TangrowCapture, CAPTURE_VIEW_TYPE, openCaptureWindow as revealCaptureWindow } from './capture-window';
import { captureCreated, sortCaptures } from './capture-data';
import { normalizeRecentOpened, recordRecentOpened, renameRecentOpened, removeRecentOpened } from './recent-opened';
import { stampHeadingDate } from './note-tools';
import { matchesGeneratedContent } from './managed-files';
import { hasValidSupportFolder, SupportFolderConflictError, validateFolderSettings } from './folders';
import { moveSupportFolder } from './support-migration';
import { addEditingActivity, createActivityState, normalizeActivityState, summarizeActivity, type EditingActivityState } from './activity';
import { ReportSource } from './report-source';
import { captureWritingNavigation } from './writing-navigation';
import { aggregateReport } from './report-data';
import type { ReportPreferences, ReportRange, ReportSnapshot } from './report-contract';
import { translate, describeError, type TranslationValues } from './i18n';
import { DEFAULT_SETTINGS, type ComposerState, type Habit, type Locale, type ActionId, type BaseId, type FocusSession, type NoteKind, type NoteSummary, type Settings, type SidebarHost, type Snapshot, type TaskSummary, type WritingDraft, type WritingSaveOrigin } from './types';

const dateTime = moment as unknown as (input?: number | string | Date) => { format(pattern: string): string };

interface SavedData { version: number; settings: Settings; focus: FocusSession | null; scratch: string; composer: ComposerState; recentOpened: string[]; activity: EditingActivityState }
interface PersistenceCoordinator { owner?: symbol; tail: Promise<void> }
const PERSISTENCE_COORDINATOR = Symbol.for('tangrow.persistence-coordinator');
type FolderSettingKey = keyof Pick<Settings, 'supportFolder' | 'inboxFolder' | 'projectFolder' | 'areaFolder' | 'resourcesFolder' | 'archiveFolder' | 'journalFolder'>;

class PromptModal extends Modal {
  constructor(app: Plugin['app'], private title: string, private placeholder: string, private submit: (value: string) => Promise<void>, private language: Locale) { super(app); }
  onOpen(): void {
    this.setTitle(translate(this.language, this.title));
    let value = '';
    new Setting(this.contentEl).addText((input) => {
      input.setPlaceholder(translate(this.language, this.placeholder)).onChange((text) => { value = text; });
      input.inputEl.style.width = '100%';
      input.inputEl.addEventListener('keydown', (event) => { if (event.key === 'Enter') void save(); });
      window.setTimeout(() => input.inputEl.focus(), 0);
    });
    const save = async (): Promise<void> => {
      try { await this.submit(value); this.close(); } catch (error) { new Notice(describeError(this.language, error)); }
    };
    new Setting(this.contentEl).addButton((button) => button.setButtonText(translate(this.language, 'Save')).setCta().onClick(save));
  }
  onClose(): void { this.contentEl.empty(); }
}

function uid(): string { return crypto.randomUUID(); }

export default class TangrowPlugin extends Plugin implements SidebarHost {
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
  private readonly reportSource = new ReportSource(this.app);
  private editingActivity = createActivityState();
  private lastActivityEvent: number | null = null;
  private activityTimer: number | undefined;
  private activityWindows = new WeakSet<Window>();

  async onload(): Promise<void> {
    const coordinator = this.persistenceCoordinator();
    await coordinator.tail;
    if (!this.alive) return;
    const stored = (await this.loadData() ?? null) as Partial<SavedData> | null;
    if (!this.alive) return;
    coordinator.owner = this.persistenceOwner;
    this.persistenceClaimed = true;
    this.settings = readSettings(stored?.settings);
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
    const hasHistory = stored !== null && Object.hasOwn(stored, 'recentOpened');
    this.recentOpened = normalizeRecentOpened(hasHistory ? stored.recentOpened : this.app.workspace.getLastOpenFiles(), (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
    this.dataLoaded = true;
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
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new TangrowSidebar(leaf, this));
    this.registerView(REPORT_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TangrowReport(leaf, this));
    this.registerView(CAPTURE_VIEW_TYPE, (leaf: WorkspaceLeaf) => new TangrowCapture(leaf, this));
    if (!stored?.settings?.language && this.settings.language === 'zh-CN') {
      await this.localizeManagedFiles('en');
      await this.persist();
    }
    if (stored?.version !== 4 || !hasHistory || JSON.stringify(stored.recentOpened) !== JSON.stringify(this.recentOpened)) {
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
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => { this.lastActivityEvent = null; refresh(); }));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, info) => this.recordEditingActivity(info)));
    this.registerEvent(this.app.workspace.on('window-open', (_workspaceWindow, win) => this.watchActivityWindow(win)));
    if (typeof window !== 'undefined' && window.document) this.watchActivityWindow(window);
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
      this.applyWidths();
      if (this.settings.autoOpen) void this.openSidebar().catch((error) => new Notice(this.error(error)));
    });
  }

  onunload(): void {
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
  }

  t(source: string, values?: TranslationValues): string { return translate(this.settings.language, source, values); }
  error(error: unknown): string {
    if (error instanceof SupportFolderConflictError) return this.t('The companion folder {support} must not equal or contain the content folder {content}.', { support: error.supportFolder, content: error.contentFolder });
    return describeError(this.settings.language, error);
  }

  private registerCommands(): void {
    if (this.commandsRegistered) {
      for (const id of ['open-companion', 'open-report', 'open-capture-window', 'setup-bases', 'migrate-companion-folder', 'quick-capture', 'pin-note']) this.removeCommand(id);
    }
    this.addCommand({ id: 'open-companion', name: this.t('Open companion'), callback: () => { void this.openSidebar().catch((error) => new Notice(this.error(error))); } });
    this.addCommand({ id: 'open-report', name: this.t('Open report'), callback: () => { void this.openReport().catch((error) => new Notice(this.error(error))); } });
    this.addCommand({ id: 'setup-bases', name: this.t('Set up companion Bases'), callback: () => { void this.setup().catch((error) => new Notice(this.error(error))); } });
    this.addCommand({ id: 'migrate-companion-folder', name: this.t('Move companion folder to 99-Tangrow'), callback: () => { void this.migrateCompanionFolder().catch((error) => new Notice(this.error(error))); } });
    const captureWindow = (): void => { void this.openCaptureWindow().catch((error) => new Notice(this.error(error))); };
    this.addCommand({ id: 'quick-capture', name: this.t('Quick capture'), callback: captureWindow });
    this.addCommand({ id: 'open-capture-window', name: this.t('Open capture window'), callback: captureWindow });
    this.addCommand({ id: 'pin-note', name: this.t('Pin or unpin current note'), checkCallback: (checking) => {
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
      try { await this.persist(); } catch (error) { this.settings.language = previous; throw error; }
      if (!this.alive) return;
      try { await this.localizeManagedFiles(previous); }
      finally {
        if (this.alive) {
          if (this.commandsRegistered) this.registerCommands();
          if (this.ribbon) setTooltip(this.ribbon, this.t('Open Tangrow'));
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
  openCaptureWindow(): Promise<void> { return revealCaptureWindow(this.app, this); }
  async openReport(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(REPORT_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.setViewState({ type: REPORT_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeComposer(listener: () => void): () => void { this.composerListeners.add(listener); return () => this.composerListeners.delete(listener); }
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
    for (const listener of this.listeners) listener();
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
    return structuredClone({ version: 4, settings: this.settings, focus: this.focus, scratch: this.scratch, composer: this.composer, recentOpened: this.recentOpened, activity: this.editingActivity });
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
    try { await this.persist(); } catch (error) { this.focus = previous; this.notify(); throw error; }
    this.notify();
  }
  async saveSettings(): Promise<void> { await this.persist(); this.notify(); }
  async loadReport(range: ReportRange): Promise<ReportSnapshot> {
    const settings = structuredClone(this.settings);
    const source = await this.reportSource.collect(settings);
    const now = Date.now();
    return {
      data: aggregateReport(source.records, settings, now, { range, folders: source.folders }),
      records: source.records,
      activity: summarizeActivity(this.editingActivity, range, now),
      generatedAt: now,
      quality: { unreadable: source.unreadable, linksReady: source.linksReady }
    };
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
      catch (error) { this.settings = previous; throw error; }
      this.lastActivityEvent = null;
      this.reportSource.invalidate();
      this.notify();
      new Notice(this.t('Report preferences saved. Existing notes and Bases were preserved.'));
    });
  }
  private watchActivityWindow(win: Window): void {
    if (this.activityWindows.has(win) || typeof this.registerDomEvent !== 'function') return;
    this.activityWindows.add(win);
    this.registerDomEvent(win, 'blur', () => { this.lastActivityEvent = null; });
    this.registerDomEvent(win.document, 'visibilitychange', () => { this.lastActivityEvent = null; });
  }
  private recordEditingActivity(info: unknown): void {
    if (!this.alive || !this.settings.trackEditingActivity || !(info instanceof MarkdownView) || !info.file) { this.lastActivityEvent = null; return; }
    const doc = info.containerEl.ownerDocument;
    const path = info.file.path;
    const excluded = (hasValidSupportFolder(this.settings) && inFolder(path, this.settings.supportFolder))
      || this.settings.reportExcludedFolders.some((folder) => inFolder(path, folder));
    if (!doc || doc.hidden || !doc.hasFocus() || this.activeFile()?.path !== path || excluded) { this.lastActivityEvent = null; return; }
    this.watchActivityWindow(doc.defaultView ?? window);
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
      catch (error) { this.settings[key] = previous; this.notify(); throw error; }
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
  loadWritingDraft(): WritingDraft {
    return { text: this.scratch, title: this.composer.scratchTitle, revision: this.scratchRevision, ...(this.scratchEditingView ? { editingView: this.scratchEditingView } : {}) };
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
      this.captureRevision++;
      changed = true;
    }
    if (this.scratchEditingView === undefined && typeof patch.scratchTitle === 'string' && patch.scratchTitle !== this.composer.scratchTitle) {
      this.composer.scratchTitle = patch.scratchTitle;
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
        const match = /^\s*(?:[-*+]|\d+[.)])\s+\[[ /]\]\s+(.*)$/.exec(line);
        if (match?.[1]) lines.set(index, match[1]);
      });
      this.taskLabels.set(path, { mtime, lines });
    }).catch(() => {
      this.taskLabels.set(path, { mtime, lines: new Map() });
    }).finally(() => {
      this.taskReads.delete(path);
      if (this.alive) this.notify();
    });
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
        if (item.task === ' ' || item.task === '/') taskNotes.push({ path: file.path, line: item.position.start.line, text: this.taskLabels.get(file.path)?.lines.get(item.position.start.line) ?? this.t('{name} · line {line}', { name: file.basename, line: item.position.start.line + 1 }), done: false });
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
      captures: sortCaptures(notes.filter((file) => byKind(file, 'capture')).map((file) => ({ ...this.summary(file), created: captureCreated(this.app.metadataCache.getFileCache(file)?.frontmatter?.created, file.stat.ctime, file.stat.mtime) }))),
      drafts: recent.filter((file) => byKind(file, 'draft')).slice(0, 12).map((file) => this.summary(file)),
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
  private async createUnique(folder: string, title: string, body: string, fields: Record<string, unknown>): Promise<TFile> {
    folder = safeFolder(folder);
    title = safeTitle(title);
    await this.ensureFolder(folder);
    let path = `${folder}/${title}.md`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(path)) path = `${folder}/${title} (${suffix++}).md`;
    return this.app.vault.create(path, `---\n${stringifyYaml(fields)}---\n\n# ${title}\n\n${body.trim()}\n`);
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
  async openNote(path: string, line?: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('This note no longer exists.');
    const candidate = this.app.workspace.getLeaf(false);
    const leaf = candidate.view.getViewType() === CAPTURE_VIEW_TYPE ? this.app.workspace.getLeaf('tab') : candidate;
    await leaf.openFile(file, { active: true, eState: line === undefined ? undefined : { line } });
  }
  async createNote(kind: NoteKind, title: string, projectFolder?: string): Promise<void> {
    const file = await this.exclusive(() => {
      let folder = this.settings.inboxFolder;
      if (kind === 'project') {
        const root = safeFolder(this.settings.projectFolder);
        if (projectFolder) {
          folder = safeFolder(projectFolder);
          if (!inFolder(folder, root) || !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) throw new Error('Choose an existing project subfolder.');
        } else {
          folder = `${root}/${safeTitle(title)}`;
          if (this.app.vault.getAbstractFileByPath(folder)) throw new Error('This project folder already exists. Choose it from the existing project list.');
        }
      }
      return this.createUnique(folder, title, '', { tangrow_kind: kind, tangrow_status: 'open', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') });
    });
    await this.openNote(file.path);
  }
  async capture(text: string): Promise<void> {
    if (!text.trim()) throw new Error('Write something before saving.');
    const title = this.t('Capture {date}', { date: dateTime().format('YYYY-MM-DD HHmmss') });
    await this.exclusive(() => this.createUnique(this.settings.inboxFolder, title, text, { tangrow_kind: 'capture', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') }));
    if (!this.alive) return;
    this.notify();
    new Notice(this.t('Captured in your inbox.'));
  }
  submitCaptureDraft(): Promise<void> {
    const source = this.composer.capture;
    if (!source.trim()) return Promise.reject(new Error('Write something before saving.'));
    const revision = this.captureRevision;
    const pending = this.captureSubmissions.get(revision);
    if (pending) return pending;
    const submission = this.capture(source).then(async () => {
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
  async readCapture(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || file.extension !== 'md' || this.app.metadataCache.getFileCache(file)?.frontmatter?.tangrow_kind !== 'capture') throw new Error('This capture no longer exists.');
    return this.app.vault.cachedRead(file);
  }
  async saveDraft(text: string, title: string, origin?: WritingSaveOrigin): Promise<void> {
    if (!text.trim()) throw new Error('Write a draft before saving.');
    const revision = this.scratchRevision;
    const navigation = captureWritingNavigation(this.app.workspace, origin);
    try {
      const file = await this.exclusive(() => this.createUnique(this.settings.inboxFolder, title || this.t('Draft {date}', { date: dateTime().format('YYYY-MM-DD HHmmss') }), text, { tangrow_kind: 'draft', tangrow_status: 'draft', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') }));
      if (!this.alive || this.scratchRevision !== revision || this.scratchEditingView !== undefined) return;
      const target = navigation.destination();
      navigation.dispose();
      if (!target) return;
      try { await target.openFile(file, { active: true }); }
      catch (error) { new Notice(this.t('Draft saved, but it could not be opened: {error}', { error: this.error(error) })); }
    } finally { navigation.dispose(); }
  }
  submitWritingDraft(expectedRevision: number, origin?: WritingSaveOrigin): Promise<void> {
    const draft = this.loadWritingDraft();
    if (draft.editingView !== undefined) return Promise.reject(new Error('Finish typing before saving this draft.'));
    if (draft.revision !== expectedRevision) return Promise.reject(new Error('The writing draft changed in another view. Review the latest text before saving.'));
    if (!draft.text.trim()) return Promise.reject(new Error('Write a draft before saving.'));
    const pending = this.scratchSubmissions.get(draft.revision);
    if (pending) return pending;
    const submission = this.saveDraft(draft.text, draft.title, origin).then(async () => {
      if (!this.alive) return;
      this.updateWritingDraft({ text: '', title: '' }, draft.revision);
      try { await this.persist(); }
      catch {
        new Notice(this.t('Draft saved, but scratchpad state could not be saved. It will be retried.'));
        this.scheduleComposerSave();
      }
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
      case 'all-width': this.settings.wideByDefault = !this.settings.wideByDefault; this.widePages.clear(); await this.saveSettings(); break;
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
      case 'daily-note': {
        const formatted = dateTime().format(this.settings.journalFormat);
        const path = normalizePath(`${safeFolder(this.settings.journalFolder)}/${formatted}.md`);
        const relative = path.slice(this.settings.journalFolder.length + 1);
        if (!path.startsWith(`${this.settings.journalFolder}/`) || relative.split('/').some((part) => part.startsWith('.')) || /[\u0000-\u001f:*?"<>|]/.test(path)) throw new Error('The journal format must resolve to a safe relative vault path.');
        let note = this.app.vault.getAbstractFileByPath(path);
        if (!note) {
          const folder = path.slice(0, path.lastIndexOf('/'));
          await this.exclusive(async () => {
            await this.ensureFolder(folder);
            if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, `---\njournal: Daily\njournal-date: ${dayKey()}\n---\n\n# ${dayKey()}\n`);
          });
          note = this.app.vault.getAbstractFileByPath(path);
        }
        if (!(note instanceof TFile)) throw new Error('The journal path is occupied by a folder.');
        await this.openNote(note.path); break;
      }
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
    catch (error) { this.settings.habits = previous; this.notify(); throw error; }
    this.notify();
  }
}

class TangrowSettings extends PluginSettingTab {
  constructor(private plugin: TangrowPlugin) { super(plugin.app, plugin); }
  display(): void {
    this.containerEl.empty();
    const t = (source: string): string => this.plugin.t(source);
    this.containerEl.createEl('h2', { text: 'Tangrow' });
    this.containerEl.createEl('p', { text: t('Your folders stay in place. These paths tell the companion where to read and where to add new files.') });
    new Setting(this.containerEl).setName(t('Interface language')).setDesc(t('Chinese is the default. Change the language without renaming notes or database files.')).addDropdown((dropdown) => dropdown
      .addOption('zh-CN', t('Simplified Chinese'))
      .addOption('en', 'English')
      .setValue(this.plugin.settings.language)
      .onChange(async (value) => {
        try { await this.plugin.setLanguage(value as Locale); }
        catch (error) { new Notice(this.plugin.error(error)); }
        this.display();
      }));
    const folders: Array<[FolderSettingKey, string]> = [
      ['supportFolder', 'Companion folder'], ['inboxFolder', 'Inbox'], ['projectFolder', 'Projects'], ['areaFolder', 'Areas'], ['resourcesFolder', 'Resources'], ['archiveFolder', 'Archive'], ['journalFolder', 'Journal folder']
    ];
    for (const [key, label] of folders) {
      let value = this.plugin.settings[key];
      new Setting(this.containerEl).setName(t(label)).setDesc(t(key === 'supportFolder' ? 'New Bases and focus/habit records only. Changing this path does not move existing files.' : 'Existing vault-relative folder. No files are moved.')).addText((input) => input.setValue(value).onChange((text) => { value = text; })).addButton((button) => button.setButtonText(t('Apply')).onClick(async () => {
        try { await this.plugin.updateFolderSetting(key, value); new Notice(t('Path saved. Existing Bases keep their filters: edit them manually or choose a new companion folder and run setup.')); } catch (error) { new Notice(this.plugin.error(error)); }
      }));
    }
    new Setting(this.containerEl).setName(t('Move companion folder')).setDesc(t('Move the current companion folder to 99-Tangrow at the vault root. Existing destinations are never merged; customized files are preserved.')).addButton((button) => button.setButtonText(t('Move to 99-Tangrow')).setDisabled(this.plugin.settings.supportFolder === DEFAULT_SETTINGS.supportFolder).onClick(async () => {
      button.setDisabled(true);
      try { await this.plugin.migrateCompanionFolder(); this.display(); }
      catch (error) { new Notice(this.plugin.error(error)); }
      finally { button.setDisabled(this.plugin.settings.supportFolder === DEFAULT_SETTINGS.supportFolder); }
    }));
    let taskOverviewPath = this.plugin.settings.taskOverviewPath;
    new Setting(this.containerEl).setName(t('Task overview note')).setDesc(t('Existing Tasks note path. Tangrow opens it without changing its queries.')).addText((input) => input.setValue(taskOverviewPath).onChange((value) => { taskOverviewPath = value; })).addButton((button) => button.setButtonText(t('Apply')).onClick(async () => {
      try {
        const path = safeFolder(taskOverviewPath);
        const note = this.app.vault.getAbstractFileByPath(path);
        if (!(note instanceof TFile) || note.extension !== 'md') throw new Error('Set an existing Tasks note path in Tangrow settings.');
        const previous = this.plugin.settings.taskOverviewPath;
        this.plugin.settings.taskOverviewPath = path;
        try { await this.plugin.saveSettings(); }
        catch (error) { this.plugin.settings.taskOverviewPath = previous; throw error; }
        new Notice(t('Task overview path saved.'));
      } catch (error) { new Notice(this.plugin.error(error)); }
    }));
    let journalFormat = this.plugin.settings.journalFormat;
    new Setting(this.containerEl).setName(t('Journal date format')).setDesc(t('Moment format, including literal folder names in brackets.')).addText((text) => text.setValue(journalFormat).onChange((value) => { journalFormat = value; })).addButton((button) => button.setButtonText(t('Apply')).onClick(async () => {
      if (!journalFormat.trim() || journalFormat.length >= 100) { new Notice(t('Use a date format of 1-99 characters.')); return; }
      this.plugin.settings.journalFormat = journalFormat; await this.plugin.saveSettings();
    }));
    new Setting(this.containerEl).setName(t('Open companion on startup')).addToggle((toggle) => toggle.setValue(this.plugin.settings.autoOpen).onChange(async (value) => { this.plugin.settings.autoOpen = value; await this.plugin.saveSettings(); }));
    new Setting(this.containerEl).setName(t('Default focus duration')).setDesc(t('Minutes, from 1 to 240.')).addText((input) => input.setValue(String(this.plugin.settings.focusMinutes)).onChange(async (value) => {
      const minutes = Number(value);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) return;
      this.plugin.settings.focusMinutes = minutes; await this.plugin.saveSettings();
    }));
    new Setting(this.containerEl).setName(t('Set up companion Bases')).setDesc(t('Create missing files only. Existing Bases and notes are never overwritten.')).addButton((button) => button.setButtonText(t('Set up Bases')).onClick(async () => { try { await this.plugin.setup(); } catch (error) { new Notice(this.plugin.error(error)); } }));
  }
}
