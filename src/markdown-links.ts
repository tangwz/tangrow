interface Destination { start: number; end: number; after: number }
interface RebaseOptions { sourceLocalAnchors?: boolean }
type ResolveLink = (linkpath: string, sourcePath: string) => string | null;
const INLINE_LINK_END = /^[ \t\r\n]*(?:(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))[ \t\r\n]*)?\)/;

function pathSegments(path: string): string[] {
  return path.split('/').map((segment) => encodeURIComponent(segment)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`));
}

function relativePath(segments: readonly string[], targetPath: string): string {
  const targetFolder = pathSegments(targetPath).slice(0, -1);
  let common = 0;
  while (common < targetFolder.length && targetFolder[common] === segments[common]) common++;
  const relative = [...targetFolder.slice(common).map(() => '..'), ...segments.slice(common)].join('/') || '.';
  return relative.startsWith('.') ? relative : `./${relative}`;
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

export function readMarkdownLinkTarget(value: string): string | null {
  const wiki = /^!?\[\[([^\[\]\r\n]+)\]\]$/u.exec(value);
  if (wiki) return wiki[1]!.split(/\\?\|/, 1)[0]!.trim();
  const label = /^!?\[(?:\\.|[^\]\\\r\n])*\]\(/u.exec(value);
  if (!label) return null;
  const destination = destinationAt(value, label[0].length);
  const closing = destination && INLINE_LINK_END.exec(value.slice(destination.after));
  if (!destination || !closing || destination.after + closing[0].length !== value.length) return null;
  return value.slice(destination.start, destination.end).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

/** Qualify a wikilink when creating a same-name Markdown note would make a bare basename ambiguous. */
export function newNoteCollisionWikiTarget(source: { basename: string; path: string }, newNotePath: string): string | null {
  const newBasename = newNotePath.slice(newNotePath.lastIndexOf('/') + 1, -3);
  if (source.basename.normalize('NFC').toLowerCase() !== newBasename.normalize('NFC').toLowerCase()) return null;
  return source.path.includes('/') ? source.path.slice(0, -3) : `${'../'.repeat(newNotePath.split('/').length - 1)}${source.basename}`;
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
  const relative = relativePath(resolved, targetPath);
  return `${relative}${path.endsWith('/') ? '/' : ''}${suffix < 0 ? '' : link.slice(suffix)}`;
}

/** Rebase Markdown and wiki destinations without rewriting labels, code, or the source note. */
export function rebaseMarkdownLinks(content: string, sourcePath: string, targetPath: string, resolve?: ResolveLink, options: RebaseOptions = {}): string {
  const sameFolder = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1) === targetPath.slice(0, targetPath.lastIndexOf('/') + 1);
  if (sourcePath === targetPath || (sameFolder && !options.sourceLocalAnchors)) return content;
  const relativeSource = options.sourceLocalAnchors ? relativePath(pathSegments(sourcePath), targetPath) : undefined;
  const edits: { start: number; end: number; text: string }[] = [];
  const listIndents: number[] = [];
  let brackets = 0;
  let fence: { character: string; length: number } | null = null;
  const record = (destination: Destination): void => {
    const original = content.slice(destination.start, destination.end);
    const text = relativeSource && original.startsWith('#')
      ? `${relativeSource}${original}`
      : sameFolder ? original : relativeDestination(original, sourcePath, targetPath, resolve);
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
        if (options.sourceLocalAnchors && link.startsWith('#')) {
          edits.push({ start: cursor + 2, end: cursor + 2, text: sourcePath });
        } else {
          const original = !sameFolder && path && resolve?.(path, sourcePath);
          if (original && original !== resolve?.(path, targetPath)) {
            edits.push({ start: cursor + 2, end: cursor + 2 + path.length, text: original });
          }
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
        const closing = destination && INLINE_LINK_END.exec(content.slice(destination.after));
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
