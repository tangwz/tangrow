import { createHash } from 'node:crypto';
import { codeDigest, DAY_SECONDS, PRODUCT, signLease, verifyLease } from '../src/license/format.js';
import type { Lease, PublicKeys } from '../src/license/format.js';
import { digestPattern, isObject, isPlatform } from './store.js';
import type { DeviceFields, LicenseRecord, LicenseStore } from './store.js';

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

function occupiesSeat(device: DeviceFields, now: number) {
  return device.status === 'active' && device.lastRenewedAt > now - seatWindow;
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
    return this.limits.allow('ip:' + ip, 20, hourMs, this.now());
  }

  async handle(
    action: Action,
    input: unknown,
    signal: AbortSignal,
    identify: (id: string) => void,
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
      if (!this.limits.allow('code:' + digest, 20, 24 * hourMs, this.now())) return failure('rate_limited');

      const matched = await this.store.findLicenseByCode(digest, signal);
      if (!matched) return failure('invalid_code');
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
    // Each lease gets its own budget per action, so retried renewals never block a release.
    const leaseDigest = createHash('sha256').update(input.lease).digest('hex');
    if (!this.limits.allow(action + ':' + leaseDigest, 5, hourMs, this.now())) return failure('rate_limited');

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
    const list = (current: DeviceFields[] = devices) => ({
      devices: current.filter(device => occupiesSeat(device, now)).map(device => ({
        platform: device.platform, lastRenewedAt: device.lastRenewedAt, isCurrent: device.digest === dev,
      })),
      deviceLimit: license.deviceLimit,
    });
    const success = (status: Lease['st'], current?: DeviceFields[]) => {
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

    const currentPlatform = action === 'renew' ? existing?.platform ?? platform : platform;
    if (!currentPlatform) return { status: 400, body: { error: 'bad_request', action: 'reactivate' } };
    const updated: DeviceFields = {
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
