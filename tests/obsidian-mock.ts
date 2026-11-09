export const notices: string[] = [];
export const Platform = { isDesktopApp: true };

class MockEvents {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  on = (name: string, callback: (...args: unknown[]) => void): object => {
    const callbacks = this.listeners.get(name) ?? new Set<(...args: unknown[]) => void>();
    callbacks.add(callback);
    this.listeners.set(name, callbacks);
    return { name, callback };
  };
  trigger = (name: string, ...args: unknown[]): void => {
    for (const callback of this.listeners.get(name) ?? []) callback(...args);
  };
}

export class TFolder {
  name: string;
  parent: TFolder | null = null;
  constructor(public path: string) { this.name = path.split('/').at(-1) ?? ''; }
}

export class TFile {
  name: string;
  basename: string;
  extension: string;
  parent: TFolder | null = null;
  stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
  constructor(public path: string, public content = '') {
    this.name = path.split('/').at(-1) ?? '';
    const dot = this.name.lastIndexOf('.');
    this.basename = dot < 0 ? this.name : this.name.slice(0, dot);
    this.extension = dot < 0 ? '' : this.name.slice(dot + 1);
    this.stat.size = content.length;
  }
}

export function stringifyYaml(value: Record<string, unknown>): string {
  return Object.entries(value).map(([key, item]) => `${key}: ${JSON.stringify(item)}\n`).join('');
}

export function parseYaml(content: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  for (const line of content.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    const raw = match[2] ?? '';
    try { parsed[match[1]] = JSON.parse(raw); }
    catch { parsed[match[1]] = raw; }
  }
  return parsed;
}

export class MockVault {
  private events = new MockEvents();
  entries = new Map<string, TFile | TFolder>();
  createdPaths: string[] = [];
  processedPaths: string[] = [];
  failCreates = 0;
  getMarkdownFilesCalls = 0;

  seedFolder(path: string): TFolder {
    const existing = this.entries.get(path);
    if (existing instanceof TFolder) return existing;
    if (existing) throw new Error(`Occupied: ${path}`);
    const folder = new TFolder(path);
    const slash = path.lastIndexOf('/');
    folder.parent = slash < 0 ? null : this.seedFolder(path.slice(0, slash));
    this.entries.set(path, folder);
    return folder;
  }
  seedFile(path: string, content: string): TFile {
    if (this.entries.has(path)) throw new Error(`Occupied: ${path}`);
    const file = new TFile(path, content);
    const slash = path.lastIndexOf('/');
    file.parent = slash < 0 ? null : this.seedFolder(path.slice(0, slash));
    this.entries.set(path, file);
    return file;
  }
  getAbstractFileByPath(path: string): TFile | TFolder | null { return this.entries.get(path) ?? null; }
  getMarkdownFiles(): TFile[] { this.getMarkdownFilesCalls++; return [...this.entries.values()].filter((file): file is TFile => file instanceof TFile && file.extension === 'md'); }
  getFiles(): TFile[] { return [...this.entries.values()].filter((file): file is TFile => file instanceof TFile); }
  getAllFolders(): TFolder[] { return [...this.entries.values()].filter((entry): entry is TFolder => entry instanceof TFolder); }
  async createFolder(path: string): Promise<void> {
    if (this.entries.has(path)) throw new Error(`Occupied: ${path}`);
    this.seedFolder(path);
    this.createdPaths.push(path);
  }
  async create(path: string, content: string): Promise<TFile> {
    if (this.failCreates > 0) { this.failCreates--; throw new Error('Simulated vault write failure'); }
    const file = this.seedFile(path, content);
    this.createdPaths.push(path);
    return file;
  }
  async cachedRead(file: TFile): Promise<string> { return file.content; }
  async read(file: TFile): Promise<string> { return file.content; }
  async process(file: TFile, transform: (content: string) => string): Promise<string> {
    if (this.entries.get(file.path) !== file) throw new Error('The file no longer exists in this vault.');
    this.processedPaths.push(file.path);
    const next = transform(file.content);
    if (next !== file.content) {
      file.content = next;
      file.stat.mtime++;
      file.stat.size = next.length;
    }
    return next;
  }
  async rename(entry: TFile | TFolder, path: string): Promise<void> {
    const oldPath = entry.path;
    const changed = [...this.entries.values()].filter((item) => item.path === oldPath || item.path.startsWith(`${oldPath}/`));
    for (const item of changed) this.entries.delete(item.path);
    for (const item of changed) {
      item.path = path + item.path.slice(oldPath.length);
      item.name = item.path.split('/').at(-1) ?? '';
      if (item instanceof TFile) {
        const dot = item.name.lastIndexOf('.');
        item.basename = dot < 0 ? item.name : item.name.slice(0, dot);
        item.extension = dot < 0 ? '' : item.name.slice(dot + 1);
      }
      this.entries.set(item.path, item);
    }
    for (const item of changed) {
      const slash = item.path.lastIndexOf('/');
      item.parent = slash < 0 ? null : this.seedFolder(item.path.slice(0, slash));
    }
    this.trigger('rename', entry, oldPath);
  }
  async delete(entry: TFile | TFolder): Promise<void> {
    for (const path of [...this.entries.keys()]) {
      if (path === entry.path || path.startsWith(`${entry.path}/`)) this.entries.delete(path);
    }
    this.trigger('delete', entry);
  }
  on = this.events.on;
  trigger = this.events.trigger;
}

