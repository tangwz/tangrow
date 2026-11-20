import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vector from '../../tests/fixtures/license-vectors.json' with { type: 'json' };
import { loadConfig } from '../config.js';
import { FeishuStore } from '../feishu.js';
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
  const token = writes[1]!.url.searchParams.get('client_token');
  assert.match(token ?? '', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(writes[2]!.url.searchParams.get('client_token'), token);

  now += 7200 * 1000;
  await store.findLicenseById(lic, signal);
  assert.equal(tokenRequests, 2);
});
