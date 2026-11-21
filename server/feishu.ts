import defaultFields from './fields.json' with { type: 'json' };
import { digestPattern, isObject, isPlatform, licenseIdPattern } from './store.js';
import type { DeviceFields, DeviceRecord, LicenseRecord, LicenseStore } from './store.js';

export interface FieldNames {
  license: Pick<typeof defaultFields.license, 'id' | 'codeDigest' | 'status' | 'deviceLimit'>;
  device: typeof defaultFields.device;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  baseToken: string;
  licenseTableId: string;
  deviceTableId: string;
  fields: FieldNames;
}

const api = 'https://open.feishu.cn/open-apis';
const status = defaultFields.status;

function invalidData(): never {
  throw new Error('Invalid Feishu data');
}

function textField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.every(part => isObject(part) && typeof part.text === 'string')) {
    return invalidData();
  }
  return value.map(part => part.text).join('');
}

function seconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalidData();
  return Math.floor(value / 1000);
}

/** Of two rows for one device, keep the most recent renewal; on a tie, a release wins. */
function newerDevice(candidate: DeviceRecord, current: DeviceRecord): boolean {
  return candidate.lastRenewedAt > current.lastRenewedAt ||
    (candidate.lastRenewedAt === current.lastRenewedAt && candidate.status === 'released' && current.status !== 'released');
}

interface Row {
  recordId: string;
  fields: Record<string, unknown>;
}

export class FeishuStore implements LicenseStore {
  private cachedToken?: { value: string; validUntil: number };
  private tokenRequest?: Promise<string>;

  constructor(
    private readonly config: FeishuConfig,
    private readonly fetcher = fetch,
    private readonly now = Date.now,
  ) {}

