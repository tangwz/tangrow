interface Destination { start: number; end: number; after: number }
type ResolveLink = (linkpath: string, sourcePath: string) => string | null;

function pathSegments(path: string): string[] {
  return path.split('/').map((segment) => encodeURIComponent(segment)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`));
}

function destinationAt(text: string, offset: number): Destination | null {
  let start = offset + /^[ \t]*(?:\r?\n[ \t]*)?/.exec(text.slice(offset))![0].length;
  if (text[start] === '\r' || text[start] === '\n') return null;
  const angle = text[start] === '<';
  if (angle) start++;
  let depth = 0;
  for (let end = start; end < text.length; end++) {
    const character = text[end]!;
    if (character === '\\') { end++; continue; }
    if (angle) {
      if (character === '>') return { start, end, after: end + 1 };
      if (character === '\r' || character === '\n' || character === '<') return null;
    } else {
      if (character === '(') depth++;
      if ((character === ')' && depth === 0) || /\s/.test(character)) return depth === 0 ? { start, end, after: end } : null;
      if (character === ')') depth--;
    }
  }
  return !angle && depth === 0 ? { start, end: text.length, after: text.length } : null;
}

function relativeDestination(link: string, sourcePath: string, targetPath: string, resolve?: ResolveLink): string {
  if (!link || /^[#?/\\]/.test(link) || /^[a-z][a-z\d+.-]*:/i.test(link)) return link;
  const suffix = link.search(/(?<!\\)[?#]/);
  const path = suffix < 0 ? link : link.slice(0, suffix);
  let resolved = pathSegments(sourcePath).slice(0, -1);
  if (resolve && !/^\.{1,2}(?:\/|$)/.test(path)) {
    // Bare Obsidian paths may be vault-root paths or shortest unique names.
    let linkpath: string;
    try { linkpath = decodeURIComponent(path.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')); }
    catch { return link; }
    const original = resolve(linkpath, sourcePath);
    if (!original || original === resolve(linkpath, targetPath)) return link;
    resolved = pathSegments(original);
  } else {
    for (const segment of path.split('/')) {
      if (segment === '..') {
        if (!resolved.length) return link;
        resolved.pop();
      } else if (segment && segment !== '.') resolved.push(segment);
    }
  }
  const targetFolder = pathSegments(targetPath).slice(0, -1);
  let common = 0;
  while (common < targetFolder.length && targetFolder[common] === resolved[common]) common++;
  let relative = [...targetFolder.slice(common).map(() => '..'), ...resolved.slice(common)].join('/') || '.';
  if (!relative.startsWith('.')) relative = `./${relative}`;
  return `${relative}${path.endsWith('/') ? '/' : ''}${suffix < 0 ? '' : link.slice(suffix)}`;
}

/** Rebase Markdown and wiki destinations without rewriting labels, code, or the source note. */
export function rebaseMarkdownLinks(content: string, sourcePath: string, targetPath: string, resolve?: ResolveLink): string {
  if (sourcePath.substring(0, sourcePath.lastIndexOf('/')) === targetPath.substring(0, targetPath.lastIndexOf('/'))) return content;
  const edits: { start: number; end: number; text: string }[] = [];
  const listIndents: number[] = [];
  let brackets = 0;
  let fence: { character: string; length: number } | null = null;
  const record = (destination: Destination): void => {
    const original = content.slice(destination.start, destination.end);
    const text = relativeDestination(original, sourcePath, targetPath, resolve);
    if (text !== original) edits.push({ start: destination.start, end: destination.end, text });
  };
  for (let cursor = 0; cursor < content.length;) {
    if (cursor === 0 || content[cursor - 1] === '\n') {
      const newline = content.indexOf('\n', cursor);
      const end = newline < 0 ? content.length : newline + 1;
      const rawLine = content.slice(cursor, end);
      const quoteLength = /^(?: {0,3}>[ \t]?)+/.exec(rawLine)?.[0].length ?? 0;
      const line = rawLine.slice(quoteLength);
      const indent = /^[ \t]*/.exec(line)![0].length;
      if (line.trim()) {
        while (listIndents.length && indent < listIndents.at(-1)!) listIndents.pop();
      } else brackets = 0;
      let blockOffset = listIndents.at(-1) ?? 0;
      const list = /^ {0,3}(?:[-*+]|\d+[.)])[ \t]+/.exec(line.slice(blockOffset));
      if (list) { blockOffset += list[0].length; listIndents.push(blockOffset); }
      const block = line.slice(blockOffset);
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(block);
      if (fence) {
        if (marker?.[1]?.[0] === fence.character && marker[1].length >= fence.length && !marker[2]?.trim()) fence = null;
        cursor = end;
        continue;
      }
      if (marker?.[1] && (marker[1][0] !== '`' || !marker[2]?.includes('`'))) {
        fence = { character: marker[1][0]!, length: marker[1].length };
        brackets = 0;
        cursor = end;
        continue;
      }
      if (/^(?: {4}|\t)/.test(block)) { cursor = end; continue; }
      const reference = /^ {0,3}\[(?:\\.|[^\]\\\r\n])+\]:[ \t]*/.exec(block);
      if (reference) {
        const destination = destinationAt(content, cursor + quoteLength + blockOffset + reference[0].length);
        if (destination) {
          record(destination);
          const nextLine = content.indexOf('\n', destination.after);
          cursor = nextLine < 0 ? content.length : nextLine + 1;
          continue;
        }
      }
    }
    const character = content[cursor];
    if (character === '\\') { cursor += 2; continue; }
    if (content.startsWith('<!--', cursor)) {
      const closing = content.indexOf('-->', cursor + 4);
      cursor = closing < 0 ? content.length : closing + 3;
      continue;
    }
    if (character === '`') {
      let end = cursor + 1;
      while (content[end] === '`') end++;
      const delimiter = content.slice(cursor, end);
      let closing = content.indexOf(delimiter, end);
      while (closing >= 0 && (content[closing - 1] === '`' || content[closing + delimiter.length] === '`')) closing = content.indexOf(delimiter, closing + delimiter.length);
      cursor = closing < 0 ? end : closing + delimiter.length;
      continue;
    }
    if (content.startsWith('[[', cursor)) {
      const wiki = /^\[\[([^\[\]\r\n]+)\]\]/.exec(content.slice(cursor));
      if (wiki) {
        const link = wiki[1]!;
        const suffix = link.search(/#|\\?\|/);
        const path = suffix < 0 ? link : link.slice(0, suffix);
        const original = path && resolve?.(path, sourcePath);
        if (original && original !== resolve?.(path, targetPath)) {
          edits.push({ start: cursor + 2, end: cursor + 2 + path.length, text: original });
        }
        cursor += wiki[0].length;
        continue;
      }
    }
    if (character === '[') brackets++;
    if (character === ']' && brackets) {
      brackets--;
      if (content[cursor + 1] === '(') {
        const destination = destinationAt(content, cursor + 2);
        const closing = destination && /^[ \t\r\n]*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))[ \t\r\n]*)?\)/.exec(content.slice(destination.after));
        if (destination && closing) {
          record(destination);
          cursor = destination.after + closing[0].length;
          continue;
        }
      }
    }
    cursor++;
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(content.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(content.slice(cursor));
  return parts.join('');
}
