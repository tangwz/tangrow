import type { App } from 'obsidian';

export type Locale = 'zh-CN' | 'en';
export type Section = 'tools' | 'capture' | 'pins' | 'studio' | 'focus' | 'habits';
export type NoteKind = 'note' | 'project' | 'draft';
export type ActionId = 'copy-link' | 'copy-path' | 'file-location' | 'fold' | 'unfold' | 'page-width' | 'all-width' | 'refresh' | 'cover' | 'timestamp' | 'toggle-pin' | 'settings' | 'appearance' | 'file-list' | 'stack-tabs' | 'hide-panel' | 'random-note' | 'daily-note';
export type BaseId = 'notes' | 'recent' | 'projects' | 'areas' | 'resources' | 'inbox' | 'sources' | 'captures' | 'pins' | 'drafts' | 'focus' | 'habits' | 'tasks';

export interface Habit { id: string; name: string }
export interface Settings {
  language: Locale;
  supportFolder: string;
  inboxFolder: string;
  projectFolder: string;
  areaFolder: string;
  resourcesFolder: string;
  archiveFolder: string;
  journalFolder: string;
  journalFormat: string;
  focusMinutes: number;
  autoOpen: boolean;
  wideByDefault: boolean;
  habits: Habit[];
}
export const DEFAULT_SETTINGS: Settings = {
  language: 'zh-CN',
  supportFolder: '10-Life(Meta)/Tangrow',
  inboxFolder: '00-Inbox',
  projectFolder: '20-Project',
  areaFolder: '30-Area',
  resourcesFolder: '40-Resources',
  archiveFolder: '90-Archive',
  journalFolder: '10-Life(Meta)/13-Journal',
  journalFormat: 'YYYY/[Daily]/YYYY-MM-DD',
  focusMinutes: 25,
  autoOpen: true,
  wideByDefault: false,
  habits: []
};
export interface NoteSummary { path: string; name: string; folder: string; modified: number; kind?: string; status?: string }
export interface TaskSummary { path: string; line: number; text: string; done: boolean }
export interface FocusSession {
  id: string;
  startedAt: number;
  durationMs: number;
  remainingMs: number;
  endsAt: number | null;
  filePath: string | null;
}
export interface HabitSummary extends Habit { completedToday: boolean; streak: number; days: boolean[] }
export interface Snapshot {
  active: NoteSummary | null;
  activePinned: boolean;
  counts: { notes: number; projects: number; captures: number; drafts: number; focusMinutes: number; tasks: number };
  recent: NoteSummary[];
  pins: NoteSummary[];
  captures: NoteSummary[];
  drafts: NoteSummary[];
  tasks: TaskSummary[];
  habits: HabitSummary[];
  focus: FocusSession | null;
  focusRemainingMs: number;
  supportReady: boolean;
  widePage: boolean;
}
export interface SidebarHost {
  app: App;
  settings: Settings;
  snapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  action(id: ActionId): Promise<void>;
  openNote(path: string, line?: number): Promise<void>;
  openBase(id: BaseId): Promise<void>;
  createNote(kind: NoteKind, title: string): Promise<void>;
  capture(text: string): Promise<void>;
  saveDraft(text: string, title: string): Promise<void>;
  setup(): Promise<void>;
  startFocus(minutes: number): Promise<void>;
  pauseFocus(): Promise<void>;
  resumeFocus(): Promise<void>;
  finishFocus(): Promise<void>;
  cancelFocus(): Promise<void>;
  addHabit(name: string): Promise<void>;
  checkHabit(id: string): Promise<void>;
  archiveHabit(id: string): Promise<void>;
  loadScratch(): string;
  saveScratch(value: string): void;
}
