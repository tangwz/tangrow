const OPEN_TASK = /^((?: {0,3}>[ \t]?)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)[ /](\](?:[ \t]+(.*))?)$/;

/** Uses the same syntax for indexed labels and guarded checkbox edits, including quoted lists. */
export function openTaskLabel(line: string): string | null {
  const match = OPEN_TASK.exec(line.replace(/\r$/, ''));
  return match ? match[3] ?? '' : null;
}

export function taskText(value: string): string {
  const text = value.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (!text || text.length > 240) throw new Error('Use a task of 1-240 characters.');
  return text;
}

export function taskLine(value: string, due?: string): string {
  const text = taskText(value);
  if (due !== undefined && due !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Use an ISO calendar date.');
  return `- [ ] ${text}${due ? ` 📅 ${due}` : ''}`;
}

export function appendTaskLine(content: string, line: string): string {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  if (!content) return `${line}${newline}`;
  return `${content}${content.endsWith('\n') ? '' : newline}${line}${newline}`;
}

/** Marks one open checkbox done. The label guards against the note changing since it was indexed. */
export function completeTaskLine(content: string, lineIndex: number, label?: string): string {
  const lines = content.split('\n');
  const line = lines[lineIndex];
  const match = line === undefined ? null : OPEN_TASK.exec(line.replace(/\r$/, ''));
  if (!match || (label !== undefined && (match[3] ?? '') !== label)) {
    throw new Error('This task changed in its note. Open the note to review it.');
  }
  lines[lineIndex] = `${match[1]}x${match[2]}${line!.endsWith('\r') ? '\r' : ''}`;
  return lines.join('\n');
}
