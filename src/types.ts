import type { App } from 'obsidian';
import type { ReportPreferences, ReportRange, ReportSnapshot } from './report-contract';

export type Locale = 'zh-CN' | 'en';
export type Section = 'tools' | 'capture' | 'pins' | 'studio' | 'focus' | 'habits';
export type NoteKind = 'note' | 'project' | 'draft';
export type ActionId = 'copy-link' | 'copy-path' | 'file-location' | 'fold' | 'unfold' | 'page-width' | 'all-width' | 'refresh' | 'cover' | 'timestamp' | 'toggle-pin' | 'settings' | 'appearance' | 'file-list' | 'stack-tabs' | 'hide-panel' | 'random-note' | 'daily-note' | 'report' | 'title-date' | 'toggle-theme' | 'task-overview';
export type BaseId = 'notes' | 'recent' | 'projects' | 'areas' | 'resources' | 'inbox' | 'sources' | 'captures' | 'pins' | 'drafts' | 'focus' | 'habits' | 'tasks';

export interface Habit { id: string; name: string }
export interface Settings extends ReportPreferences {
  language: Locale;
  supportFolder: string;
  inboxFolder: string;
  projectFolder: string;
  areaFolder: string;
  resourcesFolder: string;
  archiveFolder: string;
  journalFolder: string;
  journalFormat: string;
  taskOverviewPath: string;
  focusMinutes: number;
  autoOpen: boolean;
  wideByDefault: boolean;
  habits: Habit[];
}
export const DEFAULT_SETTINGS: Settings = {
  language: 'zh-CN',
  supportFolder: '99-Tangrow',
  inboxFolder: '00-Inbox',
  projectFolder: '20-Project',
  areaFolder: '30-Area',
  resourcesFolder: '40-Resources',
  archiveFolder: '90-Archive',
  journalFolder: '10-Life(Meta)/13-Journal',
  journalFormat: 'YYYY/[Daily]/YYYY-MM-DD',
  taskOverviewPath: '10-Life(Meta)/12-Tasks.md',
  focusMinutes: 25,
  autoOpen: true,
  wideByDefault: false,
  habits: [],
  reportExcludedFolders: [],
  trackEditingActivity: true,
  activityGoalMinutes: 60
};
export interface ComposerState { capture: string; scratchTitle: string }
export interface WritingDraft { text: string; title: string; revision: number; editingView?: string }
export interface NoteSummary { path: string; name: string; folder: string; modified: number; kind?: string; status?: string }
export interface CaptureSummary extends NoteSummary { created: number }
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
  recentOpened: NoteSummary[];
  pins: NoteSummary[];
  captures: CaptureSummary[];
  drafts: NoteSummary[];
  tasks: TaskSummary[];
  habits: HabitSummary[];
  focus: FocusSession | null;
  focusRemainingMs: number;
  supportReady: boolean;
  projectFolders: string[];
  widePage: boolean;
}
export interface SidebarHost {
  app: App;
  settings: Settings;
  snapshot(): Snapshot;
  loadReport(range: ReportRange): Promise<ReportSnapshot>;
  updateReportSettings(patch: Partial<ReportPreferences>): Promise<void>;
  subscribe(listener: () => void): () => void;
  action(id: ActionId): Promise<void>;
  openNote(path: string, line?: number): Promise<void>;
  openBase(id: BaseId): Promise<void>;
  createNote(kind: NoteKind, title: string, projectFolder?: string): Promise<void>;
  capture(text: string): Promise<void>;
  submitCaptureDraft(): Promise<void>;
  openCaptureWindow(): Promise<void>;
  readCapture(path: string): Promise<string>;
  saveDraft(text: string, title: string): Promise<void>;
  loadWritingDraft(): WritingDraft;
  updateWritingDraft(patch: Partial<Pick<WritingDraft, 'text' | 'title'>>, expectedRevision: number, viewId?: string): boolean;
  beginWritingDraftComposition(viewId: string, expectedRevision: number): boolean;
  endWritingDraftComposition(viewId: string): void;
  submitWritingDraft(expectedRevision: number): Promise<void>;
  setup(): Promise<void>;
  startFocus(minutes: number): Promise<void>;
  pauseFocus(): Promise<void>;
  resumeFocus(): Promise<void>;
  finishFocus(): Promise<void>;
  cancelFocus(): Promise<void>;
  addHabit(name: string): Promise<void>;
  checkHabit(id: string): Promise<void>;
  archiveHabit(id: string): Promise<void>;
  loadComposer(): ComposerState;
  saveComposer(patch: Partial<ComposerState>): void;
  subscribeComposer(listener: () => void): () => void;
  loadScratch(): string;
  saveScratch(value: string): void;
}
