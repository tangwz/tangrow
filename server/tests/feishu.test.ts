import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vector from '../../tests/fixtures/license-vectors.json' with { type: 'json' };
import { loadConfig } from '../config.js';
import { FeishuStore } from '../feishu.js';
import { LicenseService } from '../service.js';
import defaults from '../fields.json' with { type: 'json' };

const settings = {
  feishu: {
    appId: 'test-app', appSecret: 'test-secret', baseToken: 'test-base',
    licenseTableId: 'test-license', deviceTableId: 'test-device',
    fields: { license: { id: 'License Number' } },
  },
  signing: { kid: vector.payload.kid, seedHex: vector.seedHex },
  listen: { host: '127.0.0.1', port: 8787, trustLoopbackProxy: true },
};

test('settings require exclusive sources and mode 600 for JSON files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tangrow-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'config.json');
  writeFileSync(file, JSON.stringify(settings), { mode: 0o644 });
  assert.throws(() => loadConfig({ TANGROW_LICENSE_CONFIG: file }), /mode 600/);
  chmodSync(file, 0o600);
  const config = loadConfig({ TANGROW_LICENSE_CONFIG: file });
  assert.equal(config.keys.publicKeys[vector.payload.kid], vector.publicKey);
  assert.equal(config.feishu.fields.license.id, 'License Number');
  assert.deepEqual(config, loadConfig({ TANGROW_LICENSE_SETTINGS: JSON.stringify(settings) }));
  assert.throws(() => loadConfig({
    TANGROW_LICENSE_CONFIG: file, TANGROW_LICENSE_SETTINGS: JSON.stringify(settings),
  }), /only one/);
});

test('Bitable uses filtered pagination, coalesced token refresh, and millisecond writes', async () => {
  let now = 0;
  let tokenRequests = 0;
  const writes: { method: string; url: URL; fields: Record<string, unknown> }[] = [];
  const config = loadConfig({ TANGROW_LICENSE_SETTINGS: JSON.stringify(settings) }).feishu;
  const names = config.fields;
  const lic = vector.payload.lic;
  const nowSeconds = vector.payload.iat;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body));
    if (url.pathname.endsWith('/tenant_access_token/internal')) {
      tokenRequests += 1;
      assert.deepEqual(body, { app_id: settings.feishu.appId, app_secret: settings.feishu.appSecret });
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-token');
    if (url.pathname.endsWith('/search')) {
      const isLicense = url.pathname.includes('/test-license/');
      const fieldName = isLicense ? names.license.id : names.device.licenseId;
      assert.deepEqual(body.filter, {
        conjunction: 'and', conditions: [{ field_name: fieldName, operator: 'is', value: [lic] }],
      });
      if (isLicense) {
        return Response.json({ code: 0, data: { has_more: false, items: [{
          record_id: 'license-row',
          fields: {
            [names.license.id]: [{ type: 'text', text: lic }],
            [names.license.codeDigest]: vector.codeDigest,
            [names.license.deviceLimit]: 4,
            [names.license.status]: defaults.status.active,
          },
        }] } });
      }
      if (!url.searchParams.has('page_token')) {
        return Response.json({ code: 0, data: { has_more: true, page_token: 'next', items: [] } });
      }
      assert.equal(url.searchParams.get('page_token'), 'next');
      return Response.json({ code: 0, data: { has_more: false, items: [{
        record_id: 'device-row',
        fields: {
          [names.device.licenseId]: lic,
          [names.device.digest]: [{ type: 'text', text: vector.deviceDigest }],
          [names.device.platform]: 'iOS',
          [names.device.firstActivatedAt]: nowSeconds * 1000,
          [names.device.lastRenewedAt]: nowSeconds * 1000,
          [names.device.status]: defaults.status.active,
        },
      }] } });
    }
    writes.push({ method: init!.method!, url, fields: body.fields });
    return Response.json({ code: 0, data: { record: { record_id: 'device-row' } } });
  };

  const store = new FeishuStore(config, fetcher, () => now);
  const signal = new AbortController().signal;
  const [license, devices] = await Promise.all([store.findLicenseById(lic, signal), store.listDevices(lic, signal)]);
  assert.equal(license?.deviceLimit, 4);
  assert.equal(devices.length, 1);
  assert.equal(devices[0]!.lastRenewedAt, nowSeconds);
  assert.equal(tokenRequests, 1);

  const device = { ...devices[0]!, status: 'released' as const };
  await store.saveDevice(device, device.recordId, signal);
  await store.saveDevice(device, undefined, signal);
  await store.saveDevice(device, undefined, signal);
  assert.deepEqual(writes.map(write => write.method), ['PUT', 'POST', 'POST']);
  assert.ok(writes[0]!.url.pathname.endsWith('/records/device-row'));
  assert.deepEqual(writes[0]!.fields, {
    [names.device.platform]: 'iOS',
    [names.device.lastRenewedAt]: nowSeconds * 1000,
    [names.device.status]: defaults.status.released,
  });
  assert.equal(writes[1]!.fields[names.device.firstActivatedAt], nowSeconds * 1000);
  // A fixed idempotency token could replay a deleted row instead of creating one.
  assert.ok(writes.every(write => !write.url.searchParams.has('client_token')));

  now += 7200 * 1000;
  await store.findLicenseById(lic, signal);
  assert.equal(tokenRequests, 2);
});

