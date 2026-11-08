import type { BaseId, Settings } from './types';

export interface BaseDefinition {
  id: BaseId;
  name: string;
  filename: string;
  description: string;
  content: string;
}

interface BaseSpec {
  id: BaseId;
  name: string;
  description: string;
  filters: string[];
  columns?: string[];
}

const DEFAULT_COLUMNS = ['file.name', 'file.folder', 'file.mtime'];
const PROPERTY_LABELS: Record<string, string> = {
  'file.name': 'Note',
  'file.folder': 'Folder',
  'file.mtime': 'Modified',
  'file.ctime': 'Created',
  'note.source': 'Source',
  'note.tangrow_kind': 'Kind',
  'note.tangrow_status': 'Status',
  'note.tangrow_day': 'Day',
  'note.tangrow_minutes': 'Minutes',
  'note.tangrow_habit': 'Habit',
  'note.tangrow_source': 'Related note',
  'note.tangrow_pin': 'Pinned'
};

// JSON strings are valid YAML scalars and safely preserve nested expression quotes.
function quote(value: string): string {
  return JSON.stringify(value);
}

function inFolder(folder: string): string {
  return `file.inFolder(${quote(folder)})`;
}

function renderBase(spec: BaseSpec): string {
  const columns = spec.columns ?? DEFAULT_COLUMNS;
  const properties = columns.flatMap((column) => [
    `  ${quote(column)}:`,
    `    displayName: ${quote(PROPERTY_LABELS[column] ?? column)}`
  ]);
  return [
    'filters:',
    '  and:',
    ...['file.ext == "md"', ...spec.filters].map((filter) => `    - ${quote(filter)}`),
    'properties:',
    ...properties,
    'views:',
    '  - type: table',
    `    name: ${quote(spec.name)}`,
    '    order:',
    ...columns.map((column) => `      - ${quote(column)}`),
    ''
  ].join('\n');
}

export function baseDefinitions(settings: Settings): BaseDefinition[] {
  const userNotes = `!${inFolder(settings.supportFolder)}`;
  const kind = (value: string): string => `note.tangrow_kind == ${quote(value)}`;
  const specs: BaseSpec[] = [
    {
      id: 'notes', name: 'Notes',
      description: 'All existing Markdown notes, without Tangrow support records.',
      filters: [userNotes]
    },
    {
      id: 'recent', name: 'Recent',
      description: 'Existing notes modified during the last seven days.',
      filters: [userNotes, 'file.mtime > now() - "7d"']
    },
    {
      id: 'projects', name: 'Projects',
      description: 'Notes in the existing project directory; no project taxonomy is imposed.',
      filters: [inFolder(settings.projectFolder), userNotes]
    },
    {
      id: 'areas', name: 'Areas',
      description: 'Notes in the existing area directory.',
      filters: [inFolder(settings.areaFolder), userNotes]
    },
    {
      id: 'resources', name: 'Resources',
      description: 'Notes in the existing resources directory.',
      filters: [inFolder(settings.resourcesFolder), userNotes]
    },
    {
      id: 'inbox', name: 'Inbox',
      description: 'Notes in the existing inbox directory.',
      filters: [inFolder(settings.inboxFolder), userNotes]
    },
    {
      id: 'sources', name: 'Sources',
      description: 'Notes with an existing source property or a Tangrow related-note property.',
      filters: [userNotes, '(note.source != null && note.source != "") || (note.tangrow_source != null && note.tangrow_source != "")'],
      columns: ['file.name', 'note.source', 'note.tangrow_source', 'file.folder', 'file.mtime']
    },
    {
      id: 'captures', name: 'Captures',
      description: 'Quick captures created by Tangrow in the configured inbox.',
      filters: [kind('capture')],
      columns: ['file.name', 'file.ctime', 'note.tangrow_source', 'file.folder']
    },
    {
      id: 'pins', name: 'Pins',
      description: 'Notes explicitly pinned using the Tangrow sidebar.',
      filters: ['note.tangrow_pin == true'],
      columns: ['file.name', 'file.folder', 'file.mtime', 'note.tangrow_pin']
    },
    {
      id: 'drafts', name: 'Drafts',
      description: 'Writing drafts saved from the Tangrow studio.',
      filters: [kind('draft')],
      columns: ['file.name', 'note.tangrow_status', 'file.folder', 'file.mtime']
    },
    {
      id: 'focus', name: 'Focus',
      description: 'Completed focus sessions stored as local Markdown records.',
      filters: [kind('focus')],
      columns: ['file.name', 'note.tangrow_day', 'note.tangrow_minutes', 'note.tangrow_source']
    },
    {
      id: 'habits', name: 'Habits',
      description: 'Daily habit check-ins stored as local Markdown records.',
      filters: [kind('habit')],
      columns: ['file.name', 'note.tangrow_habit', 'note.tangrow_day']
    },
    {
      id: 'tasks', name: 'Task notes',
      description: 'Notes tagged task or explicitly marked tangrow_kind: task. Body checkboxes remain in the sidebar task index and the existing Tasks plugin.',
      filters: [userNotes, '(file.hasTag("task") || note.tangrow_kind == "task")'],
      columns: ['file.name', 'note.tangrow_status', 'file.folder', 'file.mtime']
    }
  ];
  return specs.map((spec) => ({
    id: spec.id,
    name: spec.name,
    filename: `Tangrow ${spec.name}.base`,
    description: spec.description,
    content: renderBase(spec)
  }));
}

export function setupReadme(settings: Settings): string {
  const definitions = baseDefinitions(settings);
  return [
    '# Tangrow',
    '',
    'An additive companion for your existing Obsidian vault. Your notes keep their original locations.',
    '',
    '## Databases',
    '',
    ...definitions.flatMap((definition) => [
      `- [[${definition.filename}|${definition.name}]]: ${definition.description}`
    ]),
    '',
    '## Storage',
    '',
    `- New notes, captures and drafts use the configured inbox: ${settings.inboxFolder}.`,
    `- Project notes use the existing project directory: ${settings.projectFolder}.`,
    `- Bases and generated focus/habit records live beneath: ${settings.supportFolder}.`,
    '- Pins and structured records use tangrow_ properties; existing type/status/source fields are preserved.',
    '- The Tasks plugin and body checkboxes remain independent. The Task notes base indexes whole notes, not individual checkboxes.',
    '- Focus records count elapsed timer time, not keyboard activity. Paused time is excluded.',
    '',
    '## Setup and removal',
    '',
    'Setup only creates missing Tangrow files. Existing files and customized Bases are never overwritten.',
    'Disable Tangrow to remove its sidebar. Existing notes and these plain-text files remain readable without the plugin.',
    '',
    '## Working locally',
    '',
    'Tangrow has no login, analytics, remote requests, or bundled third-party artwork. Obsidian Sync or your configured vault sync may still synchronize vault files.',
    ''
  ].join('\n');
}
