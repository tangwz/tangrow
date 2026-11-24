import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import nacl from 'tweetnacl';
import { Access, type AccessDependencies } from '../src/access';
import { accessCoordination, INTERACTIVE_TIMEOUT_MS, type AccessCoordination } from '../src/access-coordination';
import { DAY_SECONDS, deviceDigest, signLease, type Lease } from '../src/license/format';
import { testWebLocks } from './obsidian-mock';
import vector from './fixtures/license-vectors.json';

const leaseKey = 'tangrow:lease:v1';
const hour = 3600000;
const details = { deviceLimit: 3, devices: [{ platform: 'iOS', isCurrent: true, lastRenewedAt: vector.payload.iat }] };
const response = (lease = vector.lease) => ({ status: 200, text: JSON.stringify({ lease, ...details }) });
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function localCoordination(): AccessCoordination {
  let activating = false;
  return {
    async initializeDevice(initialize) { initialize(); },
    async tryActivate<T>(activate: () => Promise<T>) {
      if (activating) return null;
      activating = true;
      try { return await activate(); }
      finally { activating = false; }
    }
  };
}

function fixture(records = new Map<string, string>(), overrides: Partial<AccessDependencies> = {}) {
  const state = { now: vector.payload.iat * 1000, request: (async () => response()) as AccessDependencies['request'] };
  const warnings: string[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let next = 0;
  const deps: AccessDependencies = {
    coordination: localCoordination(),
    storage: () => ({ getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) }),
    now: () => state.now, bytes: () => Buffer.from(vector.deviceId, 'hex'), jitter: () => 0, keys: { 'test-1': vector.publicKey }, platform: 'iOS', version: '1',
    request: (path, body) => state.request(path, body), later: (callback, delay) => { timers.set(++next, { callback, delay }); return next; },
    cancel: timer => { timers.delete(timer); }, warn: message => { warnings.push(message); }, ...overrides
  };
  const access = new Access(deps); access.start();
  return { access, deps, state, records, timers, warnings };
}

function active(iat: number, overrides: { lic?: string; dev?: string } = {}) {
  return signLease({ ...vector.payload, ...overrides, st: 'active', iat, rnb: iat + 7 * DAY_SECONDS,
    exp: iat + 30 * DAY_SECONDS } as Lease, Buffer.from(vector.seedHex, 'hex'));
}

test('an owner build is always available, leaves the trial unused and never contacts the license service', async () => {
  const records = new Map([['tangrow:trial:v1', JSON.stringify({ startedAt: 0, maxSeenAt: 0 })]]);
  const before = new Map(records);
  let requests = 0;
  const { access, state, timers } = fixture(records, { ownerBuild: true, request: async () => { requests++; return response(); } });
  assert.deepEqual(access.snapshot(), { state: 'active', expiresAt: null, remainingMs: 0 });
  assert.equal(access.hasLease(), false);
  state.now += 400 * DAY_SECONDS * 1000;
  access.onResume('online');
  access.onResume('foreground');
  access.refresh();
  assert.equal(access.canUse(), true);
  for (const result of [access.startTrial(), await access.activate(vector.code), await access.renew(), await access.release()]) {
    assert.deepEqual(result, { ok: false, error: 'owner_build' });
  }
  access.dispose();
  assert.equal(requests, 0);
  assert.equal(timers.size, 0);
  assert.deepEqual(records, before);
});

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

