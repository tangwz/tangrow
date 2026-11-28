import { translate } from '../i18n';
import { JOURNAL_LABELS, JOURNAL_PERIODS } from '../periodic-notes';
import type { Locale } from '../types';

export const GROUPS = {
  general: 'General',
  workbench: 'Workbench',
  data: 'Data and help'
} as const;

type Group = keyof typeof GROUPS;

export const SECTIONS = {
  activation: { group: 'general', name: 'Activation and updates', description: 'Trial, redemption code, devices, and plugin version.' },
  defaults: { group: 'general', name: 'Language and startup', description: 'Interface language and opening the workbench on startup.' },
  folders: { group: 'workbench', name: 'Vault structure', description: 'PARA folders, cards, and the task overview note.' },
  periodic: { group: 'workbench', name: 'Periodic notes', description: 'Journal folder, formats and templates for all five periods.' },
  sidebar: { group: 'workbench', name: 'Sidebar modules', description: 'Knowledge, default focus duration, and note width.' },
  ai: { group: 'workbench', name: 'AI', description: 'Organizing engine preferences and instant suggestions.' },
  reports: { group: 'data', name: 'Report settings', description: 'Editing activity, daily targets, and exclusions.' },
  maintenance: { group: 'data', name: 'Maintenance', description: 'Companion Bases, folder migration, and the agent guide.' },
  guide: { group: 'data', name: 'Guide and purchase', description: 'The user guide, purchase channels, and changing devices.' }
} as const satisfies Record<string, { group: Group; name: string; description: string }>;

export type SectionId = keyof typeof SECTIONS;
export const SECTION_IDS = Object.keys(SECTIONS) as SectionId[];
export const TEMPLATES = 'Periodic note templates';
export const AI_SUGGESTIONS = 'Instant suggestions';
export const PERIODIC_NOTES = 'Periodic notes';
const folderDescription = 'Existing vault-relative folder. No files are moved.';
const formatDescription = 'Moment format, including literal folder names in brackets.';
const templateDescription = 'Optional Markdown path. Supports {{title}}, {{date}}, {{start}}, {{end}}, {{period}}, {{year}}, {{week}} and {{quarter}}. Existing notes are preserved.';

export interface SettingItem {
  id: string;
  section: SectionId;
  name: string;
  description: string;
  group?: string;
}

