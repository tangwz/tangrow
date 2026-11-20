import assert from 'node:assert/strict';
import test from 'node:test';
import { Access, type AccessDependencies } from '../src/access';
import { DAY_SECONDS, signLease, type Lease } from '../src/license/format';
import vector from './fixtures/license-vectors.json';

const leaseKey = 'tangrow:lease:v1';
const hour = 3600000;
const details = { deviceLimit: 3, devices: [{ platform: 'iOS', isCurrent: true, lastRenewedAt: vector.payload.iat }] };
const response = (lease = vector.lease) => ({ status: 200, text: JSON.stringify({ lease, ...details }) });
function fixture(records = new Map<string, string>()) {
  const state = { now: vector.payload.iat * 1000, request: (async () => response()) as AccessDependencies['request'] };
  const warnings: string[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let next = 0;
  const deps: AccessDependencies = {
    storage: () => ({ getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) }),
    now: () => state.now, bytes: () => Buffer.from(vector.deviceId, 'hex'), jitter: () => 0, keys: { 'test-1': vector.publicKey }, platform: 'iOS', version: '1',
    request: (path, body) => state.request(path, body), later: (callback, delay) => { timers.set(++next, { callback, delay }); return next; },
    cancel: timer => { timers.delete(timer); }, warn: message => { warnings.push(message); }
  };
  const access = new Access(deps); access.start();
  return { access, deps, state, records, timers, warnings };
}

test('explicit trial spans midnight, survives restart and cannot regain time on rollback', () => {
  const { access, state, deps } = fixture();
  state.now = Date.UTC(2026, 10, 20, 23, 55);
  assert.equal(access.snapshot().state, 'not_started');
  assert.ok(access.startTrial().ok);
  assert.equal(access.snapshot().expiresAt, Date.UTC(2026, 10, 21, 23, 55));
  state.now += 4 * hour; assert.equal(access.snapshot().remainingMs, 20 * hour);
  state.now -= 2 * hour; access.dispose();
  const reopened = new Access(deps); reopened.start(); assert.equal(reopened.snapshot().remainingMs, 20 * hour);
  state.now += 22 * hour; assert.equal(reopened.canUse(), false); assert.equal(reopened.snapshot().state, 'expired');
  assert.equal(reopened.startTrial().ok, false);
});

test('activation wire, offline expiry and rollback', async () => {
  const { access, state } = fixture();
  state.request = async (path, body) => {
    assert.equal(path, '/v1/activate'); assert.deepEqual(body, { code: vector.normalized, dev: vector.deviceDigest, platform: 'iOS', pluginVersion: '1' }); return response();
  };
  assert.ok((await access.activate(vector.code)).ok); assert.deepEqual(access.deviceList, details);
  state.now = vector.payload.exp * 1000; assert.equal(access.snapshot().state, 'needs_network');
  state.now -= hour; assert.equal(access.canUse(), false);
});

function terminal(st: 'released' | 'revoked', overrides: Partial<Lease> = {}) {
  const { exp: _expiry, ...base } = vector.payload;
  return signLease({ ...base, st, ...overrides } as Lease, Buffer.from(vector.seedHex, 'hex'));
}

test('first activation verifies this device; expired signed leases renew with rotated keys', async () => {
  const { access, state, deps, records } = fixture();
  const sign = (overrides: Partial<Lease>) => signLease({ ...vector.payload, ...overrides } as Lease, Buffer.from(vector.seedHex, 'hex'));
  state.request = async () => response(sign({ dev: 'f'.repeat(64) }));
  assert.equal((await access.activate(vector.code)).ok, false); assert.equal(records.has(leaseKey), false);
  state.request = async () => response(); await access.activate(vector.code);
  state.now = vector.payload.exp * 1000; assert.equal(access.snapshot().state, 'needs_network');
  deps.keys = { ...deps.keys, 'test-2': vector.publicKey };
  const iat = state.now / 1000;
  const next = sign({ kid: 'test-2', iat, rnb: iat + 7 * DAY_SECONDS, exp: iat + 30 * DAY_SECONDS });
  state.request = async (path, body) => { assert.equal(path, '/v1/renew'); assert.deepEqual(body, { lease: vector.lease, platform: 'iOS' }); return response(next); };
  assert.ok((await access.renew()).ok); assert.equal(access.snapshot().state, 'active');
});