test('a signed lease repairs a clock that once ran ahead in every window', async () => {
  const { access, deps, state, records, warnings } = fixture();
  const sibling = new Access(deps); sibling.start();
  const real = vector.payload.iat * 1000;
  const trialKey = 'tangrow:trial:v1';
  state.now = real + 400 * DAY_SECONDS * 1000;
  assert.ok(access.startTrial().ok);
  sibling.snapshot();
  state.now = real;
  assert.ok((await access.activate(vector.code)).ok);
  assert.equal(access.snapshot().state, 'active');
  // The sibling saw the future time in memory and must not write it back.
  assert.equal(sibling.snapshot().state, 'active');
  assert.equal(access.snapshot().state, 'active');
  const saved = JSON.parse(records.get(trialKey)!);
  assert.equal(saved.maxSeenAt, real);
  assert.ok(saved.startedAt <= saved.maxSeenAt);
  const reopened = new Access(deps); reopened.start(); assert.equal(reopened.snapshot().state, 'active');
  // Rolling back after the repair still cannot reach before the highest time observed since.
  state.now = vector.payload.exp * 1000; assert.equal(access.snapshot().state, 'needs_network');
  state.now -= hour; assert.equal(access.canUse(), false);
  state.now = real;
  state.request = async () => response(terminal('released'));
  assert.ok((await access.release()).ok);
  // The trial that started while the clock ran ahead stays used.
  assert.equal(access.snapshot().state, 'expired');
  assert.equal(access.startTrial().ok, false);
  assert.ok(!warnings.includes('Tangrow access: trial'));
});

test('frequent checks store the clock mark at most once a minute, and unload stores the exact mark', () => {
  const trialKey = 'tangrow:trial:v1';
  const records = new Map<string, string>();
  let writes = 0;
  const { access, deps, state } = fixture(records, { storage: () => ({
    getItem: key => records.get(key) ?? null,
    setItem: (key, value) => { if (key === trialKey) writes++; records.set(key, value); },
    removeItem: key => { records.delete(key); },
  }) });
  assert.ok(access.startTrial().ok);
  const started = writes;
  // A burst of keystrokes over ten seconds checks access a hundred times.
  for (let count = 0; count < 100; count += 1) { state.now += 100; assert.ok(access.canUse()); }
  assert.equal(writes, started);
  state.now += 60_000; access.snapshot();
  assert.equal(writes, started + 1);
  state.now += 10_000; access.snapshot();
  assert.equal(writes, started + 1);
  const latest = state.now;
  // The held-back mark still blocks a rollback in this session.
  state.now -= 30_000;
  assert.equal(access.snapshot().remainingMs, 24 * hour - (latest - vector.payload.iat * 1000));
  access.dispose();
  assert.equal(JSON.parse(records.get(trialKey)!).maxSeenAt, latest);
  const reopened = new Access(deps); reopened.start();
  assert.equal(reopened.snapshot().remainingMs, 24 * hour - (latest - vector.payload.iat * 1000));
});

test('a device whose platform the server cannot read is listed as unknown', async () => {
  const { access, state } = fixture();
  const devices = [{ platform: null, lastRenewedAt: vector.payload.iat, isCurrent: false }];
  state.request = async () => ({ status: 409, text: JSON.stringify({ error: 'device_limit', deviceLimit: 1, devices }) });
  assert.deepEqual(await access.activate(vector.code), { ok: false, error: 'device_limit' });
  assert.deepEqual(access.deviceList, { deviceLimit: 1, devices });
});

