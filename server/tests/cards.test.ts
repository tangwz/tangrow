import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { codeDigest, normalizeCode } from '../../src/license/format.js';
import defaults from '../fields.json' with { type: 'json' };

test('card script exports private batch files and a minimal replacement row', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tangrow-cards-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const output = join(directory, 'batch');
  const replacement = join(directory, 'replacement');
  const script = ['--import', 'tsx', 'scripts/cards.ts'];
  const create = ['--count', '2', '--channel', 'douyin', '--batch', 'sample-1', '--out', output];
  assert.equal(execFileSync(process.execPath, [...script, ...create], { encoding: 'utf8' }), '');

  const cards = readFileSync(join(output, 'cards.txt'), 'utf8').trimEnd().split('\n');
  const csv = readFileSync(join(output, 'feishu-import.csv'), 'utf8').trimEnd().split('\r\n');
  assert.equal(cards.length, 2);
  assert.equal(new Set(cards).size, 2);
  assert.equal(csv.length, 3);
  const seenIds = new Set<string>();
  for (const [index, card] of cards.entries()) {
    const row = csv[index + 1]!.split(',').map(cell => cell.slice(1, -1));
    assert.match(row[0]!, /^[0-9a-f]{32}$/);
    seenIds.add(row[0]!);
    assert.deepEqual(row.slice(1), [
      codeDigest(card), normalizeCode(card).slice(-4), defaults.channels.douyin,
      'sample-1', defaults.status.active, '3',
    ]);
    assert.equal(csv[index + 1]!.includes(card), false);
  }
  assert.equal(seenIds.size, 2);
  assert.equal(statSync(output).mode & 0o777, 0o700);
  for (const file of ['cards.txt', 'feishu-import.csv']) assert.equal(statSync(join(output, file)).mode & 0o777, 0o600);
  assert.equal(spawnSync(process.execPath, [...script, ...create]).status, 1);
  assert.equal(readFileSync(join(output, 'cards.txt'), 'utf8').trimEnd(), cards.join('\n'));

  const id = [...seenIds][0]!;
  execFileSync(process.execPath, [...script, '--replace', id, '--out', replacement]);
  const newCard = readFileSync(join(replacement, 'cards.txt'), 'utf8').trim();
  assert.deepEqual(readFileSync(join(replacement, 'feishu-import.csv'), 'utf8').trimEnd().split('\r\n'), [
    [defaults.license.id, defaults.license.codeDigest, defaults.license.codeTail].map(value => '"' + value + '"').join(','),
    [id, codeDigest(newCard), normalizeCode(newCard).slice(-4)].map(value => '"' + value + '"').join(','),
  ]);
});
