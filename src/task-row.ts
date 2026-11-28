import { taskDueLabel, type TaskDisplay } from './task-display';
import type { Locale } from './types';
import { icon, type SidebarUI } from './ui';

interface TaskMetadataOptions {
  source?: string;
  resolveLink?: (wiki: string) => { text: string; iconName?: string } | undefined;
}

function wikiLabel(wiki: string): string {
  const [path, alias] = wiki.replace(/^\[\[|\]\]$/g, '').split('|', 2);
  return alias?.trim() || path?.split('/').at(-1)?.replace(/\.md(?=#|$)/i, '').trim() || wiki;
}

export function renderTaskMetadata(
  ui: SidebarUI, button: HTMLButtonElement, display: TaskDisplay, today: Date, language: Locale, options: TaskMetadataOptions = {}
): void {
  const items: Array<{ text: string; iconName?: string; cls?: string; accessibleText?: string }> = [];
  if (display.due) {
    const due = taskDueLabel(display.due, today, language);
    items.push({ text: due.text, iconName: 'calendar-days', cls: due.overdue ? 'is-overdue' : undefined });
  }
  if (display.priority === 'highest') {
    items.push({ text: ui.t('Highest'), iconName: 'flag', cls: 'is-highest', accessibleText: ui.t('Highest priority') });
  }
  if (display.priority === 'high') {
    items.push({ text: ui.t('High'), iconName: 'flag', accessibleText: ui.t('High priority') });
  }
  if (display.recurrence !== null) {
    items.push({ text: ui.t(display.recurrence.toLowerCase() === 'every week' ? 'Weekly' : 'Repeats'), iconName: 'repeat' });
  }
  for (const wiki of display.links) {
    const link = options.resolveLink?.(wiki);
    items.push({ text: link?.text ?? wikiLabel(wiki), iconName: link?.iconName ?? 'link' });
  }
  for (const tag of display.tags) items.push({ text: tag });
  if (options.source) items.push({ text: options.source });
  if (!items.length) return;
  const meta = button.createSpan({ cls: 'tangrow-task-meta' });
  for (const { text, iconName, cls } of items) {
    const item = meta.createSpan({ cls });
    if (iconName) icon(item, iconName).setAttribute('aria-hidden', 'true');
    item.createSpan({ text });
  }
  const label = button.getAttribute('aria-label') ?? display.title;
  button.setAttribute('aria-label', [label, ...items.map((item) => item.accessibleText ?? item.text)].join(', '));
}