test('first activation verifies this device; expired signed leases renew with rotated keys', async () => {
  const { access, state, deps, records } = fixture();
  const sign = (overrides: Partial<Lease>) => signLease({ ...vector.payload, ...overrides } as Lease, Buffer.from(vector.seedHex, 'hex'));
  state.request = async () => response(sign({ dev: 'f'.repeat(64) }));
  assert.equal((await access.activate(vector.code)).ok, false); assert.equal(records.has(leaseKey), false);
  state.request = async () => response(); await access.activate(vector.code);
  state.now = vector.payload.exp * 1000; assert.equal(access.snapshot().state, 'needs_network');
  const rotatedSeed = new Uint8Array(32).fill(18);
  deps.keys = { ...deps.keys, 'test-2': Buffer.from(nacl.sign.keyPair.fromSeed(rotatedSeed).publicKey).toString('base64url') };
  const iat = state.now / 1000;
  const rotated = { ...vector.payload, kid: 'test-2', iat, rnb: iat + 7 * DAY_SECONDS, exp: iat + 30 * DAY_SECONDS } as Lease;
  state.request = async () => response(sign(rotated));
  assert.deepEqual(await access.renew(), { ok: false, error: 'invalid_response' });
  assert.equal(records.get(leaseKey), JSON.stringify(vector.lease));
  const next = signLease(rotated, rotatedSeed);
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

test('a renewal in another vault does not mask a release that the server completed after it', async () => {
  const { access, state, deps, records } = fixture(); await access.activate(vector.code);
  const sibling = new Access(deps); sibling.start();
  let deliver!: (reply: ReturnType<typeof response>) => void;
  state.request = () => new Promise(resolve => { deliver = resolve; });
  const pending = access.release();
  const renewed = active(vector.payload.iat + 60);
  state.request = async () => response(renewed);
  assert.ok((await sibling.renew()).ok); assert.equal(records.get(leaseKey), JSON.stringify(renewed));
  const seen: string[] = [];
  access.subscribe(event => seen.push(event));
  deliver(response(terminal('released', { iat: vector.payload.iat + 120, rnb: vector.payload.rnb + 120 })));
  assert.ok((await pending).ok); assert.deepEqual(seen, ['released', 'change']);
  assert.equal(records.has(leaseKey), false); assert.equal(access.canUse(), false);
  sibling.refresh(); assert.equal(sibling.canUse(), false);
});

test('a release still succeeds after another vault already cleared the binding', async () => {
  const { access, state, deps, records } = fixture(); await access.activate(vector.code);
  const sibling = new Access(deps); sibling.start();
  let deliver!: (reply: ReturnType<typeof response>) => void;
  state.request = () => new Promise(resolve => { deliver = resolve; });
  const pending = access.release();
  state.request = async () => response(terminal('released'));
  assert.ok((await sibling.renew()).ok); assert.equal(records.has(leaseKey), false);
  deliver(response(terminal('released', { iat: vector.payload.iat + 1, rnb: vector.payload.rnb + 1 })));
  assert.ok((await pending).ok); assert.equal(records.has(leaseKey), false); assert.equal(access.canUse(), false);
});

test('a late release never clears a newer activation or another license stored by another vault', async () => {
  const released = terminal('released', { iat: vector.payload.iat + 60, rnb: vector.payload.rnb + 60 });
  for (const replacement of [active(vector.payload.iat + 61), active(vector.payload.iat + 30, { lic: 'b'.repeat(32) })]) {
    const { access, state, records } = fixture(); await access.activate(vector.code);
    let deliver!: (reply: ReturnType<typeof response>) => void;
    state.request = () => new Promise(resolve => { deliver = resolve; });
    const pending = access.release();
    records.set(leaseKey, JSON.stringify(replacement));
    const seen: string[] = [];
    access.subscribe(event => seen.push(event));
    deliver(response(released));
    assert.deepEqual(await pending, { ok: false, error: 'stale' }); assert.deepEqual(seen, []);
    assert.equal(records.get(leaseKey), JSON.stringify(replacement)); assert.ok(access.canUse());
  }
});

test('a renewal from another vault still makes an outstanding renewal and its errors stale', async () => {
  for (const reply of [response(active(vector.payload.iat + 120)), { status: 503, text: '{"error":"upstream_unavailable"}' }]) {
    const { access, state, records } = fixture(); await access.activate(vector.code);
    let deliver!: (reply: { status: number; text: string }) => void;
    state.request = () => new Promise(resolve => { deliver = resolve; });
    const pending = access.renew();
    const renewed = active(vector.payload.iat + 60);
    records.set(leaseKey, JSON.stringify(renewed));
    deliver(reply);
    assert.deepEqual(await pending, { ok: false, error: 'stale' }); assert.equal(records.get(leaseKey), JSON.stringify(renewed));
  }
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
  state.request = async () => response(vector.lease + 'x');
  assert.deepEqual(await access.renew(), { ok: false, error: 'invalid_response' });
  state.request = async () => { throw new Error('offline'); };
  assert.deepEqual(await access.renew(), { ok: false, error: 'request_failed' });
  assert.ok(access.canUse());
});

test('late responses cannot change access after a timeout or unload, and concurrent activations do not supersede the first', async () => {
  const { access, state, records, timers } = fixture();
  let deliver!: (reply: ReturnType<typeof response>) => void;
  state.request = () => new Promise(resolve => { deliver = resolve; });
  const pending = access.activate(vector.code);
  [...timers.values()].find(timer => timer.delay === 15000)!.callback();
  assert.deepEqual(await pending, { ok: false, error: 'timeout' }); deliver(response());
  assert.equal(records.has(leaseKey), false);
  const first = access.activate(vector.code); const second = access.activate(vector.code);
  assert.deepEqual(await second, { ok: false, error: 'activation_in_progress' }); access.dispose(); deliver(response());
  assert.deepEqual(await first, { ok: false, error: 'stale' }); assert.equal(records.has(leaseKey), false);
});

test('an existing binding must be released before a second code can consume a seat, even after expiry', async () => {
  const { access, state, records } = fixture();
  const secondCode = 'B'.repeat(16);
  const calls: string[] = [];
  state.request = async (path, body) => {
    calls.push(path);
    if (path === '/v1/release') return response(terminal('released'));
    return body.code === secondCode ? response(active(state.now / 1000, { lic: 'b'.repeat(32) })) : response();
  };
  assert.ok((await access.activate(vector.code)).ok);
  for (const now of [state.now, vector.payload.exp * 1000]) {
    state.now = now;
    assert.equal(access.hasLease(), true);
    assert.deepEqual(await access.activate(secondCode), { ok: false, error: 'release_first' });
    assert.equal(records.get(leaseKey), JSON.stringify(vector.lease));
  }
  assert.deepEqual(calls, ['/v1/activate']);
  assert.ok((await access.release()).ok);
  assert.equal(access.hasLease(), false);
  assert.ok((await access.activate(secondCode)).ok);
  assert.deepEqual(calls, ['/v1/activate', '/v1/release', '/v1/activate']);
  assert.equal(access.snapshot().state, 'active');
});

test('only a renewal bad_request with the reactivation hint recommends reactivation', async () => {
  const { access, state, records } = fixture();
  state.request = async () => ({ status: 400, text: '{"error":"bad_request","action":"reactivate"}' });
  assert.deepEqual(await access.activate(vector.code), { ok: false, error: 'bad_request' });
  state.request = async () => response();
  assert.ok((await access.activate(vector.code)).ok);
  state.request = async () => ({ status: 400, text: '{"error":"bad_request"}' });
  assert.deepEqual(await access.renew(), { ok: false, error: 'bad_request' });
  state.request = async () => ({ status: 400, text: '{"error":"bad_request","action":"reactivate"}' });
  assert.deepEqual(await access.renew(), { ok: false, error: 'reactivate_required' });
  assert.deepEqual(await access.release(), { ok: false, error: 'bad_request' });
  assert.equal(records.get(leaseKey), JSON.stringify(vector.lease));
});

test('device limit details remain available across readers and expire when another vault changes the lease', async () => {
  const { access, state, records } = fixture();
  const full = { deviceLimit: 1, devices: [{ platform: 'Android', lastRenewedAt: vector.payload.iat, isCurrent: false }] };
  state.request = async () => ({ status: 409, text: JSON.stringify({ ...full, error: 'device_limit' }) });
  assert.deepEqual(await access.activate(vector.code), { ok: false, error: 'device_limit' });
  access.refresh(true);
  assert.deepEqual(access.deviceList, full);
  assert.equal(access.deviceLimitReached, true);
  records.set(leaseKey, JSON.stringify(vector.lease));
  access.refresh(false, false);
  assert.equal(access.deviceLimitReached, false);
  assert.equal(access.deviceList, null);
  state.request = async () => response(terminal('released'));
  assert.ok((await access.release()).ok);
  assert.deepEqual(access.deviceList, details);
  assert.equal(access.deviceLimitReached, false);
});

test('corrupt storage warns but starts; unconfirmed writes do not start a trial', () => {
  const records = new Map(['device', 'lease', 'trial'].map(name => [`tangrow:${name}:v1`, 'broken']));
  const { access, warnings, deps } = fixture(records); assert.equal(access.snapshot().state, 'not_started'); assert.ok(warnings.length >= 3);
  deps.storage = () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} });
  assert.deepEqual(access.startTrial(), { ok: false, error: 'storage' }); assert.equal(access.canUse(), false);
});

