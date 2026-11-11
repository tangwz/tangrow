const OPEN_TASK = /^(\s*(?:[-*+]|\d+[.)])\s+\[)[ /](\]\s+)/;

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
  if (line === undefined || !OPEN_TASK.test(line) || (label !== undefined && !line.includes(label))) {
    throw new Error('This task changed in its note. Open the note to review it.');
  }
  lines[lineIndex] = line.replace(OPEN_TASK, '$1x$2');
  return lines.join('\n');
}

/** Reads checkbox or bullet lines from generated text so they can be saved as tasks. */
export function extractTasks(text: string): string[] {
  const tasks: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX/-]\]\s+)?(.+)$/.exec(line);
    const value = match?.[1]?.trim();
    if (!value || value.length > 240 || tasks.includes(value)) continue;
    tasks.push(value);
    if (tasks.length === 20) break;
  }
  return tasks;
}
