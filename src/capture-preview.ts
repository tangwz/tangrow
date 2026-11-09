export const PREVIEW_SOURCE_LIMIT = 16_384;
const PREVIEW_LENGTH = 240;

export function capturePreview(content: string): string {
  // Bound every parser and replacement, including frontmatter and Unicode expansion.
  let body = content.slice(0, PREVIEW_SOURCE_LIMIT).replace(/^\uFEFF/, '');
  if (/[\uD800-\uDBFF]$/.test(body)) body = body.slice(0, -1);
  const opening = /^---[ \t]*\r?\n/.exec(body);
  if (opening) {
    const rest = body.slice(opening[0].length);
    const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
    // An incomplete header must not leak metadata into the visible summary.
    if (!closing || (content.length > PREVIEW_SOURCE_LIMIT && closing.index + closing[0].length === rest.length && !closing[0].endsWith('\n'))) return '';
    body = rest.slice(closing.index + closing[0].length);
  }
  const plain = body
    .replace(/^\s*#\s+[^\n]*(?:\r?\n|$)/, '')
    .replace(/!\[([^\[\]\n]*)\]\([^\n)]*\)/g, '$1')
    .replace(/!?\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]+))?\]\]/g, (_match, path: string, alias: string | undefined) => alias ?? path)
    .replace(/\[([^\[\]\n]+)\]\([^\n)]*\)/g, '$1')
    .replace(/^[ \t]*```[^\n]*$/gm, '')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]*|[-*+][ \t]+)/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(plain);
  const truncated = characters.length > PREVIEW_LENGTH || content.length > PREVIEW_SOURCE_LIMIT;
  return plain ? characters.slice(0, PREVIEW_LENGTH).join('') + (truncated ? '\u2026' : '') : '';
}
