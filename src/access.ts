import licenseClient from './license/client.json';
import { DAY_SECONDS, deviceDigest, hex, normalizeCode, verifyLease, type Lease, type PublicKeys, type RandomBytes } from './license/format';
import { INTERACTIVE_TIMEOUT_MS, type AccessCoordination } from './access-coordination';

const HOUR = 3600000;
const DAY = DAY_SECONDS * 1000;
const FOREGROUND_COOLDOWN_MS = 60_000;
const MARK_STEP_MS = 60_000;
export const LICENSE_ENDPOINT = licenseClient.endpoint;
export const LICENSE_KEYS: PublicKeys = Object.freeze(licenseClient.keys);
const platforms = ['macOS', 'Windows', 'Linux', 'iOS', 'Android'] as const;
export type DevicePlatform = typeof platforms[number];
/** `platform` is null when the license server cannot read the stored value. */
type Device = { platform: DevicePlatform | null; lastRenewedAt: number; isCurrent: boolean };
type DeviceList = { devices: Device[]; deviceLimit: number };
type RecordName = 'device' | 'trial' | 'lease';
/** `trustedAt` is the signed issue time that last corrected `maxSeenAt`. */
type ClockRecord = { startedAt: number | null; maxSeenAt: number; trustedAt?: number };
export type AccessState = 'active' | 'trial' | 'needs_network' | 'expired' | 'not_started';
export type AccessEvent = 'change' | 'revoked' | 'released';
export type AccessResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): AccessResult => ({ ok: false, error });
const ok: AccessResult = { ok: true };
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
function deviceList(value: Record<string, unknown>): DeviceList | null {
  if (!timestamp(value.deviceLimit) || !Array.isArray(value.devices) || !value.devices.every(device => object(device) &&
    (device.platform === null || platforms.includes(device.platform as DevicePlatform)) && timestamp(device.lastRenewedAt) && typeof device.isCurrent === 'boolean')) return null;
  return { deviceLimit: value.deviceLimit, devices: value.devices };
}

export interface AccessDependencies {
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  coordination: AccessCoordination;
  now: () => number;
  bytes: RandomBytes;
  jitter: () => number;
  keys: PublicKeys;
  platform: DevicePlatform;
  version: string;
  request: (path: string, body: Record<string, string>) => Promise<{ status: number; text: string }>;
  later: (callback: () => void, delay: number) => number;
  cancel: (timer: number) => void;
  warn: (message: string) => void;
}

export class Access {
  private alive = false;
  private generation = 0;
  private busy = false;
  private stopRequest?: () => void;
  private checkTimer?: number;
  private expiryTimer?: number;
  private failures = 0;
  private retryOnReconnect = false;
  private lastResumeAttempt = -Infinity;
  private highWater = 0;
  private trustedAt?: number;
  private initializingDevice?: Promise<void>;
  private cached?: { token: string; payload: Lease };
  private previous?: string;
  private readonly warned = new Set<string>();
  private readonly listeners = new Set<(event: AccessEvent) => void>();
  private deviceResponse?: { list: DeviceList; limited: boolean; token: string | null };

  get deviceList(): DeviceList | null { return this.deviceResponse?.list ?? null; }
  get deviceLimitReached(): boolean { return this.deviceResponse?.limited ?? false; }

  constructor(private readonly deps: AccessDependencies) {}

  private warn(key: string) {
    if (!this.warned.has(key)) { this.warned.add(key); this.deps.warn(`Tangrow access: ${key}`); }
  }

  private read(name: RecordName): unknown {
    try {
      const raw = this.deps.storage().getItem(`tangrow:${name}:v1`);
      return raw === null ? null : JSON.parse(raw) ?? this.invalid(name);
    } catch { return this.invalid(name); }
  }

  private invalid(name: RecordName): null { this.warn(name); return null; }

  private write(name: RecordName, value: unknown): boolean {
    const key = `tangrow:${name}:v1`;
    try {
      const storage = this.deps.storage();
      const raw = value === null ? null : JSON.stringify(value);
      if (raw === null) storage.removeItem(key); else storage.setItem(key, raw);
      if (storage.getItem(key) === raw) return true;
    } catch { this.warn(`write ${name}`); return false; }
    this.warn(`write ${name}`); return false;
  }