  private async call(url: string, method: 'POST' | 'PUT', body: object, signal: AbortSignal, token?: string) {
    signal.throwIfAborted();
    const response = await this.fetcher(url, {
      method,
      signal,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Feishu HTTP error');
    }
    const data: unknown = await response.json();
    if (!isObject(data) || data.code !== 0) throw new Error('Feishu API error');
    return data;
  }

  private async refreshToken(): Promise<string> {
    const data = await this.call(api + '/auth/v3/tenant_access_token/internal', 'POST', {
      app_id: this.config.appId, app_secret: this.config.appSecret,
    }, AbortSignal.timeout(10_000));
    const { tenant_access_token: token, expire } = data;
    if (typeof token !== 'string' || !token || typeof expire !== 'number' ||
        !Number.isSafeInteger(expire) || expire <= 0) return invalidData();
    this.cachedToken = { value: token, validUntil: this.now() + Math.max(0, Math.min(expire, 7200) - 60) * 1000 };
    return token;
  }

  private tenantToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.validUntil > this.now()) return Promise.resolve(this.cachedToken.value);
    this.tokenRequest ??= this.refreshToken().finally(() => { this.tokenRequest = undefined; });
    return this.tokenRequest;
  }

  private recordsUrl(tableId: string): string {
    return api + '/bitable/v1/apps/' + encodeURIComponent(this.config.baseToken) +
      '/tables/' + encodeURIComponent(tableId) + '/records';
  }

  private async search(tableId: string, fields: string[], field: string, value: string, signal: AbortSignal): Promise<Row[]> {
    const token = await this.tenantToken();
    const rows: Row[] = [];
    const seenPages = new Set<string>();
    let pageToken: string | undefined;
    do {
      const url = new URL(this.recordsUrl(tableId) + '/search');
      url.searchParams.set('page_size', '500');
      if (pageToken) url.searchParams.set('page_token', pageToken);
      const { data } = await this.call(url.toString(), 'POST', {
        field_names: fields,
        filter: { conjunction: 'and', conditions: [{ field_name: field, operator: 'is', value: [value] }] },
      }, signal, token);
      if (!isObject(data) || typeof data.has_more !== 'boolean') return invalidData();
      const items = data.items ?? [];
      if (!Array.isArray(items)) return invalidData();
      for (const item of items) {
        if (!isObject(item) || !isObject(item.fields) || typeof item.record_id !== 'string' || !item.record_id) {
          return invalidData();
        }
        rows.push({ recordId: item.record_id, fields: item.fields });
      }
      pageToken = undefined;
      if (data.has_more) {
        if (typeof data.page_token !== 'string' || !data.page_token || seenPages.has(data.page_token)) return invalidData();
        pageToken = data.page_token;
        seenPages.add(pageToken);
      }
    } while (pageToken);
    return rows;
  }

  private async findLicense(field: string, value: string, signal: AbortSignal): Promise<LicenseRecord | undefined> {
    const names = this.config.fields.license;
    const rows = await this.search(this.config.licenseTableId, Object.values(names), field, value, signal);
    if (!rows.length) return undefined;
    if (rows.length !== 1) return invalidData();
    const fields = rows[0]!.fields;
    const id = textField(fields[names.id]);
    const codeDigest = textField(fields[names.codeDigest]);
    const deviceLimit = fields[names.deviceLimit];
    const choice = fields[names.status];
    if (!licenseIdPattern.test(id) || !digestPattern.test(codeDigest) || textField(fields[field]) !== value ||
        typeof deviceLimit !== 'number' || !Number.isSafeInteger(deviceLimit) || deviceLimit < 0 ||
        (choice !== status.active && choice !== status.revoked)) return invalidData();
    return { id, codeDigest, deviceLimit, status: choice === status.active ? 'active' : 'revoked' };
  }

  findLicenseByCode(digest: string, signal: AbortSignal) {
    return this.findLicense(this.config.fields.license.codeDigest, digest, signal);
  }

  findLicenseById(id: string, signal: AbortSignal) {
    return this.findLicense(this.config.fields.license.id, id, signal);
  }

  async listDevices(id: string, signal: AbortSignal): Promise<DeviceRecord[]> {
    const names = this.config.fields.device;
    const rows = await this.search(this.config.deviceTableId, Object.values(names), names.licenseId, id, signal);
    // A create that timed out after Feishu stored it can leave a second row for the same device.
    const devices = new Map<string, DeviceRecord>();
    for (const { recordId, fields } of rows) {
      const licenseId = textField(fields[names.licenseId]);
      const digest = textField(fields[names.digest]);
      const platform = fields[names.platform];
      const choice = fields[names.status];
      if (licenseId !== id || !digestPattern.test(digest) || !isPlatform(platform) ||
          (choice !== status.active && choice !== status.released)) return invalidData();
      const device: DeviceRecord = {
        recordId, licenseId, digest, platform,
        firstActivatedAt: seconds(fields[names.firstActivatedAt]),
        lastRenewedAt: seconds(fields[names.lastRenewedAt]),
        status: choice === status.active ? 'active' : 'released',
      };
      const current = devices.get(digest);
      if (!current || newerDevice(device, current)) devices.set(digest, device);
    }
    return [...devices.values()];
  }

  async saveDevice(device: DeviceFields, recordId: string | undefined, signal: AbortSignal): Promise<void> {
    const names = this.config.fields.device;
    const url = new URL(this.recordsUrl(this.config.deviceTableId) +
      (recordId ? '/' + encodeURIComponent(recordId) : ''));
    const fields = {
      [names.platform]: device.platform,
      [names.lastRenewedAt]: device.lastRenewedAt * 1000,
      [names.status]: status[device.status],
    };
    if (!recordId) {
      // No client_token: a token reused for one device can replay a row that was deleted since, so the device
      // would get a lease without a counted seat. listDevices tolerates the rare duplicate this allows instead.
      Object.assign(fields, {
        [names.licenseId]: device.licenseId,
        [names.digest]: device.digest,
        [names.firstActivatedAt]: device.firstActivatedAt * 1000,
      });
    }

    const token = await this.tenantToken();
    const { data } = await this.call(url.toString(), recordId ? 'PUT' : 'POST', { fields }, signal, token);
    if (!isObject(data) || !isObject(data.record) || typeof data.record.record_id !== 'string' ||
        !data.record.record_id || (recordId && data.record.record_id !== recordId)) return invalidData();
  }
}
