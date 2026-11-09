import type { ActivitySummary, EditingActivityState } from './activity';

export type ReportRange = 1 | 7 | 30 | 60 | 90 | 180 | 365;
export type ReportPage = 'overview' | 'actions' | 'tasks' | 'projects' | 'notes' | 'clips' | 'areas' | 'time';
export type ReportStatus = 'open' | 'done' | 'archived' | 'unknown';

export interface ReportPreferences {
  reportExcludedFolders: string[];
  trackEditingActivity: boolean;
  activityGoalMinutes: number;
}

export interface ReportTask {
  path: string;
  name: string;
  line: number;
  text: string;
  status: string;
}

export interface ReportRecord {
  path: string;
  name: string;
  created: number;
  modified: number;
  frontmatter?: Record<string, unknown>;
  tasks?: string[];
  taskItems?: ReportTask[];
  wordCount?: number;
  characterCount?: number;
  links?: string[];
  tags?: string[];
}

export interface ReportEntity {
  path: string;
  name: string;
  notePath: string | null;
  noteCount: number;
  created: number | null;
  status: ReportStatus;
}

export interface CompletionSummary {
  open: number;
  done: number;
  archived: number;
  unknown: number;
  cancelled: number;
  total: number;
  denominator: number;
  rate: number | null;
}

export interface StreakSummary {
  current: number;
  longest: number;
  days: Array<{ day: string; count: number }>;
}

export interface DailyTrend {
  day: string;
  notes: number;
  tasks: number;
  projects: number;
  captures: number;
  clips: number;
}

export interface ReportData {
  counts: {
    notes: number;
    projectNotes: number;
    areaNotes: number;
    resourceNotes: number;
    sourceNotes: number;
    captures: number;
    pins: number;
    drafts: number;
    openTasks: number;
    completedTasks: number;
    cancelledTasks: number;
    focusMinutes: number;
    habitCheckinsToday: number;
    tasks: number;
    projects: number;
    areas: number;
    clips: number;
    words: number;
    characters: number;
    orphans: number;
  };
  days: Array<{ day: string; count: number }>;
  recent: ReportRecord[];
  notes: ReportRecord[];
  projects: ReportEntity[];
  areas: ReportEntity[];
  clips: ReportRecord[];
  taskItems: ReportTask[];
  orphanNotes: ReportRecord[];
  trends: DailyTrend[];
  gains90: { notes: number; projects: number; areas: number; clips: number; captures: number };
  completion: { tasks: CompletionSummary; projects: CompletionSummary; areas: CompletionSummary; clips: CompletionSummary };
  streaks: { journal: StreakSummary; captures: StreakSummary };
  habits: {
    todayCompleted: number;
    target: number;
    days: Array<{ day: string; completed: number; target: number }>;
  };
}

export interface AggregateReportOptions {
  range?: ReportRange;
  folders?: readonly string[];
}

export interface ReportSnapshot {
  data: ReportData;
  records: ReportRecord[];
  activity: ActivitySummary;
  generatedAt: number;
  quality: { unreadable: number; linksReady: boolean };
}

export interface ReportState {
  activity: EditingActivityState;
}
