export const platforms = ['macOS', 'Windows', 'Linux', 'iOS', 'Android'] as const;
export type Platform = typeof platforms[number];

export function isPlatform(value: unknown): value is Platform {
  return platforms.some(platform => platform === value);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const licenseIdPattern = /^[0-9a-f]{32}$/;
export const digestPattern = /^[0-9a-f]{64}$/;

export interface LicenseRecord {
  id: string;
  codeDigest: string;
  status: 'active' | 'revoked';
  deviceLimit: number;
}

export interface DeviceFields {
  licenseId: string;
  digest: string;
  platform: Platform;
  firstActivatedAt: number;
  lastRenewedAt: number;
  status: 'active' | 'released';
}

export interface DeviceRecord extends DeviceFields {
  recordId: string;
}

export interface LicenseStore {
  findLicenseByCode(digest: string, signal: AbortSignal): Promise<LicenseRecord | undefined>;
  findLicenseById(id: string, signal: AbortSignal): Promise<LicenseRecord | undefined>;
  listDevices(id: string, signal: AbortSignal): Promise<DeviceRecord[]>;
  saveDevice(device: DeviceFields, recordId: string | undefined, signal: AbortSignal): Promise<void>;
}
