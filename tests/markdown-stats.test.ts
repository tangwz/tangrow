import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownStats } from '../src/markdown-stats';

test('Asian characters count individually and other Unicode words retain apostrophes', () => {
  assert.deepEqual(markdownStats("\u4e2d\u6587 English don't e\u0301 42 \u65e5\u672c\u8a9e \ud55c\uad6d\uc5b4 \u{1f600}"), { wordCount: 12, characterCount: 25 });
  assert.deepEqual(markdownStats('😀 👩‍💻'), { wordCount: 0, characterCount: 4 });
  assert.deepEqual(markdownStats(''), { wordCount: 0, characterCount: 0 });
});

test('complete frontmatter and fenced or inline code are excluded with CRLF input', () => {
  const content = '\uFEFF---\r\nlabels: hidden metadata\r\n---\r\nVisible\r\n```ts\r\nsecret code\r\n```\r\n`inline hidden` end\r\n~~~\r\nalso hidden\r\n~~~';
  assert.deepEqual(markdownStats(content), { wordCount: 2, characterCount: 10 });
  assert.deepEqual(markdownStats('---\n---\nOne'), { wordCount: 1, characterCount: 3 });
  assert.deepEqual(markdownStats('---\nvalue: hidden\n...\nTwo'), { wordCount: 1, characterCount: 3 });
});

test('fence marker and length govern termination and unclosed code stays excluded', () => {
  assert.deepEqual(markdownStats('Before\n````\n```\nstill hidden\n````\nAfter'), { wordCount: 2, characterCount: 11 });
  assert.deepEqual(markdownStats('Before\n~~~\nunclosed hidden'), { wordCount: 1, characterCount: 6 });
  assert.deepEqual(markdownStats('> ```\n> hidden\n> ```\nVisible'), { wordCount: 1, characterCount: 7 });
  assert.deepEqual(markdownStats('Before `` a`b `` after'), { wordCount: 2, characterCount: 11 });
});

test('link labels and wiki aliases count while URLs, images and reference definitions do not', () => {
  const content = '[Visible label](https://example.com/path?q=secret) [[Folder/Hidden|Alias]] ![Image alt](asset.png) ![[asset.png]] [Reference][id]\n\n[id]: https://example.com/secret';
  assert.deepEqual(markdownStats(content), { wordCount: 4, characterCount: 26 });
  assert.deepEqual(markdownStats('[one](https://example.com/(two))'), { wordCount: 1, characterCount: 3 });
});

test('Markdown headings, emphasis, list markers and task markers do not count as visible characters', () => {
  const content = '# Heading\n\n**Bold** and _soft_ ~~gone~~ ==lit==\n> - [x] Task\n1. Item\n---\nEnd';
  assert.deepEqual(markdownStats(content), { wordCount: 9, characterCount: 36 });
});

test('HTML comments and tags are excluded and common or numeric entities are decoded', () => {
  const content = 'One <!-- secret\nhidden --> <b>two</b> &amp; &#x4e2d; &#25991; <https://secret.example/path> three';
  assert.deepEqual(markdownStats(content), { wordCount: 5, characterCount: 14 });
  assert.deepEqual(markdownStats('Visible <script>hidden code</script><style>hidden style</style>'), { wordCount: 1, characterCount: 7 });
  assert.deepEqual(markdownStats('Visible <!-- unclosed secret'), { wordCount: 1, characterCount: 7 });
});