test('startup renews expired leases with a 12s timeout and bounded retry delays', async () => {
  const { access, state, deps, timers } = fixture(); await access.activate(vector.code); access.dispose();
  state.now += 31 * DAY_SECONDS * 1000; state.request = () => new Promise(() => {});
  const reopened = new Access(deps); reopened.start();
  for (const expected of [1, 6, 24, 24]) {
    [...timers.values()].find(timer => timer.delay === 12_000)!.callback(); await new Promise(resolve => setImmediate(resolve));
    const [id, retry] = [...timers].find(([, timer]) => timer.delay === expected * hour)!;
    timers.delete(id); retry.callback();
  }
  reopened.dispose();
});

function browserWindows(backend: 'Web Locks' | 'IndexedDB', performance: Pick<Performance, 'timeOrigin' | 'now'> = globalThis.performance) {
  const locks = backend === 'Web Locks' ? globalThis.navigator?.locks ?? testWebLocks() : undefined;
  const indexedDB = new IDBFactory();
  return () => accessCoordination({ navigator: { locks }, indexedDB, performance, crypto: globalThis.crypto } as unknown as Window);
}

for (const backend of ['Web Locks', 'IndexedDB'] as const) {
  test(`${backend} shares first device creation and admits only one simultaneous code across vaults`, { timeout: 5000 }, async () => {
    const newWindow = browserWindows(backend);
    const records = new Map<string, string>();
    const startTogether = deferred<void>();
    let generated = 0;
    const createVault = (byte: number) => {
      const coordination = newWindow();
      return fixture(records, {
        coordination: {
          ...coordination,
          async initializeDevice(initialize) {
            await startTogether.promise;
            await coordination.initializeDevice(initialize);
          }
        },
        bytes: size => { generated++; return Buffer.alloc(size, byte); }
      });
    };
    const left = createVault(1);
    const right = createVault(2);
    assert.equal(records.has('tangrow:device:v1'), false);
    const entered = deferred<void>();
    const finish = deferred<void>();
    const requests: string[] = [];
    const send: AccessDependencies['request'] = async (path, body) => {
      assert.equal(path, '/v1/activate');
      requests.push(body.dev!);
      entered.resolve();
      if (requests.length === 1) await finish.promise;
      return response(active(vector.payload.iat, { dev: body.dev }));
    };
    left.state.request = send;
    right.state.request = send;
    const attempts = [left.access.activate(vector.code), right.access.activate('B'.repeat(16))];
    startTogether.resolve();
    try {
      await entered.promise;
      assert.deepEqual(await Promise.race(attempts), { ok: false, error: 'activation_in_progress' });
      assert.equal(generated, 1);
      const id: string = JSON.parse(records.get('tangrow:device:v1')!);
      assert.deepEqual(requests, [deviceDigest(id)]);
    } finally { finish.resolve(); }
    assert.equal((await Promise.all(attempts)).filter(result => result.ok).length, 1);
    assert.equal(left.access.snapshot().state, 'active');
    assert.equal(right.access.snapshot().state, 'active');
    assert.deepEqual(await right.access.activate(vector.code), { ok: false, error: 'release_first' });
    assert.equal(requests.length, 1);
    left.access.dispose();
    right.access.dispose();
  });
}

