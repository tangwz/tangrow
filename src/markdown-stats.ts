export interface MarkdownStats {
  wordCount: number;
  characterCount: number;
}

function withoutCodeBlocks(content: string): string {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let first = 0;
  if (lines[0]?.trim() === '---') {
    const closing = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(line));
    if (closing > 0) first = closing + 1;
  }
  let fence: { marker: string; length: number } | null = null;
  const result: string[] = [];
  for (const line of lines.slice(first)) {
    const unquoted = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    if (fence) {
      const closing = unquoted.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (closing && closing[1]?.[0] === fence.marker && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = unquoted.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening?.[1] && (opening[1][0] !== '`' || !opening[2]?.includes('`'))) {
      fence = { marker: opening[1][0]!, length: opening[1].length };
      result.push('');
    } else result.push(line);
  }
  return result.join('\n');
}

function withoutInlineCode(content: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < content.length) {
    if (content[cursor] !== '`') { result += content[cursor]; cursor++; continue; }
    let end = cursor + 1;
    while (content[end] === '`') end++;
    const delimiter = content.slice(cursor, end);
    let closing = content.indexOf(delimiter, end);
    while (closing !== -1 && (content[closing - 1] === '`' || content[closing + delimiter.length] === '`')) {
      closing = content.indexOf(delimiter, closing + delimiter.length);
    }
    if (closing === -1) { result += delimiter; cursor = end; }
    else { result += ' '; cursor = closing + delimiter.length; }
  }
  return result;
}

function decodeEntities(content: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return content.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? match;
    const value = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : match;
  });
}

function renderedText(content: string): string {
  let text = withoutCodeBlocks(content).replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  text = withoutInlineCode(text);
  text = text
    .replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*(?:\n[ \t]+[^\n]*)*/gm, '')
    .replace(/(!?)\[\[([^\]\n]+)\]\]/g, (_match, image: string, target: string) => image ? '' : target.split('|').at(-1) ?? '')
    .replace(/!\[[^\]\n]*\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]\n]*\])?/g, '')
    .replace(/\[([^\]\n]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
    .replace(/<(?:(?:https?|ftp):\/\/|mailto:)[^>\n]+>/gi, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '');
  text = text.split('\n').map((line) => {
    let value = line.replace(/^(?: {0,3}>[ \t]?)+/, '');
    if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|=+[ \t]*)$/.test(value)) return '';
    value = value.replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[^\]\n]\][ \t]+)?/, '');
    if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(value)) {
      value = value.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').replace(/[ \t]+#+[ \t]*$/, '');
    }
    return value;
  }).join('\n');
  text = text
    .replace(/(\*\*|__|~~|==)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\*(?=\S)([^\n]*?\S)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}])_(?=\S)([^\n]*?\S)_(?![\p{L}\p{N}])/gu, '$1')
    .replace(/\\([\\`*{}\[\]()#+\-.!_>~|])/g, '$1');
  return decodeEntities(text);
}

export function markdownStats(content: string): MarkdownStats {
  const text = renderedText(content);
  const asian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const asianCount = [...text.matchAll(asian)].length;
  const otherText = text.replace(asian, ' ');
  const otherCount = [...otherText.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}\p{M}]+)*/gu)].length;
  return { wordCount: asianCount + otherCount, characterCount: [...text].filter((character) => !/\s/u.test(character)).length };
}
