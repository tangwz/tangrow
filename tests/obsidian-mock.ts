export const notices: string[] = [];

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
  entries = new Map<string, TFile | TFolder>();
  createdPaths: string[] = [];
  failCreates = 0;

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
  getMarkdownFiles(): TFile[] { return [...this.entries.values()].filter((file): file is TFile => file instanceof TFile && file.extension === 'md'); }
  getFiles(): TFile[] { return [...this.entries.values()].filter((file): file is TFile => file instanceof TFile); }
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
  on(): object { return {}; }
}

export function createMockApp() {
  const vault = new MockVault();
  let activeFile: TFile | null = null;
  const workspace = {
    getActiveFile: (): TFile | null => activeFile,
    iterateAllLeaves: (): void => {},
    iterateRootLeaves: (): void => {},
    getLeaf: () => ({ openFile: async (file: TFile): Promise<void> => { activeFile = file; } }),
    ensureSideLeaf: async (): Promise<void> => {},
    getLeavesOfType: (): never[] => [],
    on: (): object => ({})
  };
  const metadataCache = {
    getFileCache: (file: TFile) => {
      const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(file.content)?.[1];
      return { frontmatter: frontmatter ? parseYaml(frontmatter) : undefined, listItems: [] };
    },
    on: (): object => ({})
  };
  return { vault, workspace, metadataCache };
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
}

export class Notice {
  constructor(text: string) { notices.push(text); }
}
export class Modal {}
export class ItemView {}
export class PluginSettingTab {}
export class Setting {}
export class MarkdownView {}
export function setIcon(): void {}
export function normalizePath(path: string): string { return path.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, ''); }
export function moment(input?: string | number | Date): { format(pattern: string): string } {
  const date = input === undefined ? new Date(Date.now()) : new Date(input);
  return { format: (pattern) => pattern === 'YYYY-MM-DD' ? date.toISOString().slice(0, 10) : date.toISOString() };
}
export function setTooltip(): void {}
export function getFrontMatterInfo(content: string): { exists: boolean; frontmatter: string; from: number; to: number; contentStart: number } {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  return { exists: !!match, frontmatter: match?.[1] ?? '', from: 0, to: match?.[0].length ?? 0, contentStart: match?.[0].length ?? 0 };
}
