import assert from 'node:assert/strict';
import test from 'node:test';
import moment from 'moment';
import { defaultJournal, journalDate, journalInterval, journalPath, journalTemplate, JOURNAL_PERIODS } from '../src/periodic-notes';
import { readSettings } from '../src/model';
import { DEFAULT_SETTINGS } from '../src/types';

const format = (date: Date, pattern: string): string => moment(date).format(pattern);

test('ISO week boundaries share the same note across calendar years and locale settings', () => {
  for (const locale of ['en', 'zh-cn']) {
    moment.locale(locale);
    const first = journalInterval('weekly', '2021-01-01');
    assert.equal(first.title, '2020-W53');
    assert.equal(first.start, '2020-12-28');
    assert.equal(first.end, '2021-01-03');
    for (const day of ['2020-12-28', '2020-12-31', '2021-01-01', '2021-01-03']) {
      assert.equal(journalPath(DEFAULT_SETTINGS, 'weekly', day, format), `${DEFAULT_SETTINGS.journalFolder}/2020/Weekly/2020-W53.md`);
    }
    assert.equal(journalInterval('weekly', '2021-01-04').title, '2021-W01');
    assert.equal(journalInterval('weekly', '2024-12-30').title, '2025-W01');
  }
  moment.locale('en');
});

test('leap months, quarters and years use inclusive local date boundaries', () => {
  const cases = [
    ['daily', '2024-02-29', '2024-02-29', '2024-02-29'],
    ['monthly', '2024-02-29', '2024-02-01', '2024-02-29'],
    ['quarterly', '2024-02-29', '2024-01-01', '2024-03-31'],
    ['quarterly', '2026-12-31', '2026-10-01', '2026-12-31'],
    ['yearly', '2024-02-29', '2024-01-01', '2024-12-31']
  ] as const;
  for (const [period, date, start, end] of cases) {
    const result = journalInterval(period, date);
    assert.equal(result.start, start);
    assert.equal(result.end, end);
    assert.equal(result.date.getHours(), 12);
  }
  for (const value of ['2025-02-29', '2026-02-30', '../2026-11-09', '2026-13-01', 'invalid']) assert.throws(() => journalDate(value));
});

test('all five default paths are distinct while legacy daily settings stay intact', () => {
  const settings = readSettings({ journalFolder: 'My journals', journalFormat: '[Daily]/YYYYMMDD' });
  const paths = JOURNAL_PERIODS.map((period) => journalPath(settings, period, '2026-11-09', format));
  assert.equal(new Set(paths).size, 5);
  assert.equal(paths[0], 'My journals/Daily/20261109.md');
  assert.equal(paths[1], 'My journals/2026/Weekly/2026-W46.md');
  assert.equal(paths[2], 'My journals/2026/Monthly/2026-11.md');
  assert.equal(paths[3], 'My journals/2026/Quarterly/2026-Q4.md');
  assert.equal(paths[4], 'My journals/2026/Yearly/2026.md');
  settings.journalFormats.weekly = '[Custom]/GGGG-[W]WW';
  settings.journalTemplates.daily = 'Templates/Daily.md';
  assert.notEqual(readSettings({}).journalFormats.weekly, settings.journalFormats.weekly);
  assert.equal(DEFAULT_SETTINGS.journalTemplates.daily, '');
  const restored = readSettings(settings);
  assert.deepEqual(restored.journalFormats, settings.journalFormats);
  assert.deepEqual(restored.journalTemplates, settings.journalTemplates);
});

test('formatted journal paths reject hidden segments, traversal and absolute paths', () => {
  for (const pattern of ['[/tmp]/YYYY', '[../]/YYYY', '[.hidden]/YYYY', '[a//b]/YYYY', '[a:*]/YYYY', '[ ]', '[a/]']) {
    const settings = readSettings({ journalFormat: pattern });
    assert.throws(() => journalPath(settings, 'daily', '2026-11-09', format), /safe relative/);
  }
});

test('templates substitute stable interval values without executing unknown expressions', () => {
  const interval = journalInterval('quarterly', '2026-11-09');
  const template = '# {{title}}\n{{date}} / {{start}} / {{end}} / {{period}} / {{year}} / Q{{quarter}}\n{{unknown}}\n';
  assert.equal(journalTemplate(template, interval), '# 2026-Q4\n2026-10-01 / 2026-10-01 / 2026-12-31 / quarterly / 2026 / Q4\n{{unknown}}\n');
  assert.match(defaultJournal(interval), /journal: Quarterly\njournal-date: 2026-10-01\njournal-end-date: 2026-12-31/);
  assert.match(defaultJournal(journalInterval('daily', '2026-11-09')), /journal: Daily\njournal-date: 2026-11-09\n---/);
});