test('duplicate rows for one device resolve to the latest renewal, with a release winning ties', async () => {
  const config = loadConfig({ TANGROW_LICENSE_SETTINGS: JSON.stringify(settings) }).feishu;
  const names = config.fields.device;
  const lic = vector.payload.lic;
  const row = (recordId: string, renewedAt: number, state: 'active' | 'released', digest = vector.deviceDigest) => ({
    record_id: recordId,
    fields: {
      [names.licenseId]: lic, [names.digest]: digest, [names.platform]: 'macOS',
      [names.firstActivatedAt]: 1000, [names.lastRenewedAt]: renewedAt, [names.status]: defaults.status[state],
    },
  });
  let items: ReturnType<typeof row>[] = [];
  const fetcher: typeof fetch = async input => {
    if (new URL(String(input)).pathname.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    }
    return Response.json({ code: 0, data: { has_more: false, items } });
  };
  const store = new FeishuStore(config, fetcher);
  const signal = new AbortController().signal;
  const other = 'e'.repeat(64);

  items = [row('old', 2000, 'active'), row('new', 3000, 'active'), row('other', 2000, 'active', other)];
  assert.deepEqual((await store.listDevices(lic, signal)).map(device => device.recordId).sort(), ['new', 'other']);

  items = [row('kept', 3000, 'active'), row('released', 3000, 'released')];
  const [device] = await store.listDevices(lic, signal);
  assert.equal(device?.recordId, 'released');
  assert.equal(device?.status, 'released');
});

test('a device row with unreadable seat fields keeps its seat; only rows without a digest are skipped', async () => {
  const config = loadConfig({ TANGROW_LICENSE_SETTINGS: JSON.stringify(settings) }).feishu;
  const names = config.fields.device;
  const lic = vector.payload.lic;
  const now = 5_000_000;
  const fetcher: typeof fetch = async input => {
    if (new URL(String(input)).pathname.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    }
    return Response.json({ code: 0, data: { has_more: false, items: [
      { record_id: 'good', fields: {
        [names.licenseId]: lic, [names.digest]: vector.deviceDigest, [names.platform]: 'macOS',
        [names.firstActivatedAt]: 1000, [names.lastRenewedAt]: 2000, [names.status]: defaults.status.active,
      } },
      // An operator added this row by hand and left the dates, status and platform empty.
      { record_id: 'hand-edited', fields: { [names.licenseId]: lic, [names.digest]: 'e'.repeat(64) } },
      // No device can ever renew a row without a valid digest.
      { record_id: 'no-digest', fields: { [names.licenseId]: lic, [names.digest]: 'not a digest', [names.status]: defaults.status.active } },
    ] } });
  };
  const warnings: string[] = [];
  const store = new FeishuStore(config, fetcher, () => now, message => warnings.push(message));
  const devices = await store.listDevices(lic, new AbortController().signal);
  assert.deepEqual(devices.map(device => device.recordId), ['good', 'hand-edited']);
  assert.deepEqual(devices[1], {
    recordId: 'hand-edited', licenseId: lic, digest: 'e'.repeat(64), platform: null,
    firstActivatedAt: now / 1000, lastRenewedAt: now / 1000, status: 'active',
  });
  assert.deepEqual(warnings, [
    'Feishu device row hand-edited has an invalid status, last renewal, first activation, platform',
    'Skipped invalid Feishu device row no-digest',
  ]);
});

