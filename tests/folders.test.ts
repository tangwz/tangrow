import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTENT_FOLDER_KEYS, hasValidSupportFolder, SupportFolderConflictError, validateFolderSettings } from '../src/folders';
import { DEFAULT_SETTINGS } from '../src/types';

test('default folders and legacy sibling folders keep content separate from support', () => {
  assert.doesNotThrow(() => validateFolderSettings(DEFAULT_SETTINGS));
  assert.doesNotThrow(() => validateFolderSettings({
    ...DEFAULT_SETTINGS,
    supportFolder: '10-Life(Meta)/Tangrow',
    journalFolder: '10-Life(Meta)/13-Journal'
  }));
});

test('support cannot equal any configured content folder', () => {
  for (const key of CONTENT_FOLDER_KEYS) {
    assert.throws(() => validateFolderSettings({ ...DEFAULT_SETTINGS, supportFolder: DEFAULT_SETTINGS[key] }), (error: unknown) => {
      assert.ok(error instanceof SupportFolderConflictError);
      assert.equal(error.contentKey, key);
      assert.equal(error.supportFolder, DEFAULT_SETTINGS[key]);
      assert.equal(error.contentFolder, DEFAULT_SETTINGS[key]);
      return true;
    });
  }
});

test('support cannot be an ancestor of any configured content folder', () => {
  for (const key of CONTENT_FOLDER_KEYS) {
    assert.throws(() => validateFolderSettings({
      ...DEFAULT_SETTINGS,
      supportFolder: 'Life',
      [key]: 'Life/Personal/Notes'
    }), SupportFolderConflictError);
  }
});

test('changing a content folder is checked against the current support folder', () => {
  for (const key of CONTENT_FOLDER_KEYS) {
    const current = { ...DEFAULT_SETTINGS, supportFolder: '99-Tangrow' };
    assert.doesNotThrow(() => validateFolderSettings(current));
    assert.throws(() => validateFolderSettings({ ...current, [key]: '99-Tangrow' }), SupportFolderConflictError);
    assert.throws(() => validateFolderSettings({ ...current, [key]: '99-Tangrow/Notes' }), SupportFolderConflictError);
    assert.equal(current[key], DEFAULT_SETTINGS[key]);
  }
});

test('dedicated support subfolders remain valid inside any content folder', () => {
  for (const key of CONTENT_FOLDER_KEYS) {
    assert.doesNotThrow(() => validateFolderSettings({
      ...DEFAULT_SETTINGS,
      supportFolder: `${DEFAULT_SETTINGS[key]}/Tangrow`
    }));
  }
});

test('similar path prefixes do not create ancestor conflicts', () => {
  for (const [supportFolder, inboxFolder] of [
    ['Notes', 'Notes-Archive'],
    ['Notes', 'Notes2/Inbox'],
    ['99-Tangrow', '99-Tangrow-Archive/Inbox'],
    ['Life/Tangrow', 'Life/Tangrow Notes/Inbox']
  ] as const) {
    assert.doesNotThrow(() => validateFolderSettings({ ...DEFAULT_SETTINGS, supportFolder, inboxFolder }));
  }
});

test('validation normalizes separators, whitespace, and trailing slashes without mutating settings', () => {
  const settings = { ...DEFAULT_SETTINGS, supportFolder: ' Notes\\Companion/ ', inboxFolder: 'Notes/Companion/Inbox/' };
  assert.throws(() => validateFolderSettings(settings), (error: unknown) => {
    assert.ok(error instanceof SupportFolderConflictError);
    assert.equal(error.supportFolder, 'Notes/Companion');
    assert.equal(error.contentFolder, 'Notes/Companion/Inbox');
    return true;
  });
  assert.equal(settings.supportFolder, ' Notes\\Companion/ ');
  assert.equal(settings.inboxFolder, 'Notes/Companion/Inbox/');
});

test('every folder must remain a safe vault-relative path', () => {
  for (const key of ['supportFolder', ...CONTENT_FOLDER_KEYS] as const) {
    for (const path of ['', '../notes', '/notes', '.obsidian', 'notes/../private', 'notes//private']) {
      assert.throws(() => validateFolderSettings({ ...DEFAULT_SETTINGS, [key]: path }));
    }
  }
});

test('support validity is a nonthrowing check for conflicting or malformed persisted folders', () => {
  assert.equal(hasValidSupportFolder(DEFAULT_SETTINGS), true);
  assert.equal(hasValidSupportFolder({ ...DEFAULT_SETTINGS, supportFolder: `${DEFAULT_SETTINGS.archiveFolder}/Tangrow` }), true);
  for (const key of CONTENT_FOLDER_KEYS) {
    assert.equal(hasValidSupportFolder({ ...DEFAULT_SETTINGS, supportFolder: DEFAULT_SETTINGS[key] }), false);
    assert.equal(hasValidSupportFolder({ ...DEFAULT_SETTINGS, supportFolder: 'Content', [key]: 'Content/Notes' }), false);
    assert.equal(hasValidSupportFolder({ ...DEFAULT_SETTINGS, [key]: '../notes' }), false);
  }
  assert.equal(hasValidSupportFolder({ ...DEFAULT_SETTINGS, supportFolder: '../notes' }), false);
});
