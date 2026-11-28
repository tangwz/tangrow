import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTaskDisplay, sortTaskDisplay, taskDueLabel } from '../src/task-display';
import { completeTaskLine, openTaskLabel } from '../src/task-tools';

test('task display separates due date, priority, recurrence, and complete nested tags', () => {
  const raw = '整理本周读书笔记 #目标/写作 #计划/2026-11 🔺️ 📅️ 2026-11-27 🔁 every 2 weeks when done';
  assert.deepEqual(parseTaskDisplay(raw), {
    title: '整理本周读书笔记', tags: ['#目标/写作', '#计划/2026-11'], links: [], priority: 'highest',
    due: new Date('2026-11-27T00:00:00Z'), recurrence: 'every 2 weeks when done'
  });
  assert.deepEqual(parseTaskDisplay('Read 🔁 every week #a/b 📅 2026-11-27'), {
    title: 'Read', tags: ['#a/b'], links: [], priority: null, due: new Date('2026-11-27T00:00:00Z'), recurrence: 'every week'
  });
});

test('task display cleans each known priority and date marker while retaining malformed or literal text', () => {
  for (const [symbol, priority] of [['🔺', 'highest'], ['⏫', 'high'], ['🔼', 'medium'], ['🔽', 'low'], ['⏬', 'lowest']]) {
    assert.equal(parseTaskDisplay(`Prepare ${symbol}`).title, 'Prepare');
    assert.equal(parseTaskDisplay(`Prepare ${symbol}`).priority, priority);
  }
  for (const symbol of ['⏳', '🛫', '➕', '✅', '❌']) {
    const display = parseTaskDisplay(`Prepare ${symbol} 2026-11-27`);
    assert.equal(display.title, 'Prepare');
    assert.equal(display.due, null);
  }
  const literal = 'Review #123, `🔁 #sample` and ![[A 📅 2026-11-27|#a/b]] 📅 2026-02-30';
  assert.equal(parseTaskDisplay(literal).title, literal);
  assert.equal(parseTaskDisplay(literal).due, null);
  assert.equal(parseTaskDisplay('Check #topic, #目标/写作。').tags.join(' '), '#topic #目标/写作');
  assert.equal(parseTaskDisplay('Read [[Capture]] <!-- tangrow-capture:example -->').title, 'Read');
  assert.deepEqual(parseTaskDisplay('Press 🔁 to resend the invitation #work'), {
    title: 'Press 🔁 to resend the invitation', tags: ['#work'], links: [], priority: null, due: null, recurrence: null
  });
  assert.equal(parseTaskDisplay('Compare 📅 2026-11-27th and 28th').due, null);
  assert.equal(parseTaskDisplay('Read 🔁 EVERY DAY').recurrence, 'EVERY DAY');
});

test('only real wikilinks become task metadata and code, embeds, and escapes stay literal', () => {
  const task = parseTaskDisplay('Read `[[Example]]` ![[Embedded]] \\[[Escaped]] [[20-Project/Plan#Tasks|Plan]] [[Second]]');
  assert.deepEqual(task.links, ['[[20-Project/Plan#Tasks|Plan]]', '[[Second]]']);
  assert.equal(task.title, 'Read `[[Example]]` ![[Embedded]] \\[[Escaped]]');
});

test('task sorting prioritizes overdue and today, then highest and high, and preserves tie order', () => {
  const index = Object.freeze([
    { id: 1, text: 'Unscheduled' }, { id: 2, text: 'Tomorrow ⏫ 📅 2026-11-28' },
    { id: 3, text: 'Overdue 🔽 📅 2026-11-25' }, { id: 4, text: 'Today 📅 2026-11-27' },
    { id: 5, text: 'Highest 🔺' }, { id: 6, text: 'Today and high ⏫ 📅 2026-11-27' },
    { id: 7, text: 'Medium 🔼' }, { id: 8, text: 'Tomorrow 📅 2026-11-28' }
  ]);
  const ordered = sortTaskDisplay(index, new Date(2026, 10, 27, 23, 30));
  assert.deepEqual(ordered.map(({ task }) => task.id), [3, 4, 6, 5, 2, 1, 7, 8]);
  assert.equal(ordered[0]?.task, index[2]);
  assert.equal(ordered[0]?.display.title, 'Overdue');
});

test('due labels use local calendar days and are available in both languages', () => {
  const today = new Date(2026, 2, 8, 23, 30);
  const due = (day: string) => new Date(`${day}T00:00:00Z`);
  assert.deepEqual(taskDueLabel(due('2026-03-06'), today, 'zh-CN'), { text: '逾期 2 天', overdue: true });
  assert.deepEqual(taskDueLabel(due('2026-03-07'), today, 'en'), { text: '1 day overdue', overdue: true });
  assert.equal(taskDueLabel(due('2026-03-08'), today, 'zh-CN').text, '今天');
  assert.equal(taskDueLabel(due('2026-03-09'), today, 'en').text, 'Tomorrow');
  assert.equal(taskDueLabel(due('2026-03-10'), today, 'en').text, 'Tue');
  assert.equal(taskDueLabel(due('2026-03-24'), today, 'en').text, 'Mar 24');
});

test('cleaning a title leaves the guarded checkbox edit bound to the original indexed label', () => {
  const note = '> - [/] Review #goal/writing ⏫ 📅 2026-11-27\r\n';
  const raw = openTaskLabel(note.trimEnd());
  assert.ok(raw !== null);
  assert.equal(parseTaskDisplay(raw).title, 'Review');
  assert.equal(completeTaskLine(note, 0, raw), note.replace('[/]', '[x]'));
  assert.throws(() => completeTaskLine(note.replace('#goal/writing', '#goal/video'), 0, raw), /changed in its note/);
});