test('IndexedDB can reserve and release activation without a finite performance time origin', async () => {
  const newWindow = browserWindows('IndexedDB', { timeOrigin: NaN, now: () => 42 });
  const result = await newWindow().tryActivate(async () => {
    assert.equal(await newWindow().tryActivate(async () => 'overlap'), null);
    return 'activated';
  });
  assert.equal(result, 'activated');
  assert.equal(await newWindow().tryActivate(async () => 'released'), 'released');
});

test('an abandoned IndexedDB reservation expires and its old owner cannot clear a newer reservation', { timeout: 5000 }, async t => {
  let now = Date.now();
  let elapsed = 0;
  const newWindow = browserWindows('IndexedDB', { timeOrigin: now, now: () => elapsed });
  t.mock.method(Date, 'now', () => now);
  const first = deferred<void>(), finishFirst = deferred<void>();
  const old = newWindow().tryActivate(async () => { first.resolve(); await finishFirst.promise; return 'old'; });
  await first.promise;
  now -= hour;
  assert.equal(await newWindow().tryActivate(async () => 'early'), null);
  elapsed += 2 * INTERACTIVE_TIMEOUT_MS + 1;
  const next = deferred<void>(), finishNext = deferred<void>();
  const pending = newWindow().tryActivate(async () => { next.resolve(); await finishNext.promise; return 'new'; });
  await next.promise;
  finishFirst.resolve();
  assert.equal(await old, 'old');
  assert.equal(await newWindow().tryActivate(async () => 'overlap'), null);
  finishNext.resolve();
  assert.equal(await pending, 'new');
  assert.equal(await newWindow().tryActivate(async () => 'after'), 'after');
});

