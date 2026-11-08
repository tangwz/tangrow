import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, inFolder, readSession, readSettings, recentDays, safeFolder, safeTitle, streak } from '../src/model';

test('paths reject traversal, hidden config, and absolute destinations', () => {
  for (const path of ['../notes', '/tmp/notes', '.obsidian/plugins', 'a/../b', 'a//b', 'C:/vault', 'notes/\u0000']) assert.throws(() => safeFolder(path));
  assert.equal(safeFolder('10-Life(Meta)\\Tangrow/'), '10-Life(Meta)/Tangrow');
  assert.equal(inFolder('20-Project-X/note.md', '20-Project'), false);
  assert.equal(inFolder('20-Project/one/note.md', '20-Project'), true);
});

test('note titles cannot escape their destination or break internal links', () => {
  for (const title of ['../escape', 'a/b', 'a\\b', '[[link]]', '.hidden', 'a#section', 'a\nname']) assert.throws(() => safeTitle(title));
  assert.equal(safeTitle(' A useful note.md '), 'A useful note');
});

test('settings migration ignores malformed data and does not reuse mutable defaults', () => {
  const settings = readSettings({ supportFolder: '../escape', focusMinutes: 0, habits: [{ id: 'one', name: 'Read' }, { id: 'one', name: 'Duplicate' }, { id: '../bad', name: 'Bad' }] });
  assert.equal(settings.supportFolder, '10-Life(Meta)/Tangrow');
  assert.equal(settings.focusMinutes, 25);
  assert.equal(settings.habits.length, 1);
  settings.habits.push({ id: 'two', name: 'Write' });
  assert.equal(readSettings(null).habits.length, 0);
  assert.equal(readSession({ id: '../bad' }), null);
});

test('calendar days and streaks cross month boundaries and tolerate today pending', () => {
  const time = new Date(2026, 10, 1, 12).getTime();
  assert.deepEqual(recentDays(3, time), ['2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(dayKey(time), '2026-11-01');
  assert.equal(streak(new Set(['2026-10-30', '2026-10-31']), time), 2);
  assert.equal(streak(new Set(['2026-10-30', '2026-10-31', '2026-11-01']), time), 3);
});
