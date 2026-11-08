import assert from 'node:assert/strict';
import test from 'node:test';
import { stampHeadingDate } from '../src/note-tools';

test('heading dates preserve frontmatter, body text and existing closing markers', () => {
  const note = '---\ntitle: Keep this property\n---\n\n# A heading ###\n\nSelected body text.\n';
  assert.equal(stampHeadingDate(note, 'Unused title', '2026-11-08'), '---\ntitle: Keep this property\n---\n\n# A heading · 2026-11-08 ###\n\nSelected body text.\n');
});

test('fenced examples are skipped and repeated dates are idempotent', () => {
  const note = '```md\n# An example\n```\n\n# Actual heading\nBody';
  const dated = stampHeadingDate(note, 'Fallback', '2026-11-08');
  assert.equal(dated, '```md\n# An example\n```\n\n# Actual heading · 2026-11-08\nBody');
  assert.equal(stampHeadingDate(dated, 'Fallback', '2026-11-08'), dated);
});

test('setext headings and CRLF documents retain their format', () => {
  const note = 'A heading\r\n=========\r\n\r\nBody\r\n';
  assert.equal(stampHeadingDate(note, 'Unused', '2026-11-08'), 'A heading · 2026-11-08\r\n=========\r\n\r\nBody\r\n');
});

test('notes without headings receive a body title without changing file identity', () => {
  assert.equal(stampHeadingDate('Body text', 'Existing filename', '2026-11-08'), '# Existing filename · 2026-11-08\n\nBody text');
  assert.throws(() => stampHeadingDate('---\nunclosed: true', 'Title', '2026-11-08'), /frontmatter/);
  assert.throws(() => stampHeadingDate('Body', 'Title', '../escape'), /ISO/);
});