interface MockNavigationLeaf {
  view: { getViewType(): string };
  openFile(file: TFile): Promise<void>;
}

export function createMockApp() {
  const vault = new MockVault();
  let activeFile: TFile | null = null;
  let activeView: MarkdownView | null = null;
  let mostRecentLeaf: { view: MockView } | null = null;
  let mostRecentRootLeaf: { view: MockView } | null = null;
  const rootLeaves: { view: MockView }[] = [];
  const rootSplit = { kind: 'root' };
  const requestedRoots: unknown[] = [];
  const activationRequests: { leaf: { view: MockView }; options: unknown }[] = [];
  const locatedFiles: string[] = [];
  const workspaceEvents = new MockEvents();
  const cacheEvents = new MockEvents();
  const layoutCallbacks: (() => void)[] = [];
  const lastOpenFiles: string[] = [];
  const navigationRequests: ('tab' | boolean | undefined)[] = [];
  const rootOpenedFiles: string[] = [];
  let navigationLeaf: MockNavigationLeaf | null = null;
  const rootFileView = new FileView();
  const rootFileLeaf: MockNavigationLeaf = {
    view: rootFileView,
    openFile: async (file) => {
      activeFile = file;
      activeView = null;
      rootFileView.file = file;
      mostRecentLeaf = { view: rootFileView };
      mostRecentRootLeaf = mostRecentLeaf;
      rootOpenedFiles.push(file.path);
      workspaceEvents.trigger('file-open', file);
    }
  };
  const workspace = {
    rootLeaves,
    rootSplit,
    requestedRoots,
    activationRequests,
    locatedFiles,
    lastOpenFiles,
    navigationRequests,
    rootOpenedFiles,
    setNavigationLeaf: (leaf: MockNavigationLeaf | null): void => { navigationLeaf = leaf; },
    getLastOpenFiles: (): string[] => [...lastOpenFiles],
    getActiveFile: (): TFile | null => activeFile,
    setActiveFile: (file: TFile | null): void => {
      activeFile = file;
      activeView = null;
      const view = new FileView();
      view.file = file;
      mostRecentLeaf = file ? { view } : null;
      mostRecentRootLeaf = mostRecentLeaf;
    },
    setActiveView: (view: MarkdownView | null): void => {
      activeView = view;
      if (view?.file) { activeFile = view.file; mostRecentLeaf = { view }; mostRecentRootLeaf = mostRecentLeaf; }
    },
    setMostRecentLeaf: (leaf: { view: MockView } | null): void => { mostRecentLeaf = leaf; },
    setMostRecentRootLeaf: (leaf: { view: MockView } | null): void => { mostRecentRootLeaf = leaf; },
    getActiveViewOfType: (): MarkdownView | null => activeView,
    getMostRecentLeaf: (root?: unknown): { view: MockView } | null => {
      requestedRoots.push(root);
      return root === rootSplit ? mostRecentRootLeaf : mostRecentLeaf;
    },
    setActiveLeaf: (leaf: { view: MockView }, options: unknown): void => {
      activationRequests.push({ leaf, options });
      mostRecentLeaf = leaf;
      activeView = leaf.view instanceof MarkdownView ? leaf.view : null;
      if (leaf.view instanceof FileView) activeFile = leaf.view.file;
    },
    iterateAllLeaves: (callback: (leaf: { view: MockView }) => void): void => { rootLeaves.forEach(callback); },
    iterateRootLeaves: (callback: (leaf: { view: MockView }) => void): void => { rootLeaves.forEach(callback); },
    getLeaf: (newLeaf?: 'tab' | boolean): MockNavigationLeaf => {
      navigationRequests.push(newLeaf);
      return newLeaf === 'tab' || newLeaf === true ? rootFileLeaf : navigationLeaf ?? rootFileLeaf;
    },
    ensureSideLeaf: async () => ({ view: { revealInFolder: async (file: TFile): Promise<void> => { locatedFiles.push(file.path); } } }),
    getLeavesOfType: (): never[] => [],
    on: workspaceEvents.on,
    trigger: workspaceEvents.trigger,
    onLayoutReady: (callback: () => void): void => { layoutCallbacks.push(callback); },
    emitLayoutReady: (): void => { layoutCallbacks.splice(0).forEach((callback) => callback()); }
  };
  const metadataCache = {
    getFileCache: (file: TFile) => {
      const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(file.content)?.[1];
      const listItems = file.content.split(/\r?\n/).flatMap((line, index) => {
        const task = /^\s*(?:[-*+]|\d+[.)])\s+\[([^\]])\]/.exec(line)?.[1];
        return task === undefined ? [] : [{ task, position: { start: { line: index } } }];
      });
      return { frontmatter: frontmatter ? parseYaml(frontmatter) : undefined, listItems };
    },
    on: cacheEvents.on,
    trigger: cacheEvents.trigger
  };
  const fileManager = {
    generateMarkdownLink: (file: TFile): string => `[[${file.path}]]`,
    renameFile: (file: TFile | TFolder, path: string): Promise<void> => vault.rename(file, path)
  };
  return { vault, workspace, metadataCache, fileManager };
}
export type MockApp = ReturnType<typeof createMockApp>;