test('a full license stays full when another device row lacks only its first activation date', async () => {
  const config = loadConfig({ TANGROW_LICENSE_SETTINGS: JSON.stringify(settings) });
  const names = config.feishu.fields;
  const lic = vector.payload.lic;
  const nowMs = vector.payload.iat * 1000;
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    }
    if (url.pathname.includes('/test-license/')) {
      return Response.json({ code: 0, data: { has_more: false, items: [{ record_id: 'license-row', fields: {
        [names.license.id]: lic, [names.license.codeDigest]: vector.codeDigest,
        [names.license.deviceLimit]: 1, [names.license.status]: defaults.status.active,
      } }] } });
    }
    if (url.pathname.endsWith('/search')) {
      return Response.json({ code: 0, data: { has_more: false, items: [{ record_id: 'other-device', fields: {
        [names.device.licenseId]: lic, [names.device.digest]: 'e'.repeat(64), [names.device.platform]: 'Windows',
        [names.device.lastRenewedAt]: nowMs, [names.device.status]: defaults.status.active,
      } }] } });
    }
    throw new Error('A full license must not write a device row');
  };
  const service = new LicenseService(new FeishuStore(config.feishu, fetcher, () => nowMs, () => {}), config.keys, () => nowMs);
  const result = await service.handle('activate', {
    code: vector.code, dev: vector.deviceDigest, platform: 'macOS', pluginVersion: '0.4.0',
  }, new AbortController().signal, () => {});
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {
    error: 'device_limit', deviceLimit: 1,
    devices: [{ platform: 'Windows', lastRenewedAt: vector.payload.iat, isCurrent: false }],
  });
});

test('duplicate license rows stay unavailable and name the rows to fix', async () => {
  const config = loadConfig({ TANGROW_LICENSE_SETTINGS: JSON.stringify(settings) }).feishu;
  const names = config.fields.license;
  const lic = vector.payload.lic;
  const row = (recordId: string) => ({ record_id: recordId, fields: {
    [names.id]: lic, [names.codeDigest]: vector.codeDigest, [names.deviceLimit]: 3, [names.status]: defaults.status.active,
  } });
  const fetcher: typeof fetch = async input => {
    if (new URL(String(input)).pathname.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 7200 });
    }
    return Response.json({ code: 0, data: { has_more: false, items: [row('first'), row('second')] } });
  };
  const warnings: string[] = [];
  const store = new FeishuStore(config, fetcher, Date.now, message => warnings.push(message));
  await assert.rejects(store.findLicenseById(lic, new AbortController().signal));
  assert.deepEqual(warnings, ['Several Feishu license rows match one lookup: first, second']);
});

test('a rejected call drops the cached token so the next request fetches a fresh one', async () => {
  const config = loadConfig({ TANGROW_LICENSE_SETTINGS: JSON.stringify(settings) }).feishu;
  const names = config.fields.license;
  const lic = vector.payload.lic;
  let tokenRequests = 0;
  let reject = true;
  const fetcher: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname.endsWith('/tenant_access_token/internal')) {
      tokenRequests += 1;
      return Response.json({ code: 0, tenant_access_token: 'token-' + tokenRequests, expire: 7200 });
    }
    if (reject) {
      reject = false;
      // Feishu reports an early-revoked token as an API error.
      return Response.json({ code: 99991663, msg: 'invalid access token' });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer token-2');
    return Response.json({ code: 0, data: { has_more: false, items: [{ record_id: 'license-row', fields: {
      [names.id]: lic, [names.codeDigest]: vector.codeDigest, [names.deviceLimit]: 3, [names.status]: defaults.status.active,
    } }] } });
  };
  const store = new FeishuStore(config, fetcher, Date.now, () => {});
  const signal = new AbortController().signal;
  await assert.rejects(store.findLicenseById(lic, signal));
  assert.equal((await store.findLicenseById(lic, signal))?.id, lic);
  assert.equal(tokenRequests, 2);
});
