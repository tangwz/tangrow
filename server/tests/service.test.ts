import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import nacl from 'tweetnacl';
import vector from '../../tests/fixtures/license-vectors.json' with { type: 'json' };
import { codeDigest, DAY_SECONDS, deviceDigest, normalizeCode, signLease, verifyLease } from '../../src/license/format.js';
import type { Lease } from '../../src/license/format.js';
import { createLicenseServer } from '../http.js';
import { LicenseService } from '../service.js';
import type { Action } from '../service.js';
import type { DeviceFields, DeviceRecord, LicenseRecord, LicenseStore } from '../store.js';

const seed = Buffer.from(vector.seedHex, 'hex');
const keys = { kid: vector.payload.kid, seed, publicKeys: { [vector.payload.kid]: vector.publicKey } };
const licenseId = vector.payload.lic;
const device = (number: number) => deviceDigest(number.toString(16).padStart(32, '0'));
const day = DAY_SECONDS * 1000;

class MemoryStore implements LicenseStore {
  license: LicenseRecord = { id: licenseId, codeDigest: vector.codeDigest, status: 'active', deviceLimit: 3 };
  devices: DeviceRecord[] = [];
  unavailable = false;

  async findLicenseByCode(digest: string) {
    if (this.unavailable) throw new Error('Offline');
    if (this.license.codeDigest === digest) return { ...this.license };
  }

  async findLicenseById(id: string) {
    if (this.unavailable) throw new Error('Offline');
    if (this.license.id === id) return { ...this.license };
  }

  async listDevices(id: string) {
    return this.devices.filter(row => row.licenseId === id).map(row => ({ ...row }));
  }

  async saveDevice(fields: DeviceFields, recordId: string | undefined) {
    await setImmediate();
    if (recordId) {
      const row = this.devices.find(row => row.recordId === recordId);
      assert.ok(row);
      Object.assign(row, fields);
    } else {
      this.devices.push({ ...fields, recordId: 'row-' + this.devices.length });
    }
  }
}

function setup() {
  let time = vector.payload.iat * 1000;
  const store = new MemoryStore();
  const service = new LicenseService(store, keys, () => time);
  return {
    store, service,
    advance: (ms: number) => { time += ms; },
    now: () => time / 1000,
    call: (action: Action, body: unknown) => service.handle(action, body, new AbortController().signal, () => {}),
    activate: (dev: string, code = vector.normalized, platform = 'macOS') => service.handle(
      'activate', { code, dev, platform, pluginVersion: '0.4.0' }, new AbortController().signal, () => {},
    ),
  };
}

type Result = Awaited<ReturnType<LicenseService['handle']>>;
function token(result: Result) {
  assert.equal(result.status, 200);
  assert.ok('lease' in result.body);
  return result.body.lease;
}

test('shared vectors agree across the activation endpoint and signing format', async () => {
  assert.equal(normalizeCode(vector.code), vector.normalized);
  assert.equal(codeDigest(vector.code), vector.codeDigest);
  assert.equal(deviceDigest(vector.deviceId), vector.deviceDigest);
  assert.equal(signLease(vector.payload as Lease, seed), vector.lease);
  assert.deepEqual(verifyLease(vector.lease, keys.publicKeys), vector.payload);

  const { activate, store, now } = setup();
  const result = await activate(vector.deviceDigest, vector.code);
  assert.deepEqual(verifyLease(token(result), keys.publicKeys), vector.payload);
  assert.deepEqual(result.body, {
    lease: token(result),
    devices: [{ platform: 'macOS', lastRenewedAt: now(), isCurrent: true }],
    deviceLimit: 3,
  });
  assert.equal(store.devices.length, 1);
});

test('an occupying device refreshes in place even when all slots are taken', async () => {
  const { activate, advance, store, now } = setup();
  for (const id of [1, 2, 3]) token(await activate(device(id)));
  const first = { ...store.devices[0]! };
  advance(day);

  token(await activate(first.digest, vector.normalized, 'iOS'));
  assert.equal(store.devices.length, 3);
  assert.deepEqual(store.devices[0], { ...first, platform: 'iOS', lastRenewedAt: now() });
  const result = await activate(device(4));
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, {
    error: 'device_limit',
    devices: [
      { platform: 'iOS', lastRenewedAt: now(), isCurrent: false },
      { platform: 'macOS', lastRenewedAt: first.lastRenewedAt, isCurrent: false },
      { platform: 'macOS', lastRenewedAt: first.lastRenewedAt, isCurrent: false },
    ],
    deviceLimit: 3,
  });
});