test('a release in another instance invalidates an outstanding renewal', async () => {
  const { access, state, deps } = fixture(); await access.activate(vector.code);
  const sibling = new Access(deps); sibling.start();
  let deliver!: (reply: ReturnType<typeof response>) => void;
  state.request = () => new Promise(resolve => { deliver = resolve; });
  const pending = access.renew();
  state.request = async () => response(terminal('released'));
  assert.ok((await sibling.release()).ok); deliver(response());
  assert.deepEqual(await pending, { ok: false, error: 'stale' }); assert.equal(access.canUse(), false);
});

for (const status of ['released', 'revoked'] as const) test(`${status} notifies before deletion and preserves trial`, async () => {
  const { access, state, records } = fixture(); access.startTrial(); await access.activate(vector.code);
  const seen: string[] = [];
  access.subscribe(event => seen.push(`${event}:${access.snapshot().state}`));
  state.request = async () => response(terminal(status));
  assert.ok((await (status === 'released' ? access.release() : access.renew())).ok);
  assert.deepEqual(seen, [`${status}:active`, 'change:trial']); assert.equal(records.has(leaseKey), false);
});

test('unsigned errors, malformed replies and nonmatching signed leases retain the current lease', async () => {
  const { access, state, records } = fixture(); await access.activate(vector.code);
  for (const reply of [response(terminal('revoked', { lic: 'a'.repeat(32) })), response(terminal('released', { dev: 'b'.repeat(64) })),
    response(terminal('revoked', { iat: vector.payload.iat - 1, rnb: vector.payload.rnb - 1 })), response(vector.lease + 'x'),
    { status: 503, text: '{"error":"upstream_unavailable"}' }, { status: 429, text: '{"error":"rate_limited"}' }, { status: 200, text: '<html>' }]) {
    state.request = async () => reply; assert.equal((await access.renew()).ok, false); assert.equal(records.get(leaseKey), JSON.stringify(vector.lease));
  }
  state.request = async () => { throw new Error('offline'); }; assert.equal((await access.renew()).ok, false); assert.ok(access.canUse());
  state.request = async () => ({ status: 409, text: JSON.stringify({ ...details, error: 'device_limit' }) });
  assert.deepEqual(await access.activate(vector.code), { ok: false, error: 'device_limit' }); assert.deepEqual(access.deviceList, details);
});

test('late requests cannot change a superseding activation or an unloaded instance', async () => {
  const { access, state, records, timers } = fixture();
  let deliver!: (reply: ReturnType<typeof response>) => void;
  state.request = () => new Promise(resolve => { deliver = resolve; });
  const pending = access.activate(vector.code);
  [...timers.values()].find(timer => timer.delay === 15000)!.callback();
  assert.deepEqual(await pending, { ok: false, error: 'timeout' }); deliver(response());
  assert.equal(records.has(leaseKey), false);
  const first = access.activate(vector.code); const second = access.activate(vector.code);
  assert.deepEqual(await first, { ok: false, error: 'stale' }); access.dispose(); deliver(response());
  assert.deepEqual(await second, { ok: false, error: 'stale' }); assert.equal(records.has(leaseKey), false);
});

test('corrupt storage warns but starts; unconfirmed writes do not start a trial', () => {
  const records = new Map(['device', 'lease', 'trial'].map(name => [`tangrow:${name}:v1`, 'broken']));
  const { access, warnings, deps } = fixture(records); assert.equal(access.snapshot().state, 'not_started'); assert.ok(warnings.length >= 3);
  deps.storage = () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  assert.deepEqual(access.startTrial(), { ok: false, error: 'storage' }); assert.equal(access.canUse(), false);
});

test('startup renews expired leases with 5s timeout and bounded retry delays', async () => {
  const { access, state, deps, timers } = fixture(); await access.activate(vector.code); access.dispose();
  state.now += 31 * DAY_SECONDS * 1000; state.request = () => new Promise(() => {});
  const reopened = new Access(deps); reopened.start();
  for (const expected of [1, 6, 24, 24]) {
    [...timers.values()].find(timer => timer.delay === 5000)!.callback(); await new Promise(resolve => setImmediate(resolve));
    const [id, retry] = [...timers].find(([, timer]) => timer.delay === expected * hour)!;
    timers.delete(id); retry.callback();
  }
  reopened.dispose();
});
