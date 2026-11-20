import { parseArgs } from 'node:util';
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codeDigest, generateCode, hex, normalizeCode, randomBytes } from '../src/license/format.js';
import defaults from '../server/fields.json' with { type: 'json' };
import { licenseIdPattern } from '../server/store.js';

const usage = [
  'Usage:',
  '  npm run license:cards -- --count 10 --channel xiaohongshu --batch batch-001 --out ./new-batch',
  '  npm run license:cards -- --replace <license-id> --out ./replacement',
  'Channels: xiaohongshu, douyin. The output directory must be new.',
].join('\n');

function csv(rows: string[][]): string {
  return rows.map(row => row.map(value => '"' + value.replace(/"/g, '""') + '"').join(',')).join('\r\n') + '\r\n';
}

function main() {
  const { values } = parseArgs({
    options: {
      count: { type: 'string' },
      channel: { type: 'string' },
      batch: { type: 'string' },
      replace: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.out) throw new Error('Missing output directory');

  const { id, codeDigest: digest, codeTail, channel, batch, status, deviceLimit } = defaults.license;
  const codes = new Set<string>();
  const ids = new Set<string>();
  const rows: string[][] = [];
  if (values.replace !== undefined) {
    if (!licenseIdPattern.test(values.replace) || [values.count, values.channel, values.batch].some(value => value !== undefined)) {
      throw new Error('Invalid replacement options');
    }
    const code = generateCode();
    codes.add(code);
    rows.push([id, digest, codeTail], [values.replace, codeDigest(code), normalizeCode(code).slice(-4)]);
  } else {
    const count = Number(values.count);
    const channelName = values.channel;
    const batchName = values.batch?.trim();
    if (!values.count || !/^\d+$/.test(values.count) || !Number.isSafeInteger(count) || count < 1 ||
        (channelName !== 'xiaohongshu' && channelName !== 'douyin') ||
        !batchName || /^[=+@-]/.test(batchName) || /[\x00-\x1f\x7f]/.test(batchName)) {
      throw new Error('Invalid batch options');
    }

    rows.push([id, digest, codeTail, channel, batch, status, deviceLimit]);
    while (codes.size < count) {
      const code = generateCode();
      const licenseId = hex(randomBytes(16));
      if (codes.has(code) || ids.has(licenseId)) continue;
      codes.add(code);
      ids.add(licenseId);
      rows.push([
        licenseId, codeDigest(code), normalizeCode(code).slice(-4),
        defaults.channels[channelName], batchName, defaults.status.active, '3',
      ]);
    }
  }

  mkdirSync(values.out, { mode: 0o700 });
  try {
    const options = { mode: 0o600, flag: 'wx' };
    writeFileSync(join(values.out, 'feishu-import.csv'), csv(rows), options);
    writeFileSync(join(values.out, 'cards.txt'), Array.from(codes).join('\n') + '\n', options);
  } catch (error) {
    for (const file of ['feishu-import.csv', 'cards.txt']) rmSync(join(values.out, file), { force: true });
    rmdirSync(values.out);
    throw error;
  }
}

try {
  main();
} catch {
  console.error('Unable to generate cards. Check the options and output directory.\n' + usage);
  process.exitCode = 1;
}
