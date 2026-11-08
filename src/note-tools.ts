export function stampHeadingDate(content: string, title: string, date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use an ISO calendar date.');
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  let bodyStart = 0;
  if (/^\uFEFF?---\s*$/.test(lines[0] ?? '')) {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end === -1) throw new Error('Close the frontmatter block before adding a heading date.');
    bodyStart = end + 1;
  }
  let fence: { character: string; length: number } | null = null;
  let previousText = -1;
  for (let index = bodyStart; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { character: marker[0]!, length: marker.length };
      else if (marker[0] === fence.character && marker.length >= fence.length && /^ {0,3}(`+|~+)\s*$/.test(line)) fence = null;
      previousText = -1;
      continue;
    }
    if (fence) continue;
    const atx = /^( {0,3}#[ \t]+)(.*?)([ \t]+#+[ \t]*)?$/.exec(line);
    if (atx) {
      if (atx[2]?.includes(date)) return content;
      lines[index] = `${atx[1]}${atx[2]} · ${date}${atx[3] ?? ''}`;
      return lines.join(newline);
    }
    if (/^ {0,3}=+[ \t]*$/.test(line) && previousText === index - 1) {
      const heading = lines[previousText]!;
      if (heading.includes(date)) return content;
      lines[previousText] = `${heading.trimEnd()} · ${date}`;
      return lines.join(newline);
    }
    previousText = line.trim() && !/^( {4}|\t| {0,3}[>#]| {0,3}[-*+]\s)/.test(line) ? index : -1;
  }
  const prefix = lines.slice(0, bodyStart).join(newline);
  const body = lines.slice(bodyStart).join(newline);
  return `${prefix ? `${prefix}${newline}${newline}` : ''}# ${title} · ${date}${newline}${newline}${body}`;
}
