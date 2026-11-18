import type { Section } from './types';

export type WorkbenchTab = 'today' | 'compose' | 'knowledge' | 'ai' | 'more';
export type ComposeTab = 'captures' | 'journal' | 'scratchpad' | 'manuscripts';
export type KnowledgeTab = 'materials' | 'cards' | 'hubs' | 'review';
export type MoreTab = 'pins' | 'focus' | 'habits' | 'tools' | 'databases';
export type WorkbenchEntry = WorkbenchTab | Section | 'record/journal' | 'write/manuscripts' | 'more/assistant';

export type WorkbenchDestination =
  | { tab: 'compose'; page?: ComposeTab }
  | { tab: 'more'; page?: MoreTab }
  | { tab: 'today' | 'knowledge' | 'ai' };

export function workbenchDestination(entry: WorkbenchEntry): WorkbenchDestination {
  switch (entry) {
    case 'tools': return { tab: 'today' };
    case 'capture': return { tab: 'compose', page: 'captures' };
    case 'studio': return { tab: 'compose', page: 'scratchpad' };
    case 'record/journal': return { tab: 'compose', page: 'journal' };
    case 'write/manuscripts': return { tab: 'compose', page: 'manuscripts' };
    case 'more/assistant': return { tab: 'ai' };
    case 'pins':
    case 'focus':
    case 'habits': return { tab: 'more', page: entry };
    default: return { tab: entry };
  }
}
