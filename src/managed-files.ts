function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function matchesGeneratedContent(filename: string, content: string, expected: string, parse: (text: string) => unknown): boolean {
  if (content === expected) return true;
  if (!filename.endsWith('.base') || /^\s*#|[ \t]#/m.test(content)) return false;
  try { return JSON.stringify(canonical(parse(content))) === JSON.stringify(canonical(parse(expected))); }
  catch { return false; }
}
