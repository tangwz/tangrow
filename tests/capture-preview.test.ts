import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePreview, PREVIEW_SOURCE_LIMIT } from '../src/capture-preview';

test('previews omit metadata and the title while preserving readable links and text', () => {
  const body = '# Capture title\n\n**A thought** with [[Notes/One|an alias]] and [a link](https://example.com).\n> A second line.';
  for (const newline of ['\n', '\r\n']) {
    const source = `\uFEFF---\nprivate: secret\n---\n${body}`.replace(/\n/g, newline);
    assert.equal(capturePreview(source), 'A thought with an alias and a link. A second line.');
  }
  assert.equal(capturePreview('---\nprivate: secret\n...\n# Title\n\nBody.'), 'Body.');
});

test('previews cap visible code points without splitting emoji or adding a false ellipsis', () => {
  assert.equal(capturePreview('\u{1F331}'.repeat(240)), '\u{1F331}'.repeat(240));
  assert.equal(capturePreview('\u{1F331}'.repeat(241)), `${'\u{1F331}'.repeat(240)}\u2026`);
  const source = ' '.repeat(PREVIEW_SOURCE_LIMIT - 1) + '\u{1F331}';
  assert.equal(capturePreview(source), '');
});

test('large and malformed captures cannot make preview parsing inspect the unbounded tail', () => {
  const prefix = 'A short thought.\n' + ' '.repeat(PREVIEW_SOURCE_LIMIT);
  assert.equal(capturePreview(prefix + '[['.repeat(1_000_000)), 'A short thought.\u2026');
  assert.equal(capturePreview(prefix + 'A different tail.'), 'A short thought.\u2026');
  assert.equal(capturePreview('['.repeat(PREVIEW_SOURCE_LIMIT) + ']'.repeat(1_000_000)), '['.repeat(240) + '\u2026');
});

test('oversized or incomplete frontmatter never appears as body text', () => {
  assert.equal(capturePreview('---\nprivate: ' + 'secret '.repeat(100_000) + '\n---\nBody.'), '');
  assert.equal(capturePreview('---\nprivate: secret'), '');
  const boundary = '---\n' + ' '.repeat(PREVIEW_SOURCE_LIMIT - 7) + '---suffix\nBody.';
  assert.equal(capturePreview(boundary), '');
  assert.equal(capturePreview('# Title\n\n'), '');
});
