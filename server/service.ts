import { isIPv4, isIPv6 } from 'node:net';
import { codeDigest, DAY_SECONDS, PRODUCT, signLease, verifyLease } from '../src/license/format.js';
import type { Lease, PublicKeys } from '../src/license/format.js';
import { digestPattern, isObject, isPlatform } from './store.js';
import type { DeviceFields, DeviceUpdate, LicenseRecord, LicenseStore } from './store.js';

export type Action = 'activate' | 'renew' | 'release';
type ErrorCode = 'bad_request' | 'revoked' | 'invalid_code' | 'rate_limited' | 'upstream_unavailable';

const errorStatus: Record<ErrorCode, number> = {
  bad_request: 400, revoked: 403, invalid_code: 404, rate_limited: 429, upstream_unavailable: 503,
};

export function failure(error: ErrorCode) {
  return { status: errorStatus[error], body: { error } };
}

export interface SigningKeys {
  kid: string;
  seed: Uint8Array;
  publicKeys: PublicKeys;
}

const seatWindow = 45 * DAY_SECONDS;
const hourMs = 3600 * 1000;
const dayMs = 24 * hourMs;

/**
 * Activations whose code is not found still cost a Feishu search. They draw on one budget per client address and
 * two shared by every client, so guessing from many addresses cannot use up the Feishu quota that renewals rely on.
 */
const missBudgets = (source: string) => [
  { key: 'miss-source:' + sourceKey(source), maximum: 10, window: hourMs },
  { key: 'miss-all:hour', maximum: 30, window: hourMs },
  { key: 'miss-all:day', maximum: 200, window: dayMs },
] as const;

function occupiesSeat(device: DeviceUpdate, now: number) {
  return device.status === 'active' && device.lastRenewedAt > now - seatWindow;
}

