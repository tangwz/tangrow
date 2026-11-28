import assert from 'node:assert/strict';
import test from 'node:test';
import { translate } from '../src/i18n';
import { readSettings } from '../src/model';
import activity from '../src/locales/activity.zh-CN.json';
import periodic from '../src/locales/periodic.zh-CN.json';
import assistant from '../src/locales/assistant.zh-CN.json';
import core from '../src/locales/core.zh-CN.json';
import sidebar from '../src/locales/sidebar.zh-CN.json';
import report from '../src/locales/report.zh-CN.json';
import capture from '../src/locales/capture.zh-CN.json';
import expanded from '../src/locales/report-expanded.zh-CN.json';
import reportSettings from '../src/locales/report-settings.zh-CN.json';
import reportKnowledge from '../src/locales/report-knowledge.zh-CN.json';
import workbench from '../src/locales/workbench.zh-CN.json';
import projects from '../src/locales/project-workbench.zh-CN.json';
import chinese from '../src/locales/bases.zh-CN.json';
import accessGate from '../src/locales/access-gate.zh-CN.json';
import settingsCenter from '../src/locales/settings-center.zh-CN.json';
import onboarding from '../src/locales/onboarding.zh-CN.json';
import { readFileSync } from 'node:fs';

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]!).sort();
}

test('new and legacy settings default to Chinese without overriding an explicit language', () => {
  assert.equal(readSettings(undefined).language, 'zh-CN');
  assert.equal(readSettings({}).language, 'zh-CN');
  assert.equal(readSettings({ language: 'en' }).language, 'en');
  assert.equal(readSettings({ language: 'zh-CN' }).language, 'zh-CN');
  assert.equal(readSettings({ language: 'unknown' }).language, 'zh-CN');
  assert.equal(readSettings({ language: null }).language, 'zh-CN');
});

test('interpolation preserves translated Unicode and dynamic values', () => {
  const source = '- New notes, captures and drafts use the configured inbox: {folder}.';
  assert.equal(translate('zh-CN', source, { folder: chinese.Note }), chinese[source].replace('{folder}', chinese.Note));
  assert.equal(translate('en', source, { folder: '00-Inbox' }), '- New notes, captures and drafts use the configured inbox: 00-Inbox.');
});

test('untranslated strings fall back to English and unresolved placeholders remain visible', () => {
  assert.equal(translate('zh-CN', 'Untranslated {count} items', { count: 3 }), 'Untranslated 3 items');
  assert.equal(translate('en', 'Untranslated {count} items'), 'Untranslated {count} items');
  assert.equal(translate('zh-CN', 'Notes'), chinese.Notes);
  assert.equal(translate('en', 'Notes'), 'Notes');
});

test('the Bases dictionary retains every interpolation token and supplies Chinese prose', () => {
  for (const [source, translated] of Object.entries(chinese)) {
    assert.deepEqual(placeholders(translated), placeholders(source), source);
    assert.match(translated, /\p{Script=Han}/u, source);
  }
});

test('all interface dictionaries keep shared terms and interpolation tokens consistent', () => {
  const seen = new Map<string, string>();
  for (const dictionary of [core, sidebar, chinese, report, capture, expanded, reportSettings, activity, periodic, assistant, reportKnowledge, workbench, projects, accessGate, settingsCenter, onboarding]) {
    for (const [source, translated] of Object.entries(dictionary)) {
      assert.deepEqual(placeholders(translated), placeholders(source), source);
      if (seen.has(source)) assert.equal(translated, seen.get(source), source);
      seen.set(source, translated);
    }
  }
});

test('errors for unreadable saved drafts are shown in Chinese', () => {
  // The module imports Obsidian, so read its messages from the source instead of loading it.
  const source = readFileSync(new URL('../src/draft-submissions.ts', import.meta.url), 'utf8');
  const messages = new Set([...source.matchAll(/throw new Error\('([^']+)'\)/g)].map((match) => match[1]!));
  assert.ok(messages.has('Saved recovery drafts are invalid.'));
  for (const message of messages) assert.match(translate('zh-CN', message), /\p{Script=Han}/u, message);
});
