import { MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, moment, normalizePath, parseYaml, getFrontMatterInfo, stringifyYaml, setTooltip, type WorkspaceLeaf } from 'obsidian';
import { baseDefinitions, setupReadme, managedFileTranslations } from './bases';
import { focusMinutes, pauseSession, remainingMs, resumeSession, startSession } from './focus';
import { dayKey, inFolder, readSession, readSettings, recentDays, safeFolder, safeTitle, streak } from './model';
import { openNativeSettings, revealInFileList, runNativeCommand } from './compat';
import { TangrowSidebar, VIEW_TYPE } from './sidebar';
import { matchesGeneratedContent } from './managed-files';
import { translate, describeError, type TranslationValues } from './i18n';
import { DEFAULT_SETTINGS, type Locale, type ActionId, type BaseId, type FocusSession, type NoteKind, type NoteSummary, type Settings, type SidebarHost, type Snapshot, type TaskSummary } from './types';

const dateTime = moment as unknown as (input?: number | string | Date) => { format(pattern: string): string };

interface SavedData { version: number; settings: Settings; focus: FocusSession | null; scratch: string }

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
  private listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
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
  private commandsRegistered = false;
  private ribbon: HTMLElement | null = null;

  async onload(): Promise<void> {
    const stored = await this.loadData() as Partial<SavedData> | null;
    this.settings = readSettings(stored?.settings);
    this.focus = readSession(stored?.focus);
    this.scratch = typeof stored?.scratch === 'string' ? stored.scratch : '';
    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new TangrowSidebar(leaf, this));
    if (!stored?.settings?.language && this.settings.language === 'zh-CN') {
      await this.localizeManagedFiles('en');
      await this.persist();
    }
    this.ribbon = this.addRibbonIcon('sprout', this.t('Open Tangrow'), () => { void this.openSidebar().catch((error) => new Notice(this.error(error))); });
    this.registerCommands();
    this.addSettingTab(new TangrowSettings(this));
    const refresh = (): void => this.scheduleRefresh();
    this.registerEvent(this.app.workspace.on('file-open', refresh));
    this.registerEvent(this.app.workspace.on('active-leaf-change', refresh));
    this.registerEvent(this.app.metadataCache.on('changed', refresh));
    this.registerEvent(this.app.metadataCache.on('resolved', refresh));
    this.registerEvent(this.app.vault.on('create', refresh));
    this.registerEvent(this.app.vault.on('delete', refresh));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.widePages.delete(oldPath)) this.widePages.add(file.path);
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
      if (this.focus?.endsAt !== null && this.focus && remainingMs(this.focus, Date.now()) <= 0 && !this.finishing) {
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
    this.alive = false;
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
    window.clearTimeout(this.scratchTimer);
    window.clearTimeout(this.refreshTimer);
    void this.persist().catch((error) => console.error('Tangrow save failed', error));
    this.app.workspace.iterateAllLeaves((leaf) => leaf.view.containerEl.removeClass('tangrow-wide'));
    this.listeners.clear();
  }

  t(source: string, values?: TranslationValues): string { return translate(this.settings.language, source, values); }
  error(error: unknown): string { return describeError(this.settings.language, error); }

  private registerCommands(): void {
    if (this.commandsRegistered) {
      for (const id of ['open-companion', 'setup-bases', 'quick-capture', 'pin-note']) this.removeCommand(id);
    }
    this.addCommand({ id: 'open-companion', name: this.t('Open companion'), callback: () => { void this.openSidebar().catch((error) => new Notice(this.error(error))); } });
    this.addCommand({ id: 'setup-bases', name: this.t('Set up companion Bases'), callback: () => { void this.setup().catch((error) => new Notice(this.error(error))); } });
    this.addCommand({ id: 'quick-capture', name: this.t('Quick capture'), callback: () => new PromptModal(this.app, 'Capture a thought', 'A thought worth keeping', (text) => this.capture(text), this.settings.language).open() });
    this.addCommand({ id: 'pin-note', name: this.t('Pin or unpin current note'), checkCallback: (checking) => {
      if (!this.activeMarkdown()) return false;
      if (!checking) void this.action('toggle-pin').catch((error) => new Notice(this.error(error)));
      return true;
    } });
    this.commandsRegistered = true;
  }

  private async localizeManagedFiles(previousLanguage: Locale): Promise<number> {
    let updated = 0;
    for (const change of managedFileTranslations(this.settings, previousLanguage)) {
      const file = this.app.vault.getAbstractFileByPath(`${this.settings.supportFolder}/${change.filename}`);
      if (!(file instanceof TFile) || change.previous === change.next) continue;
      if (!matchesGeneratedContent(change.filename, await this.app.vault.cachedRead(file), change.previous, parseYaml)) continue;
      await this.app.vault.process(file, (content) => {
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
      try { await this.localizeManagedFiles(previous); }
      finally {
        if (this.commandsRegistered) this.registerCommands();
        if (this.ribbon) setTooltip(this.ribbon, this.t('Open Tangrow'));
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
          if (leaf.view instanceof TangrowSidebar) leaf.view.refreshLanguage();
        }
        this.notify();
      }
    });
  }

  async openSidebar(): Promise<void> { await this.app.workspace.ensureSideLeaf(VIEW_TYPE, 'right', { active: false }); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void {
    this.cachedSnapshot = null;
    this.applyWidths();
    for (const listener of this.listeners) listener();
  }
  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.notify(), 180);
  }
  private persist(): Promise<void> {
    const next = this.writes.catch(() => undefined).then(async () => {
      const data: SavedData = { version: 1, settings: this.settings, focus: this.focus, scratch: this.scratch };
      await this.saveData(structuredClone(data));
    });
    this.writes = next;
    return next;
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
  loadScratch(): string { return this.scratch; }
  saveScratch(value: string): void {
    this.scratch = value;
    if (!this.alive) { void this.persist().catch((error) => console.error('Tangrow save failed', error)); return; }
    window.clearTimeout(this.scratchTimer);
    this.scratchTimer = window.setTimeout(() => { void this.persist().catch((error) => new Notice(this.error(error))); }, 350);
  }

  private activeMarkdown(): TFile | null {
    const file = this.app.workspace.getActiveFile();
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
        const match = /^\s*(?:[-*+]|\d+[.)])\s+\[ \]\s+(.*)$/.exec(line);
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
    if (this.cachedSnapshot) return { ...this.cachedSnapshot, focus: this.focus, focusRemainingMs: remainingMs(this.focus, Date.now()) };
    const files = this.app.vault.getMarkdownFiles();
    const notes = files.filter((file) => !inFolder(file.path, this.settings.supportFolder));
    const recent = [...notes].sort((a, b) => b.stat.mtime - a.stat.mtime);
    const taskNotes: TaskSummary[] = [];
    const habitDays = new Map<string, Set<string>>();
    let totalMinutes = 0;
    const byKind = (file: TFile, kind: string): boolean => this.app.metadataCache.getFileCache(file)?.frontmatter?.tangrow_kind === kind;
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (fm?.tangrow_kind === 'focus' && Number.isFinite(fm.tangrow_minutes)) totalMinutes += Math.max(0, Number(fm.tangrow_minutes));
      if (fm?.tangrow_kind === 'habit' && typeof fm.tangrow_habit_id === 'string' && typeof fm.tangrow_day === 'string') {
        const days = habitDays.get(fm.tangrow_habit_id) ?? new Set<string>();
        days.add(fm.tangrow_day);
        habitDays.set(fm.tangrow_habit_id, days);
      }
      if (inFolder(file.path, this.settings.supportFolder) || inFolder(file.path, this.settings.archiveFolder)) continue;
      if (cache?.listItems?.some((item) => item.task === ' ')) this.indexTaskLabels(file);
      for (const item of cache?.listItems ?? []) {
        if (item.task !== undefined && item.task === ' ') taskNotes.push({ path: file.path, line: item.position.start.line, text: this.taskLabels.get(file.path)?.lines.get(item.position.start.line) ?? this.t('{name} · line {line}', { name: file.basename, line: item.position.start.line + 1 }), done: false });
      }
    }
    const active = this.activeMarkdown();
    this.cachedSnapshot = {
      active: active ? this.summary(active) : null,
      activePinned: active ? this.app.metadataCache.getFileCache(active)?.frontmatter?.tangrow_pin === true : false,
      counts: { notes: notes.length, projects: notes.filter((file) => inFolder(file.path, this.settings.projectFolder)).length, captures: notes.filter((file) => byKind(file, 'capture')).length, drafts: notes.filter((file) => byKind(file, 'draft')).length, focusMinutes: Math.round(totalMinutes), tasks: taskNotes.length },
      recent: recent.slice(0, 8).map((file) => this.summary(file)),
      pins: recent.filter((file) => this.app.metadataCache.getFileCache(file)?.frontmatter?.tangrow_pin === true).map((file) => this.summary(file)),
      captures: recent.filter((file) => byKind(file, 'capture')).slice(0, 12).map((file) => this.summary(file)),
      drafts: recent.filter((file) => byKind(file, 'draft')).slice(0, 12).map((file) => this.summary(file)),
      tasks: taskNotes,
      habits: this.settings.habits.map((habit) => {
        const days = habitDays.get(habit.id) ?? new Set<string>();
        return { ...habit, completedToday: days.has(dayKey()), streak: streak(days), days: recentDays(14).map((day) => days.has(day)) };
      }),
      focus: this.focus,
      focusRemainingMs: remainingMs(this.focus, Date.now()),
      supportReady: this.app.vault.getAbstractFileByPath(`${this.settings.supportFolder}/${baseDefinitions(this.settings)[0]?.filename}`) instanceof TFile,
      widePage: active ? this.isWide(active.path) : false
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
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true, eState: line === undefined ? undefined : { line } });
  }
  async createNote(kind: NoteKind, title: string): Promise<void> {
    const file = await this.exclusive(() => this.createUnique(kind === 'project' ? this.settings.projectFolder : this.settings.inboxFolder, title, '', { tangrow_kind: kind, tangrow_status: 'open', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') }));
    await this.openNote(file.path);
  }
  async capture(text: string): Promise<void> {
    if (!text.trim()) throw new Error('Write something before saving.');
    const title = this.t('Capture {date}', { date: dateTime().format('YYYY-MM-DD HHmmss') });
    await this.exclusive(() => this.createUnique(this.settings.inboxFolder, title, text, { tangrow_kind: 'capture', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') }));
    this.notify();
    new Notice(this.t('Captured in your inbox.'));
  }
  async saveDraft(text: string, title: string): Promise<void> {
    if (!text.trim()) throw new Error('Write a draft before saving.');
    const file = await this.exclusive(() => this.createUnique(this.settings.inboxFolder, title || this.t('Draft {date}', { date: dateTime().format('YYYY-MM-DD HHmmss') }), text, { tangrow_kind: 'draft', tangrow_status: 'draft', created: dateTime().format('YYYY-MM-DDTHH:mm:ssZ') }));
    await this.openNote(file.path);
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
    let found: MarkdownView | null = null;
    this.app.workspace.iterateRootLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === active?.path) found = leaf.view;
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
    const file = this.activeMarkdown();
    const requireFile = (): TFile => { if (!file) throw new Error('Open a Markdown note first.'); return file; };
    switch (id) {
      case 'copy-link': {
        const note = requireFile();
        await navigator.clipboard.writeText(this.app.fileManager.generateMarkdownLink(note, ''));
        new Notice(this.t('Internal link copied.')); break;
      }
      case 'copy-path': await navigator.clipboard.writeText(requireFile().path); new Notice(this.t('Vault path copied.')); break;
      case 'file-location': if (!await revealInFileList(this.app, requireFile())) this.instructions('Find this file', this.t('Open the file explorer and locate: {path}', { path: requireFile().path })); break;
      case 'fold': case 'unfold': {
        const view = this.editor();
        if (!view) throw new Error('Open a note in the editor first.');
        view.editor.exec(id === 'fold' ? 'foldAll' : 'unfoldAll'); break;
      }
      case 'page-width': {
        const path = requireFile().path;
        if (!this.widePages.delete(path)) this.widePages.add(path);
        this.notify(); break;
      }
      case 'all-width': this.settings.wideByDefault = !this.settings.wideByDefault; this.widePages.clear(); await this.saveSettings(); break;
      case 'refresh': this.taskLabels.clear(); this.notify(); new Notice(this.t('Tangrow index refreshed.')); break;
      case 'cover': {
        const note = requireFile();
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
        const editor = this.editor()?.editor;
        if (!editor) throw new Error('Open a note in the editor first.');
        editor.replaceSelection(dateTime().format('YYYY-MM-DD HH:mm')); break;
      }
      case 'toggle-pin': await this.app.fileManager.processFrontMatter(requireFile(), (fm) => {
        if (fm.tangrow_pin === true) delete fm.tangrow_pin;
        else fm.tangrow_pin = true;
      }); this.notify(); break;
      case 'settings': if (!openNativeSettings(this.app, this.manifest.id)) this.instructions('Tangrow settings', 'Open Obsidian Settings, then select Tangrow under Community plugins.'); break;
      case 'appearance': if (!openNativeSettings(this.app, 'appearance')) this.instructions('Appearance', 'Open Obsidian Settings > Appearance to change the theme and accent color.'); break;
      case 'file-list': await this.app.workspace.ensureSideLeaf('file-explorer', 'left', { active: true }); break;
      case 'stack-tabs': if (!runNativeCommand(this.app, ['workspace:toggle-stacked-tabs'])) this.instructions('Stack tabs', 'Use the tab group menu > Stack tabs. This option depends on your Obsidian version.'); break;
      case 'hide-panel': this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach()); break;
      case 'random-note': {
        const candidates = this.app.vault.getMarkdownFiles().filter((note) => !inFolder(note.path, this.settings.supportFolder) && !inFolder(note.path, this.settings.archiveFolder));
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
      if (this.focus) throw new Error('Finish or discard the current session first.');
      await this.replaceFocus(startSession(minutes, Date.now(), uid(), this.activeMarkdown()?.path ?? null));
    });
  }
  async pauseFocus(): Promise<void> {
    await this.exclusive(async () => { if (this.focus) await this.replaceFocus(pauseSession(this.focus, Date.now())); });
  }
  async resumeFocus(): Promise<void> {
    await this.exclusive(async () => { if (this.focus) await this.replaceFocus(resumeSession(this.focus, Date.now())); });
  }
  async finishFocus(): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    try {
      await this.exclusive(async () => {
        const session = this.focus;
        if (!session) return;
        const elapsed = Math.round(focusMinutes(session, Date.now()) * 100) / 100;
        const folder = `${this.settings.supportFolder}/Records/Focus`;
        await this.ensureFolder(folder);
        const path = `${folder}/${session.id}.md`;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing) {
          if (!(existing instanceof TFile)) throw new Error('A folder occupies this focus record path. The session was retained.');
          const content = await this.app.vault.cachedRead(existing);
          const info = getFrontMatterInfo(content);
          const fields = info.exists ? parseYaml(info.frontmatter) as Record<string, unknown> : null;
          if (fields?.tangrow_kind !== 'focus' || fields.tangrow_session_id !== session.id) throw new Error('An unrelated file occupies this focus record path. The session was retained.');
        } else {
          const fields = { tangrow_kind: 'focus', tangrow_session_id: session.id, tangrow_day: dayKey(session.startedAt), tangrow_minutes: elapsed, tangrow_source: session.filePath ? `[[${session.filePath.replace(/\.md$/, '')}]]` : null, created: new Date(session.startedAt).toISOString(), finished: new Date().toISOString() };
          await this.app.vault.create(path, `---\n${stringifyYaml(fields)}---\n\n# ${this.t('Focus session')}\n\n${this.t('{minutes} active minutes.', { minutes: elapsed })}\n`);
        }
        this.focus = null;
        try { await this.persist(); } catch (error) { this.focus = session; throw error; }
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
      this.settings.habits.push({ id: uid(), name }); await this.persist(); this.notify();
    });
  }
  async checkHabit(id: string): Promise<void> {
    await this.exclusive(async () => {
      const habit = this.settings.habits.find((item) => item.id === id);
      if (!habit) throw new Error('This habit was archived.');
      const folder = `${this.settings.supportFolder}/Records/Habits`;
      await this.ensureFolder(folder);
      const path = `${folder}/${dayKey()}-${habit.id}.md`;
      if (this.app.vault.getAbstractFileByPath(path)) { new Notice(this.t('Already checked in today.')); return; }
      const fields = { tangrow_kind: 'habit', tangrow_day: dayKey(), tangrow_habit_id: habit.id, tangrow_habit: habit.name, created: new Date().toISOString() };
      await this.app.vault.create(path, `---\n${stringifyYaml(fields)}---\n\n# ${this.t('Habit check-in')}\n\n${habit.name}\n`);
      this.notify();
    });
  }
  async archiveHabit(id: string): Promise<void> {
    await this.exclusive(async () => { this.settings.habits = this.settings.habits.filter((habit) => habit.id !== id); await this.persist(); this.notify(); });
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
    const folders: Array<[keyof Pick<Settings, 'supportFolder' | 'inboxFolder' | 'projectFolder' | 'areaFolder' | 'resourcesFolder' | 'archiveFolder' | 'journalFolder'>, string]> = [
      ['supportFolder', 'Companion folder'], ['inboxFolder', 'Inbox'], ['projectFolder', 'Projects'], ['areaFolder', 'Areas'], ['resourcesFolder', 'Resources'], ['archiveFolder', 'Archive'], ['journalFolder', 'Journal folder']
    ];
    for (const [key, label] of folders) {
      let value = this.plugin.settings[key];
      new Setting(this.containerEl).setName(t(label)).setDesc(t(key === 'supportFolder' ? 'New Bases and focus/habit records only. Changing this path does not move existing files.' : 'Existing vault-relative folder. No files are moved.')).addText((input) => input.setValue(value).onChange((text) => { value = text; })).addButton((button) => button.setButtonText(t('Apply')).onClick(async () => {
        try { this.plugin.settings[key] = safeFolder(value); await this.plugin.saveSettings(); new Notice(t('Path saved. Existing Bases keep their filters: edit them manually or choose a new companion folder and run setup.')); } catch (error) { new Notice(this.plugin.error(error)); }
      }));
    }
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
