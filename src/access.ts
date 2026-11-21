import licenseClient from './license/client.json';
import { DAY_SECONDS, deviceDigest, hex, normalizeCode, verifyLease, type Lease, type PublicKeys, type RandomBytes } from './license/format';

const HOUR = 3600000;
const DAY = DAY_SECONDS * 1000;
export const LICENSE_ENDPOINT = licenseClient.endpoint;
export const LICENSE_KEYS: PublicKeys = Object.freeze(licenseClient.keys);
const platforms = ['macOS', 'Windows', 'Linux', 'iOS', 'Android'] as const;
export type DevicePlatform = typeof platforms[number];
type Device = { platform: DevicePlatform; lastRenewedAt: number; isCurrent: boolean };
type DeviceList = { devices: Device[]; deviceLimit: number };
type RecordName = 'device' | 'trial' | 'lease';
type ClockRecord = { startedAt: number | null; maxSeenAt: number };
export type AccessState = 'active' | 'trial' | 'needs_network' | 'expired' | 'not_started';
export type AccessEvent = 'change' | 'revoked' | 'released';
export type AccessResult = { ok: true } | { ok: false; error: string };
const fail = (error: string): AccessResult => ({ ok: false, error });
const ok: AccessResult = { ok: true };
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
function deviceList(value: Record<string, unknown>): DeviceList | null {
  if (!timestamp(value.deviceLimit) || !Array.isArray(value.devices) || !value.devices.every(device => object(device) &&
    platforms.includes(device.platform as DevicePlatform) && timestamp(device.lastRenewedAt) && typeof device.isCurrent === 'boolean')) return null;
  return { deviceLimit: value.deviceLimit, devices: value.devices };
}

export interface AccessDependencies {
  storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
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
  private highWater = 0;
  private cached?: { token: string; payload: Lease };
  private previous?: string;
  private readonly warned = new Set<string>();
  private readonly listeners = new Set<(event: AccessEvent) => void>();
  deviceList: DeviceList | null = null;

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

  private clock(now: number, persist = true): ClockRecord {
    const saved = this.read('trial');
    const valid = object(saved) && timestamp(saved.maxSeenAt) && (saved.startedAt === null ||
      timestamp(saved.startedAt) && saved.startedAt <= saved.maxSeenAt);
    if (saved !== null && !valid) this.invalid('trial');
    this.highWater = Math.max(this.highWater, now, valid ? saved.maxSeenAt as number : 0);
    const clock = { startedAt: valid ? saved.startedAt as number | null : null, maxSeenAt: this.highWater };
    if (persist && valid && saved.maxSeenAt !== this.highWater) this.write('trial', clock);
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
  subscribe(listener: (event: AccessEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: AccessEvent) {
    for (const listener of this.listeners) { try { listener(event); } catch { this.warn('listener failed'); } }
  }

  refresh(force = false, persist = true) {
    if (!this.alive) return;
    const current = this.snapshot(this.deps.now(), persist);
    const key = `${current.state}:${current.expiresAt}`;
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
    this.alive = true; this.device(true); this.refresh(); void this.check();
  }

  dispose() {
    this.alive = false; this.generation++; this.stopRequest?.(); this.listeners.clear();
    if (this.checkTimer !== undefined) this.deps.cancel(this.checkTimer);
    if (this.expiryTimer !== undefined) this.deps.cancel(this.expiryTimer);
  }

  private schedule(delay: number) {
    if (!this.alive) return;
    if (this.checkTimer !== undefined) this.deps.cancel(this.checkTimer);
    this.checkTimer = this.deps.later(() => { void this.check(); }, delay);
  }

  private async check() {
    const lease = this.lease();
    if (!this.busy && lease && this.clock(this.deps.now()).maxSeenAt > lease.payload.rnb * 1000) await this.call('renew', true);
    else this.schedule(6 * HOUR);
  }

  async activate(code: string) {
    try { code = normalizeCode(code); } catch { return fail('invalid_code'); }
    return this.call('activate', false, code);
  }
  renew() { return this.call('renew', false); }
  release() { return this.call('release', false); }

  private async call(action: 'activate' | 'renew' | 'release', background: boolean, code = ''): Promise<AccessResult> {
    if (!this.alive) return fail('stale');
    const current = this.lease();
    if (action !== 'activate' && !current) return fail('no_lease');
    const dev = this.device(true);
    if (!dev) return fail('storage');
    this.stopRequest?.();
    const generation = ++this.generation;
    this.busy = true;
    let timer: number | undefined;
    let success = false;
    const stale = () => !this.alive || generation !== this.generation || this.lease()?.token !== current?.token || this.device() !== dev;
    try {
      const deadline = new Promise<never>((_, reject) => {
        this.stopRequest = () => reject(new Error('stale'));
        timer = this.deps.later(() => reject(new Error('timeout')), background ? 5000 : 15000);
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
          this.deviceList = list; this.refresh(true);
        }
        return fail(expected[response.status]!);
      }
      const list = deviceList(parsed);
      if (!list || typeof parsed.lease !== 'string') return fail('invalid_response');
      const payload = verifyLease(parsed.lease, this.deps.keys);
      if (payload.dev !== dev || (current && (payload.lic !== current.payload.lic || payload.iat < current.payload.iat))) return fail('invalid_response');
      if (payload.st === 'active') {
        const clock = this.clock(this.deps.now());
        clock.maxSeenAt = Math.max(clock.maxSeenAt, payload.iat * 1000);
        if (action === 'release' || payload.exp * 1000 <= clock.maxSeenAt) return fail('invalid_response');
        if (!this.write('trial', clock) || !this.write('lease', parsed.lease)) return fail('storage');
      } else {
        if (!current || action === 'activate' || (action === 'release' && payload.st !== 'released')) return fail('invalid_response');
        this.emit(payload.st);
        if (stale()) return fail('stale');
        if (!this.write('lease', null)) return fail('storage');
      }
      this.deviceList = list; success = true; this.refresh(true); return ok;
    } catch (error) {
      if (!this.alive || generation !== this.generation) return fail('stale');
      return fail(error instanceof SyntaxError ? 'invalid_response' : error instanceof Error && error.message === 'timeout' ? 'timeout' : 'request_failed');
    } finally {
      if (timer !== undefined) this.deps.cancel(timer);
      if (generation === this.generation) {
        this.busy = false; this.stopRequest = undefined;
        if (!success && action === 'renew') {
          const hours = [1, 6, 24][Math.min(this.failures++, 2)]!;
          this.schedule(hours * HOUR * (1 + this.deps.jitter() / 10));
        } else if (success) { this.failures = 0; this.schedule(6 * HOUR); }
        else this.schedule(6 * HOUR);
      }
    }
  }
}