  private device(create = false): string | null {
    const id = this.read('device');
    if (typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)) return deviceDigest(id);
    if (id !== null) this.invalid('device');
    if (!create) return null;
    try {
      const next = hex(this.deps.bytes(16));
      const dev = deviceDigest(next);
      return this.write('device', next) ? dev : null;
    } catch { return this.invalid('device'); }
  }

  private initializeDevice(): Promise<void> {
    this.initializingDevice ??= this.deps.coordination.initializeDevice(() => {
      // Another vault can initialize the shared record while this window waits for the lock.
      if (this.alive) this.device(true);
    }).catch(() => this.warn('device coordination')).finally(() => { this.initializingDevice = undefined; });
    return this.initializingDevice;
  }

  private clock(now: number, persist = true, force = false): ClockRecord {
    const saved = this.read('trial');
    const valid = object(saved) && timestamp(saved.maxSeenAt) && (saved.startedAt === null ||
      timestamp(saved.startedAt) && saved.startedAt <= saved.maxSeenAt) &&
      (saved.trustedAt === undefined || timestamp(saved.trustedAt));
    if (saved !== null && !valid) this.invalid('trial');
    const trustedAt = valid ? saved.trustedAt as number | undefined : undefined;
    // Another window corrected the clock from a signed lease. Marks seen before that correction may be ahead of real time.
    if (trustedAt !== undefined && trustedAt !== this.trustedAt) { this.trustedAt = trustedAt; this.highWater = 0; }
    this.highWater = Math.max(this.highWater, now, valid ? saved.maxSeenAt as number : 0);
    const clock: ClockRecord = { startedAt: valid ? saved.startedAt as number | null : null, maxSeenAt: this.highWater,
      ...(this.trustedAt === undefined ? {} : { trustedAt: this.trustedAt }) };
    // Access checks run on every keystroke, and each write wakes the other vault windows, so store the mark at most
    // once a minute. Memory keeps the exact mark, so rolling the clock back within a session still gains nothing.
    const lag = valid ? this.highWater - (saved.maxSeenAt as number) : 0;
    if (persist && valid && (force ? lag > 0 : lag >= MARK_STEP_MS)) this.write('trial', clock);
    return clock;
  }

  private lease() {
    const token = this.read('lease');
    if (token === null) return null;
    try {
      if (typeof token !== 'string') return this.invalid('lease');
      const payload = this.cached?.token === token ? this.cached.payload : verifyLease(token, this.deps.keys);
      if (payload.st !== 'active' || payload.dev !== this.device()) return this.invalid('lease');
      this.cached = { token, payload }; return { token, payload };
    } catch { return this.invalid('lease'); }
  }

  snapshot(now = this.deps.now(), persist = true) {
    const clock = this.clock(now, persist);
    const lease = this.lease()?.payload;
    const trialEnd = clock.startedAt === null ? null : clock.startedAt + DAY;
    let state: AccessState = 'not_started';
    let expiresAt: number | null = null;
    if (lease && clock.maxSeenAt < lease.exp * 1000) { state = 'active'; expiresAt = lease.exp * 1000; }
    else if (trialEnd !== null && clock.maxSeenAt < trialEnd) { state = 'trial'; expiresAt = trialEnd; }
    else if (lease) state = 'needs_network';
    else if (trialEnd !== null) state = 'expired';
    return { state, expiresAt, remainingMs: expiresAt === null ? 0 : Math.max(0, expiresAt - clock.maxSeenAt) };
  }

  canUse(now = this.deps.now()) { return ['trial', 'active'].includes(this.snapshot(now).state); }
  hasLease(): boolean { return this.lease() !== null; }
  subscribe(listener: (event: AccessEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: AccessEvent) {
    for (const listener of this.listeners) { try { listener(event); } catch { this.warn('listener failed'); } }
  }

  refresh(force = false, persist = true) {
    if (!this.alive) return;
    const current = this.snapshot(this.deps.now(), persist);
    const token = this.lease()?.token ?? null;
    if (this.deviceResponse && this.deviceResponse.token !== token) {
      this.deviceResponse = undefined;
      force = true;
    }
    const key = `${current.state}:${current.expiresAt}:${token !== null}`;
    if (this.expiryTimer !== undefined) this.deps.cancel(this.expiryTimer);
    if (current.expiresAt !== null) this.expiryTimer = this.deps.later(() => this.refresh(), Math.min(current.remainingMs, DAY));
    if (force || this.previous !== key) { this.previous = key; this.emit('change'); }
  }

  startTrial(): AccessResult {
    if (!this.alive) return fail('stale');
    const clock = this.clock(this.deps.now());
    if (clock.startedAt !== null || this.lease()) return fail('unavailable');
    if (!this.write('trial', { ...clock, startedAt: clock.maxSeenAt })) return fail('storage');
    this.refresh(); return ok;
  }

  start() {
    if (this.alive) return;
    this.alive = true;
    if (!this.device()) void this.initializeDevice();
    this.refresh();
    void this.check();
  }

  dispose() {
    // Store the exact mark that throttled writes may have held back.
    if (this.alive) this.clock(this.deps.now(), true, true);
    this.alive = false; this.generation++; this.stopRequest?.(); this.listeners.clear();
    if (this.checkTimer !== undefined) this.deps.cancel(this.checkTimer);
    if (this.expiryTimer !== undefined) this.deps.cancel(this.expiryTimer);
  }

  private schedule(delay: number) {
    if (!this.alive) return;
    if (this.checkTimer !== undefined) this.deps.cancel(this.checkTimer);
    this.checkTimer = this.deps.later(() => { void this.check(); }, delay);
  }

  onResume(reason: 'online' | 'foreground'): void {
    if (!this.alive) return;
    this.refresh();
    if (this.busy && reason === 'online') this.retryOnReconnect = true;
    void this.check(reason);
  }

  private async check(reason?: 'online' | 'foreground') {
    if (!this.alive || this.busy) return;
    const now = this.deps.now();
    const lease = this.lease();
    if (!lease || this.clock(now).maxSeenAt < lease.payload.rnb * 1000) {
      if (!reason) this.schedule(6 * HOUR);
      return;
    }
    const elapsed = now - this.lastResumeAttempt;
    if (reason === 'foreground' && elapsed >= 0 && elapsed < FOREGROUND_COOLDOWN_MS) return;
    if (reason) this.lastResumeAttempt = now;
    await this.call('renew', true);
  }

  async activate(code: string) {
    if (!this.alive) return fail('stale');
    if (this.hasLease()) return fail('release_first');
    try { code = normalizeCode(code); } catch { return fail('invalid_code'); }
    if (!this.device()) await this.initializeDevice();
    if (!this.alive) return fail('stale');
    if (!this.device()) return fail('storage');
    try {
      return await this.deps.coordination.tryActivate(() => this.call('activate', false, code)) ?? fail('activation_in_progress');
    } catch {
      this.warn('activation coordination');
      return fail('storage');
    }
  }
  renew() { return this.call('renew', false); }
  release() { return this.call('release', false); }

  private async call(action: 'activate' | 'renew' | 'release', background: boolean, code = ''): Promise<AccessResult> {
    if (!this.alive) return fail('stale');
    const current = this.lease();
    // Recheck under the activation lock before the server can allocate a seat.
    if (action === 'activate' && current) return fail('release_first');
    if (action !== 'activate' && !current) return fail('no_lease');
    const dev = this.device();
    if (!dev) return fail('storage');
    if (action === 'activate' && this.deviceLimitReached) {
      this.deviceResponse = undefined;
      this.refresh(true);
    }
    this.stopRequest?.();
    const generation = ++this.generation;
    this.busy = true;
    this.retryOnReconnect = false;
    if (this.checkTimer !== undefined) this.deps.cancel(this.checkTimer);
    let timer: number | undefined;
    let success = false;
    const stale = () => !this.alive || generation !== this.generation || this.lease()?.token !== current?.token || this.device() !== dev;
    try {
      const deadline = new Promise<never>((_, reject) => {
        this.stopRequest = () => reject(new Error('stale'));
        timer = this.deps.later(() => reject(new Error('timeout')), background ? 5000 : INTERACTIVE_TIMEOUT_MS);
      });
      const body: Record<string, string> = action === 'activate' ? { code, dev, platform: this.deps.platform, pluginVersion: this.deps.version } : { lease: current!.token };
      if (action === 'renew') body.platform = this.deps.platform;
      const response = await Promise.race([this.deps.request(`/v1/${action}`, body), deadline]);
      if (stale()) return fail('stale');
      const parsed: unknown = JSON.parse(response.text);
      if (!object(parsed)) return fail('invalid_response');
      if (response.status !== 200) {
        const expected: Record<number, string> = { 400: 'bad_request', 403: 'revoked', 404: 'invalid_code', 409: 'device_limit', 429: 'rate_limited', 503: 'upstream_unavailable' };
        if (!Object.hasOwn(expected, response.status) || expected[response.status] !== parsed.error) return fail('invalid_response');
        if (response.status === 409) {
          const list = deviceList(parsed);
          if (!list || action !== 'activate') return fail('invalid_response');
          this.deviceResponse = { list, limited: true, token: null };
          this.refresh(true);
        }
        if (response.status === 400 && action === 'renew' && parsed.action === 'reactivate') return fail('reactivate_required');
        return fail(expected[response.status]!);
      }
      const list = deviceList(parsed);
      if (!list || typeof parsed.lease !== 'string') return fail('invalid_response');
      const payload = verifyLease(parsed.lease, this.deps.keys);
      if (payload.dev !== dev || (current && (payload.lic !== current.payload.lic || payload.iat < current.payload.iat))) return fail('invalid_response');
      if (payload.st === 'active') {
        const clock = this.clock(this.deps.now());
        // The signed issue time is real time. It also repairs a high-water mark left by a clock that once ran ahead,
        // and a rolled-back clock still cannot move the mark before it.
        const trustedAt = payload.iat * 1000;
        const maxSeenAt = Math.max(this.deps.now(), trustedAt);
        if (action === 'release' || payload.exp * 1000 <= maxSeenAt) return fail('invalid_response');
        // A trial started while the clock ran ahead counts as used, which keeps the record valid.
        const startedAt = clock.startedAt !== null && clock.startedAt > maxSeenAt ? Math.max(0, maxSeenAt - DAY) : clock.startedAt;
        if (!this.write('trial', { startedAt, maxSeenAt, trustedAt } satisfies ClockRecord)) return fail('storage');
        this.trustedAt = trustedAt;
        this.highWater = maxSeenAt;
        if (!this.write('lease', parsed.lease)) return fail('storage');
      } else {
        if (!current || action === 'activate' || (action === 'release' && payload.st !== 'released')) return fail('invalid_response');
        this.emit(payload.st);
        if (stale()) return fail('stale');
        if (!this.write('lease', null)) return fail('storage');
      }
      this.deviceResponse = { list, limited: false, token: payload.st === 'active' ? parsed.lease : null };
      success = true; this.refresh(true); return ok;
    } catch (error) {
      if (!this.alive || generation !== this.generation) return fail('stale');
      return fail(error instanceof SyntaxError ? 'invalid_response' : error instanceof Error && error.message === 'timeout' ? 'timeout' : 'request_failed');
    } finally {
      if (timer !== undefined) this.deps.cancel(timer);
      if (generation === this.generation) {
        this.busy = false; this.stopRequest = undefined;
        if (!success && action === 'renew') {
          const hours = [1, 6, 24][Math.min(this.failures++, 2)]!;
          this.schedule(this.retryOnReconnect ? 0 : hours * HOUR * (1 + this.deps.jitter() / 10));
        } else if (success) { this.failures = 0; this.schedule(6 * HOUR); }
        else this.schedule(6 * HOUR);
      }
    }
  }
}