export class Plugin {
  manifest = { id: 'tangrow' };
  saveFailures = 0;
  savedData: unknown = null;
  saveCalls = 0;
  constructor(public app: MockApp) {}
  async saveData(data: unknown): Promise<void> {
    this.saveCalls++;
    if (this.saveFailures > 0) { this.saveFailures--; throw new Error('Simulated settings write failure'); }
    this.savedData = structuredClone(data);
  }
  async loadData(): Promise<unknown> { return this.savedData; }
  registerView(): void {}
  addRibbonIcon(): null { return null; }
  addCommand(): void {}
  removeCommand(): void {}
  addSettingTab(): void {}
  registerEvent(): void {}
  registerMarkdownPostProcessor(): void {}
  registerInterval(): void {}
}

export class Notice {
  constructor(text: string) { notices.push(text); }
}
export class Modal {}
export class MockView {
  containerEl = { toggleClass: (): void => {}, removeClass: (): void => {} };
  getViewType(): string { return 'unknown'; }
}
export class ItemView extends MockView {}
export class FileView extends MockView {
  file: TFile | null = null;
  getViewType(): string { return 'file'; }
}
export class PluginSettingTab {}
export class Setting {}
interface EditorPosition { line: number; ch: number }
interface EditorSelection { anchor: EditorPosition; head: EditorPosition }

export class MockEditor {
  private content = '';
  inserted: string[] = [];
  commands: string[] = [];
  replacements: { text: string; from: EditorPosition; to: EditorPosition }[] = [];
  private selections: EditorSelection[] = [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }];
  getValue(): string { return this.content; }
  setValue(content: string): void { this.content = content; }
  listSelections(): EditorSelection[] { return structuredClone(this.selections); }
  setSelections(selections: EditorSelection[]): void { this.selections = structuredClone(selections); }
  posToOffset(position: EditorPosition): number {
    const lines = this.content.split('\n');
    return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.ch;
  }
  offsetToPos(offset: number): EditorPosition {
    const prefix = this.content.slice(0, offset).split('\n');
    return { line: prefix.length - 1, ch: prefix.at(-1)?.length ?? 0 };
  }
  replaceRange(text: string, from: EditorPosition, to: EditorPosition = from): void {
    const start = this.posToOffset(from);
    const end = this.posToOffset(to);
    this.replacements.push({ text, from: structuredClone(from), to: structuredClone(to) });
    this.content = this.content.slice(0, start) + text + this.content.slice(end);
  }
  replaceSelection(text: string): void {
    this.inserted.push(text);
    const selection = this.selections[0]!;
    this.replaceRange(text, selection.anchor, selection.head);
  }
  exec(command: string): void { this.commands.push(command); }
}

export class MarkdownView extends FileView {
  editor = new MockEditor();
  inserted = this.editor.inserted;
  commands = this.editor.commands;
  getViewType(): string { return 'markdown'; }
}
export function setIcon(): void {}
export function normalizePath(path: string): string { return path.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, ''); }
export function moment(input?: string | number | Date): { format(pattern: string): string } {
  const date = input === undefined ? new Date(Date.now()) : new Date(input);
  const parts: Record<string, string> = {
    YYYY: String(date.getFullYear()), MM: String(date.getMonth() + 1).padStart(2, '0'), DD: String(date.getDate()).padStart(2, '0'),
    HH: String(date.getHours()).padStart(2, '0'), mm: String(date.getMinutes()).padStart(2, '0'), ss: String(date.getSeconds()).padStart(2, '0'), Z: '+00:00'
  };
  return { format: (pattern) => pattern.replace(/\[[^\]]*\]|YYYY|MM|DD|HH|mm|ss|Z/g, (token) => token.startsWith('[') ? token.slice(1, -1) : parts[token]!) };
}
export function setTooltip(): void {}
export function getFrontMatterInfo(content: string): { exists: boolean; frontmatter: string; from: number; to: number; contentStart: number } {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  return { exists: !!match, frontmatter: match?.[1] ?? '', from: 0, to: match?.[0].length ?? 0, contentStart: match?.[0].length ?? 0 };
}
