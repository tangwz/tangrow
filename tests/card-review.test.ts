import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCardReport } from '../src/card-report-data';
import { createCardReviewQueue, readCardReviewQueue, resolveCardReviewQueue } from '../src/card-review';
import type { ReportRecord } from '../src/report-contract';
import { workbenchDestination } from '../src/workbench-navigation';

const today = new Date(2026, 10, 18, 12).getTime();

function card(path: string, id: string, reviewed?: string, target?: string): ReportRecord {
  return {
    path, name: path, created: today, modified: today,
    frontmatter: { tangrow_kind: 'card', tangrow_id: id, tangrow_reviewed_at: reviewed },
    knowledge: {
      body: target ? [{ path: target, raw: target, anchor: '' }] : [],
      sources: [], legacySources: [], parent: [], materials: [], captureResults: []
    }
  };
}

test('daily review prioritizes isolation, then overdue cards and deterministically samples the rest', () => {
  const records = [
    card('Recent.md', 'recent', '2026-11-17', 'Old.md'),
    card('Old.md', 'old', '2026-09-01'),
    card('Isolated.md', 'isolated', '2026-11-17')
  ];
  const queue = createCardReviewQueue(buildCardReport(records, records, true, today));
  assert.deepEqual(queue.entries.map(({ path, reason }) => [path, reason]), [
    ['Isolated.md', 'isolated'], ['Old.md', 'overdue'], ['Recent.md', 'sample']
  ]);
  assert.deepEqual(createCardReviewQueue(buildCardReport([...records].reverse(), [...records].reverse(), true, today)), queue);
});

test('persisted review entries survive renames, skip missing cards, and exclude new arrivals', () => {
  const original = [card('Old.md', 'same-id'), card('Removed.md', 'removed-id')];
  const queue = createCardReviewQueue(buildCardReport(original, original, true, today));
  queue.completed = ['Old.md'];
  const read = readCardReviewQueue(JSON.parse(JSON.stringify(queue)));
  assert.deepEqual(read, queue);
  const changed = [
    card('Moved.md', 'same-id'), card('Old.md', 'another-id'), card('New.md', 'new-id')
  ];
  const result = resolveCardReviewQueue(read!, buildCardReport(changed, changed, true, today));
  assert.deepEqual(Object.fromEntries(result.map(({ entry, row, reviewed }) => [entry.path, [row?.note.path ?? null, reviewed]])), {
    'Old.md': ['Moved.md', true], 'Removed.md': [null, false]
  });
});

test('legacy workbench commands select their matching views within the new top-level navigation', () => {
  const destinations = [
    ['tools', { tab: 'today' }], ['capture', { tab: 'captures' }],
    ['studio', { tab: 'projects', page: 'scratchpad' }], ['record/journal', { tab: 'today', focus: 'journal' }],
    ['write/manuscripts', { tab: 'projects', page: 'manuscripts' }], ['more/assistant', { tab: 'more', page: 'assistant' }],
    ['ai', { tab: 'more', page: 'assistant' }], ['pins', { tab: 'more', page: 'pins' }],
    ['focus', { tab: 'more', page: 'focus' }], ['habits', { tab: 'more', page: 'habits' }],
    ['compose', { tab: 'captures' }], ['projects', { tab: 'projects' }]
  ] as const;
  for (const [entry, expected] of destinations) assert.deepEqual(workbenchDestination(entry), expected);
});