/** Expands a valid IPv6 address into its eight groups; a trailing dotted IPv4 part fills the last two. */
function ipv6Groups(address: string): number[] {
  const parse = (part: string) => part ? part.split(':').flatMap(group => {
    if (!group.includes('.')) return [parseInt(group, 16)];
    const [a, b, c, d] = group.split('.').map(Number) as [number, number, number, number];
    return [a * 256 + b, c * 256 + d];
  }) : [];
  const [head = '', tail] = address.split('::');
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * The address a rate limit is counted against. An IPv6 subscriber normally holds a whole /64, so every address
 * in it shares one budget; IPv4-mapped IPv6 counts as the IPv4 address.
 */
export function sourceKey(ip: string): string {
  const address = ip.split('%')[0]!.toLowerCase();
  if (!isIPv6(address)) return address;
  const groups = ipv6Groups(address);
  if (groups.slice(0, 6).join(',') === '0,0,0,0,0,65535') {
    const mapped = [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join('.');
    if (isIPv4(mapped)) return mapped;
  }
  return groups.slice(0, 4).map(group => group.toString(16)).join(':') + '::/64';
}

class RateLimits {
  private readonly counters = new Map<string, { count: number; expires: number }>();
  private nextCleanup = 0;

  allow(key: string, maximum: number, window: number, now: number): boolean {
    if (now >= this.nextCleanup) {
      for (const [name, entry] of this.counters) {
        if (entry.expires <= now) this.counters.delete(name);
      }
      this.nextCleanup = now + 60_000;
    }

    const entry = this.counters.get(key);
    if (!entry || entry.expires <= now) {
      this.counters.set(key, { count: 1, expires: now + window });
      return true;
    }
    if (entry.count >= maximum) return false;
    entry.count += 1;
    return true;
  }

  /** Gives back a unit taken by `allow` for a request that turned out not to count. */
  refund(key: string): void {
    const entry = this.counters.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }
}

export class LicenseService {
  private readonly limits = new RateLimits();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly store: LicenseStore,
    private readonly keys: SigningKeys,
    private readonly now = Date.now,
  ) {}

  private async withLicense<T>(id: string, signal: AbortSignal, callback: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const previous = this.tails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const finished = new Promise<void>(resolve => { release = resolve; });
    this.tails.set(id, finished);
    await previous;
    try {
      signal.throwIfAborted();
      return await callback();
    } finally {
      release();
      if (this.tails.get(id) === finished) this.tails.delete(id);
    }
  }

  allowActivationFrom(ip: string): boolean {
    return this.limits.allow('ip:' + sourceKey(ip), 20, hourMs, this.now());
  }

  /**
   * Takes one unit from every miss budget before a code lookup, or none if any is spent. Taking them before the
   * lookup keeps concurrent guesses from overshooting; the caller refunds them once the code is found.
   */
  private reserveMiss(source: string): (() => void) | undefined {
    const now = this.now();
    const taken: string[] = [];
    const refund = () => { for (const key of taken) this.limits.refund(key); };
    for (const { key, maximum, window } of missBudgets(source)) {
      if (!this.limits.allow(key, maximum, window, now)) {
        refund();
        return undefined;
      }
      taken.push(key);
    }
    return refund;
  }

  async handle(
    action: Action,
    input: unknown,
    signal: AbortSignal,
    identify: (id: string) => void,
    source = '',
  ) {
    signal.throwIfAborted();
    if (!isObject(input)) return failure('bad_request');

    if (action === 'activate') {
      const { code, dev, platform, pluginVersion } = input;
      if (typeof code !== 'string' || typeof dev !== 'string' || !digestPattern.test(dev) ||
          !isPlatform(platform) || typeof pluginVersion !== 'string' || !pluginVersion.trim()) {
        return failure('bad_request');
      }
      let digest: string;
      try {
        digest = codeDigest(code);
      } catch {
        return failure('bad_request');
      }
      if (!this.limits.allow('code:' + digest, 20, dayMs, this.now())) return failure('rate_limited');

      // Only a code that is found gives its units back; a failed lookup still reached Feishu, so it keeps them.
      const refundMiss = this.reserveMiss(source);
      if (!refundMiss) return failure('rate_limited');
      const matched = await this.store.findLicenseByCode(digest, signal);
      if (!matched) return failure('invalid_code');
      refundMiss();
      identify(matched.id);
      return this.withLicense(matched.id, signal, async () => {
        const license = await this.store.findLicenseById(matched.id, signal);
        if (!license || license.codeDigest !== digest) return failure('invalid_code');
        if (license.status === 'revoked') return failure('revoked');
        return this.updateDevice('activate', license, dev, platform, signal);
      });
    }

    if (typeof input.lease !== 'string') return failure('bad_request');
    let lease: Lease;
    try {
      lease = verifyLease(input.lease, this.keys.publicKeys);
    } catch {
      return failure('bad_request');
    }
    if (lease.st !== 'active') return failure('bad_request');
    identify(lease.lic);

    const renewalPlatform = action === 'renew' ? input.platform : undefined;
    if (renewalPlatform !== undefined && !isPlatform(renewalPlatform)) return failure('bad_request');
    if (!this.limits.allow(`${action}:${lease.lic}:${lease.dev}`, 5, hourMs, this.now())) return failure('rate_limited');

    return this.withLicense(lease.lic, signal, async () => {
      const license = await this.store.findLicenseById(lease.lic, signal);
      if (!license) return failure('upstream_unavailable');
      return this.updateDevice(action, license, lease.dev, renewalPlatform, signal);
    });
  }

  private async updateDevice(
    action: Action,
    license: LicenseRecord,
    dev: string,
    platform: DeviceFields['platform'] | undefined,
    signal: AbortSignal,
  ) {
    const devices = await this.store.listDevices(license.id, signal);
    signal.throwIfAborted();
    const now = Math.floor(this.now() / 1000);
    const existing = devices.find(device => device.digest === dev);
    const used = devices.filter(device => occupiesSeat(device, now)).length;
    const list = (current: DeviceUpdate[] = devices) => ({
      devices: current.filter(device => occupiesSeat(device, now)).map(device => ({
        platform: device.platform, lastRenewedAt: device.lastRenewedAt, isCurrent: device.digest === dev,
      })),
      deviceLimit: license.deviceLimit,
    });
    const success = (status: Lease['st'], current?: DeviceUpdate[]) => {
      const iat = Math.floor(this.now() / 1000);
      const payload = {
        kid: this.keys.kid, lic: license.id, dev, prd: PRODUCT, iat, rnb: iat + 7 * DAY_SECONDS,
      } as const;
      const lease = status === 'active'
        ? signLease({ ...payload, st: status, exp: iat + 30 * DAY_SECONDS }, this.keys.seed)
        : signLease({ ...payload, st: status }, this.keys.seed);
      return { status: 200, body: { lease, ...list(current) } };
    };

    if (action === 'release') {
      if (existing?.status === 'active') {
        await this.store.saveDevice({ ...existing, status: 'released' }, existing.recordId, signal);
        existing.status = 'released';
      }
      return success('released');
    }

    if (license.status === 'revoked') return success('revoked');
    if (action === 'renew' && existing?.status === 'released') return success('released');

    if ((!existing || !occupiesSeat(existing, now)) && used >= license.deviceLimit) {
      if (action === 'renew') return success('released');
      return { status: 409, body: { error: 'device_limit', ...list() } };
    }

    const currentPlatform = action === 'renew' && existing ? existing.platform : platform;
    if (currentPlatform === undefined) return { status: 400, body: { error: 'bad_request', action: 'reactivate' } };
    const updated: DeviceUpdate = {
      licenseId: license.id,
      digest: dev,
      platform: currentPlatform,
      firstActivatedAt: existing?.firstActivatedAt ?? now,
      lastRenewedAt: now,
      status: 'active',
    };
    await this.store.saveDevice(updated, existing?.recordId, signal);
    return success('active', [...devices.filter(device => device !== existing), updated]);
  }
}