test('invalid and revoked codes have distinct responses and revoked renewal is signed', async () => {
  const { activate, call, store } = setup();
  assert.deepEqual(await activate(device(1), '0000000000000000'), { status: 404, body: { error: 'invalid_code' } });
  const lease = token(await activate(device(1)));
  store.license.status = 'revoked';
  assert.deepEqual(await activate(device(2)), { status: 403, body: { error: 'revoked' } });
  const renewed = verifyLease(token(await call('renew', { lease })), keys.publicKeys);
  assert.equal(renewed.st, 'revoked');
  assert.equal(renewed.exp, undefined);
});

test('concurrent activation can only allocate the last slot once', async () => {
  const { activate, store } = setup();
  token(await activate(device(1)));
  token(await activate(device(2)));
  const results = await Promise.all([activate(device(3)), activate(device(4))]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(store.devices.length, 3);
});

test('an expired lease renews in place if the 46-day-old device has room', async () => {
  const { activate, advance, call, now, store } = setup();
  store.license.deviceLimit = 2;
  const lease = token(await activate(device(1)));
  const row = { ...store.devices[0]! };
  advance(46 * day);

  const second = await activate(device(2));
  assert.ok('devices' in second.body);
  assert.equal(second.body.devices.length, 1);

  const renewed = verifyLease(token(await call('renew', { lease })), keys.publicKeys);
  assert.equal(renewed.st, 'active');
  assert.equal(renewed.exp, now() + 30 * DAY_SECONDS);
  assert.deepEqual(store.devices[0], { ...row, lastRenewedAt: now() });
});

test('an expired device cannot reclaim a slot filled by another device', async () => {
  const { activate, advance, call, store } = setup();
  store.license.deviceLimit = 1;
  const lease = token(await activate(device(1)));
  advance(46 * day);
  token(await activate(device(2)));

  assert.equal(verifyLease(token(await call('renew', { lease })), keys.publicKeys).st, 'released');
  assert.equal((await activate(device(1))).status, 409);
  assert.equal(store.devices.length, 2);
});

test('release is idempotent, frees the slot, and reactivation reuses the row', async () => {
  const { activate, advance, call, store, now } = setup();
  store.license.deviceLimit = 1;
  const lease = token(await activate(device(1)));
  const first = { ...store.devices[0]! };
  for (let count = 0; count < 2; count += 1) {
    const result = await call('release', { lease });
    const released = verifyLease(token(result), keys.publicKeys);
    assert.equal(released.st, 'released');
    assert.equal(released.exp, undefined);
    assert.deepEqual(result.body, { lease: token(result), devices: [], deviceLimit: 1 });
  }
  assert.equal(verifyLease(token(await call('renew', { lease })), keys.publicKeys).st, 'released');

  const other = token(await activate(device(2)));
  assert.equal((await activate(device(1))).status, 409);
  token(await call('release', { lease: other }));
  advance(day);
  token(await activate(device(1)));
  assert.equal(store.devices.length, 2);
  assert.deepEqual(store.devices[0], { ...first, lastRenewedAt: now() });
});

test('forged leases and signed inactive leases cannot authorize renewal or release', async () => {
  const { activate, call } = setup();
  const lease = token(await activate(device(1)));
  const payload = verifyLease(lease, keys.publicKeys);
  const forged = signLease(payload, new Uint8Array(32));
  const released = token(await call('release', { lease }));
  for (const invalid of [forged, released]) {
    for (const action of ['renew', 'release'] as const) {
      assert.deepEqual(await call(action, { lease: invalid }), { status: 400, body: { error: 'bad_request' } });
    }
  }
});

test('replacing a code and restarting with a new signing key preserves existing bindings', async () => {
  const { activate, advance, store, now } = setup();
  const lease = token(await activate(device(1)));
  const newCode = '0000000000000000';
  store.license.codeDigest = codeDigest(newCode);
  assert.equal((await activate(device(1))).status, 404);

  const nextSeed = new Uint8Array(32).fill(18);
  const nextKey = Buffer.from(nacl.sign.keyPair.fromSeed(nextSeed).publicKey).toString('base64url');
  const rotated = { kid: 'test-2', seed: nextSeed, publicKeys: { ...keys.publicKeys, 'test-2': nextKey } };
  const service = new LicenseService(store, rotated, () => now() * 1000);
  advance(8 * day);
  const result = await service.handle('renew', { lease }, new AbortController().signal, () => {});
  const renewed = verifyLease(token(result), rotated.publicKeys);
  assert.equal(renewed.kid, 'test-2');
  assert.equal(renewed.dev, device(1));
  assert.equal(store.devices.length, 1);
  token(await activate(device(2), newCode));
});

test('activation counters are independent and normalized aliases share the daily limit', async () => {
  const { activate, advance, service } = setup();
  for (let count = 0; count < 20; count += 1) assert.equal(service.allowActivationFrom('192.0.2.1'), true);
  assert.equal(service.allowActivationFrom('192.0.2.1'), false);
  assert.equal(service.allowActivationFrom('192.0.2.2'), true);

  for (let count = 0; count < 20; count += 1) token(await activate(device(1)));
  assert.deepEqual(await activate(device(1), vector.code), { status: 429, body: { error: 'rate_limited' } });
  advance(day);
  assert.equal(service.allowActivationFrom('192.0.2.1'), true);
  token(await activate(device(1)));
});

test('renewal is limited per lease without blocking release', async () => {
  const { activate, advance, call } = setup();
  const lease = token(await activate(device(1)));
  for (let count = 0; count < 5; count += 1) token(await call('renew', { lease }));
  assert.deepEqual(await call('renew', { lease }), { status: 429, body: { error: 'rate_limited' } });
  advance(3600 * 1000);
  token(await call('renew', { lease }));
  token(await call('release', { lease }));
});

test('HTTP enforces JSON and body limits, sanitizes logs, and maps upstream failures to 503', async t => {
  const { store, service } = setup();
  const logs: string[] = [];
  const server = createLicenseServer(service, { log: line => logs.push(line) });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port + '/v1/';
  const post = (action: Action, body: string) => fetch(url + action, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  const activationBody = JSON.stringify({
    code: vector.code, dev: vector.deviceDigest, platform: 'macOS', pluginVersion: '0.4.0',
  });
  let response = await post('activate', activationBody);
  assert.equal(response.status, 200);
  const { lease } = await response.json() as { lease: string };
  assert.deepEqual(verifyLease(lease, keys.publicKeys), vector.payload);

  for (const body of ['{', ' '.repeat(4097)]) {
    response = await post('renew', body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'bad_request' });
  }

  const chunkedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(url + 'renew', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.write(' '.repeat(3000));
    req.end(' '.repeat(1097));
  });
  assert.equal(chunkedStatus, 400);

  store.unavailable = true;
  for (const [action, body] of [['activate', activationBody], ['renew', JSON.stringify({ lease })]] as const) {
    response = await post(action, body);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'upstream_unavailable' });
  }
  for (const line of logs) {
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['action', 'durationMs', 'license', 'result']);
    for (const sensitive of [vector.normalized, vector.deviceDigest, licenseId, lease]) {
      assert.equal(line.includes(sensitive), false);
    }
  }
  assert.equal(JSON.parse(logs[0]!).license, licenseId.slice(0, 8));
});

test('a missing device row requires activation to provide the platform', async () => {
  const { activate, call, store } = setup();
  const lease = token(await activate(device(1)));
  store.devices = [];

  assert.deepEqual(await call('renew', { lease }), { status: 400, body: { error: 'bad_request' } });
  assert.equal(store.devices.length, 0);
  const result = await activate(device(1), vector.normalized, 'iOS');
  token(result);
  assert.equal(store.devices.length, 1);
  assert.equal(store.devices[0]!.platform, 'iOS');
});