test('unavailable coordination preserves trial access without allocating an untracked seat', async () => {
  const { access, state } = fixture(new Map(), {
    coordination: accessCoordination({ navigator: {} } as Window)
  });
  let requests = 0;
  state.request = async () => { requests++; return response(); };
  assert.ok(access.startTrial().ok);
  assert.deepEqual(await access.activate(vector.code), { ok: false, error: 'storage' });
  assert.equal(requests, 0);
  assert.equal(access.snapshot().state, 'trial');
});

for (const reason of ['online', 'foreground'] as const) {
  test(`${reason} wakes an expired lease from a 24-hour backoff and coalesces in-flight renewals`, async () => {
    const { access, state, timers } = fixture();
    await access.activate(vector.code);
    state.now = vector.payload.exp * 1000;
    state.request = async () => { throw new Error('offline'); };
    for (let i = 0; i < 3; i++) await access.renew();
    assert.ok([...timers.values()].some(timer => timer.delay === 24 * hour));
    let calls = 0;
    const finish = deferred<void>();
    state.request = async (path, body) => {
      calls++;
      assert.equal(path, '/v1/renew');
      assert.equal(body.lease, vector.lease);
      await finish.promise;
      return response(active(state.now / 1000));
    };
    access.onResume(reason);
    access.onResume('foreground');
    access.onResume('online');
    assert.equal(calls, 1);
    assert.ok([...timers.values()].some(timer => timer.delay === 12_000));
    assert.equal([...timers.values()].some(timer => timer.delay === 24 * hour), false);
    finish.resolve();
    await nextTurn();
    assert.equal(access.snapshot().state, 'active');
    access.onResume('online');
    assert.equal(calls, 1);
    access.dispose();
    state.now += 31 * DAY_SECONDS * 1000;
    access.onResume(reason);
    assert.equal(calls, 1);
    assert.equal(timers.size, 0);
  });
}

test('a foreground event storm respects a cooldown while a genuine reconnect can still renew immediately', async () => {
  const { access, state } = fixture();
  await access.activate(vector.code);
  state.now = vector.payload.rnb * 1000;
  let requests = 0;
  state.request = async () => { requests++; throw new Error('offline'); };
  access.onResume('foreground');
  await nextTurn();
  for (let i = 0; i < 10; i++) {
    state.now += 100;
    access.onResume('foreground');
    await nextTurn();
  }
  assert.equal(requests, 1);
  access.onResume('online');
  await nextTurn();
  assert.equal(requests, 2);
  state.now += 61_000;
  access.onResume('foreground');
  await nextTurn();
  assert.equal(requests, 3);
});

test('connectivity returning during an offline request queues one immediate retry after failure', async () => {
  const { access, state, timers } = fixture();
  await access.activate(vector.code);
  state.now = vector.payload.exp * 1000;
  let calls = 0;
  const finish = deferred<void>();
  state.request = async () => {
    calls++;
    if (calls > 1) return response(active(state.now / 1000));
    await finish.promise;
    throw new Error('offline');
  };
  access.onResume('foreground');
  access.onResume('online');
  access.onResume('online');
  finish.resolve();
  await nextTurn();
  const retries = [...timers.values()].filter(timer => timer.delay === 0);
  assert.equal(retries.length, 1);
  retries[0]!.callback();
  await nextTurn();
  assert.equal(calls, 2);
  assert.equal(access.snapshot().state, 'active');
});
