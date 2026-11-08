import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRecentOpened, recordRecentOpened, removeRecentOpened, renameRecentOpened } from '../src/recent-opened';

test('native history seed preserves opening order, validates files, and deduplicates paths', () => {
  const files = new Set(['old.md', 'new.md', 'database.base']);
  const paths = normalizeRecentOpened(['old.md', 'missing.md', 'new.md', 'old.md', 'database.base', 'folder'], (path) => files.has(path));
  assert.deepEqual(paths, ['old.md', 'new.md', 'database.base']);
  assert.deepEqual(normalizeRecentOpened(null), []);
  assert.deepEqual(normalizeRecentOpened('a.md'), []);
});

test('opening a file moves it to the front without using modification times', () => {
  const original = ['a.md', 'b.md', 'c.md'];
  assert.deepEqual(recordRecentOpened(original, 'c.md'), ['c.md', 'a.md', 'b.md']);
  assert.deepEqual(original, ['a.md', 'b.md', 'c.md']);
  assert.deepEqual(recordRecentOpened(original, 'missing.md', (path) => path !== 'missing.md'), original);
  assert.deepEqual(recordRecentOpened(original, 'd.md', undefined, 2), ['d.md', 'a.md']);
});

test('renaming a file preserves its previous position and validates the destination after replacement', () => {
  const paths = ['first.md', 'old.md', 'last.md'];
  const existing = new Set(['first.md', 'new.md', 'last.md']);
  assert.deepEqual(renameRecentOpened(paths, 'old.md', 'new.md', (path) => existing.has(path)), ['first.md', 'new.md', 'last.md']);
  assert.deepEqual(renameRecentOpened(['new.md', 'old.md', 'last.md'], 'old.md', 'new.md'), ['new.md', 'last.md']);
  assert.deepEqual(renameRecentOpened(paths, 'unopened.md', 'new.md'), paths);
});

test('folder renames and deletions update only that folder boundary', () => {
  const paths = ['Project/a.md', 'Projects/b.md', 'Project/Sub/c.md', 'outside.md'];
  assert.deepEqual(renameRecentOpened(paths, 'Project', 'Renamed'), ['Renamed/a.md', 'Projects/b.md', 'Renamed/Sub/c.md', 'outside.md']);
  assert.deepEqual(removeRecentOpened(paths, 'Project'), ['Projects/b.md', 'outside.md']);
  assert.deepEqual(removeRecentOpened(paths, 'Project/a.md'), ['Projects/b.md', 'Project/Sub/c.md', 'outside.md']);
});

test('history is bounded to 50 and malformed paths cannot enter persisted history', () => {
  const paths = Array.from({ length: 80 }, (_, index) => `Note ${index}.md`);
  assert.equal(normalizeRecentOpened(paths).length, 50);
  assert.equal(normalizeRecentOpened(paths, undefined, 500).length, 50);
  assert.equal(removeRecentOpened(paths, paths[0]!).length, 50);
  assert.deepEqual(normalizeRecentOpened(paths, undefined, 0), []);
  const invalid: unknown[] = ['', ' ', '/absolute.md', 'C:\\absolute.md', '../parent.md', '.obsidian/app.json', 'a/.trash/deleted.md', 'a//b.md', 'a/./b.md', 'a/../b.md', 'null\u0000.md', null, 3];
  assert.deepEqual(normalizeRecentOpened(invalid), []);
  assert.deepEqual(normalizeRecentOpened(['Folder\\Note.md']), ['Folder/Note.md']);
  assert.deepEqual(renameRecentOpened(['first.md', 'old.md'], 'old.md', '.trash/old.md'), ['first.md']);
});