export const ITEMS: readonly SettingItem[] = [
  { id: 'language', section: 'defaults', name: 'Interface language', description: 'Chinese is the default. Change the language without renaming notes or database files.' },
  { id: 'autoOpen', section: 'defaults', name: 'Open companion on startup', description: '' },
  { id: 'journalFolder', section: 'periodic', name: 'Journal folder', description: folderDescription, group: PERIODIC_NOTES },
  ...JOURNAL_PERIODS.map((period): SettingItem => ({
    id: `format-${period}`, section: 'periodic', name: `${JOURNAL_LABELS[period]} format`, description: formatDescription, group: PERIODIC_NOTES
  })),
  ...JOURNAL_PERIODS.map((period): SettingItem => ({
    id: `template-${period}`, section: 'periodic', name: `${JOURNAL_LABELS[period]} template`, description: templateDescription, group: TEMPLATES
  })),
  { id: 'inboxFolder', section: 'folders', name: 'Inbox', description: folderDescription },
  { id: 'projectFolder', section: 'folders', name: 'Projects', description: folderDescription },
  { id: 'areaFolder', section: 'folders', name: 'Areas', description: folderDescription },
  { id: 'resourcesFolder', section: 'folders', name: 'Resources', description: folderDescription },
  { id: 'archiveFolder', section: 'folders', name: 'Archive', description: folderDescription },
  { id: 'cardFolder', section: 'folders', name: 'Card folder', description: folderDescription },
  { id: 'supportFolder', section: 'folders', name: 'Companion folder', description: 'New Bases and focus/habit records only. Changing this path does not move existing files.' },
  { id: 'taskOverviewPath', section: 'folders', name: 'Task overview note', description: 'Existing Tasks note path. Tangrow opens it without changing its queries.' },
  { id: 'focusMinutes', section: 'sidebar', name: 'Default focus duration', description: 'Minutes, from 1 to 240.' },
  { id: 'prepareDailyReview', section: 'ai', name: 'Prepare the daily review', description: 'Remember your choice for when the organizing engine is available.' },
  { id: 'showComingSoon', section: 'ai', name: 'Show “Coming soon” hints', description: 'Show upcoming organizing features in the workbench.' },
  { id: 'aiEnabled', section: 'ai', name: 'Enable instant suggestions', description: 'Off by default. When on, quick add and capture processing send the text you are sorting to the Claude API with your own key, and only when you press an AI button. Vault workflows run in Claudian and do not use this key.', group: AI_SUGGESTIONS },
  { id: 'aiModel', section: 'ai', name: 'Model', description: 'Choose a preset or enter a custom Claude model ID.', group: AI_SUGGESTIONS },
  { id: 'aiApiKey', section: 'ai', name: 'Anthropic API key', description: 'Save, replace, or remove the key used for AI suggestions.', group: AI_SUGGESTIONS },
  { id: 'claudian', section: 'ai', name: 'Claudian status', description: 'Run Claudian workflows from the workbench.' },
  { id: 'wideByDefault', section: 'sidebar', name: 'Widen notes by default', description: 'Apply the default width and clear per-note width overrides.' },
  { id: 'knowledgeEnabled', section: 'sidebar', name: 'Enable knowledge features', description: 'Show knowledge navigation, card review, and card reports.' },
  { id: 'trackEditingActivity', section: 'reports', name: 'Enable local editing activity', description: 'Only editing event times are counted. Note text and keyboard contents are not stored.' },
  { id: 'activityGoalMinutes', section: 'reports', name: 'Daily activity target', description: 'Use an activity goal from 1 to 1440 whole minutes.' },
  { id: 'reportExcludedFolders', section: 'reports', name: 'Excluded folders, one per line', description: 'Use at most 100 relative folder exclusions.' },
  { id: 'setup', section: 'maintenance', name: 'Set up companion Bases', description: 'Create missing files only. Existing Bases and notes are never overwritten.' },
  { id: 'migration', section: 'maintenance', name: 'Move companion folder', description: 'Move the current companion folder to 99-Tangrow at the vault root. Existing destinations are never merged; customized files are preserved.' },
  { id: 'agentGuide', section: 'maintenance', name: 'Agent guide', description: 'Creates AGENTS.md in the companion folder: a plain description of your folders and Tangrow properties for Claudian and other agents. An existing file is opened, not overwritten.' },
  { id: 'redemption', section: 'activation', name: 'Redemption code', description: 'Enter your code to activate this device online.' },
  { id: 'trial', section: 'activation', name: 'Start 24-hour trial', description: 'The trial begins when you select this button.' },
  { id: 'entitlement', section: 'activation', name: 'This device’s access', description: 'See the current activation or trial status.' },
  { id: 'devices', section: 'activation', name: 'Linked devices', description: 'View device slots or release this device.' },
  { id: 'version', section: 'activation', name: 'Check for updates', description: 'Open the latest releases on GitHub.' },
  { id: 'tutorial', section: 'guide', name: 'Read the Tangrow guide on GitHub', description: 'Find installation and usage instructions.' },
  { id: 'lifetime', section: 'guide', name: 'Lifetime purchase', description: 'One purchase includes free updates to local features. Anthropic API fees and Claudian are separate.' },
  { id: 'channels', section: 'guide', name: 'Purchase channels', description: 'Purchase from the Xiaohongshu or Douyin store. Contact the seller through your order for support.' },
  { id: 'requirements', section: 'guide', name: 'Device limit and internet access', description: 'A code covers up to 3 devices. Go online to activate and at least once every 30 days to renew.' },
  { id: 'replacement', section: 'guide', name: 'Changing devices', description: 'Release an old device, wait 45 days after its last renewal, or contact the seller. Reinstalling or clearing local data may reset your trial and cause reactivation to use a new slot.' }
];

export function searchSettings(query: string, locale: Locale): SettingItem[] {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  // English and Simplified Chinese are searchable from either interface language.
  const languages = new Set<Locale>([locale, 'en', 'zh-CN']);
  const texts = (sources: string[]) => [...languages].flatMap((language) =>
    sources.map((source) => translate(language, source).toLowerCase()));
  return ITEMS.flatMap((item) => {
    const section = SECTIONS[item.section];
    const names = texts([item.name]);
    const context = [item.description, section.name, GROUPS[section.group], item.group ?? ''];
    const rank = names.some((name) => name.startsWith(term)) ? 0
      : names.some((name) => name.includes(term)) ? 1
      : texts(context).some((value) => value.includes(term)) ? 2 : -1;
    return rank < 0 ? [] : [{ item, rank }];
  }).sort((a, b) => a.rank - b.rank).map(({ item }) => item);
}
