import type { Section } from './types';

export type WorkbenchTab = 'today' | 'captures' | 'knowledge' | 'projects' | 'more';
export type ProjectTab = 'list' | 'areas' | 'scratchpad' | 'manuscripts';
export type KnowledgeTab = 'materials' | 'cards' | 'hubs' | 'review';
export type MoreTab = 'pins' | 'focus' | 'habits' | 'tools' | 'databases' | 'assistant';
export type WorkbenchEntry = WorkbenchTab | Section | 'compose' | 'record/journal' | 'write/manuscripts' | 'more/assistant';

export type WorkbenchDestination =
  | { tab: 'projects'; page?: ProjectTab }
  | { tab: 'more'; page?: MoreTab }
  | { tab: 'today'; focus?: 'journal' }
  | { tab: 'captures' | 'knowledge' };

export function workbenchDestination(entry: WorkbenchEntry): WorkbenchDestination {
  switch (entry) {
    case 'tools': return { tab: 'today' };
    case 'capture':
    case 'compose': return { tab: 'captures' };
    case 'studio': return { tab: 'projects', page: 'scratchpad' };
    case 'record/journal': return { tab: 'today', focus: 'journal' };
    case 'write/manuscripts': return { tab: 'projects', page: 'manuscripts' };
    case 'ai':
    case 'more/assistant': return { tab: 'more', page: 'assistant' };
    case 'pins':
    case 'focus':
    case 'habits': return { tab: 'more', page: entry };
    default: return { tab: entry };
  }
}
