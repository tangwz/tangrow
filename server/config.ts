import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import defaultFields from './fields.json' with { type: 'json' };
import type { FeishuConfig, FieldNames } from './feishu.js';
import type { SigningKeys } from './service.js';
import { isObject } from './store.js';

function required(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error('Missing configuration field ' + key);
  return value;
}

function fieldNames<T extends Record<string, string>>(defaults: T, overrides: unknown): T {
  if (overrides === undefined) return defaults;
  if (!isObject(overrides)) throw new Error('Invalid field mapping');
  const result = { ...defaults };
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(defaults, key)) throw new Error('Unknown field mapping');
    result[key as keyof T] = required(overrides, key) as T[keyof T];
  }
  if (new Set(Object.values(result)).size !== Object.keys(result).length) throw new Error('Duplicate field mapping');
  return result;
}

function readConfig(env: NodeJS.ProcessEnv): unknown {
  const path = env.TANGROW_LICENSE_CONFIG;
  const settings = env.TANGROW_LICENSE_SETTINGS;
  if (path && settings) throw new Error('Set only one configuration source');
  if (settings) return JSON.parse(settings);
  if (!path) throw new Error('Missing license server configuration');

  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || (file.mode & 0o7777) !== 0o600) throw new Error('Configuration file must have mode 600');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally {
    closeSync(fd);
  }
}

export function loadConfig(env = process.env): {
  feishu: FeishuConfig;
  keys: SigningKeys;
  host: string;
  port: number;
  trustLoopbackProxy: boolean;
} {
  const config = readConfig(env);
  if (!isObject(config) || !isObject(config.feishu) || !isObject(config.signing) || !isObject(config.listen)) {
    throw new Error('Invalid license server configuration');
  }

  const { signing, listen, feishu } = config;
  const mappings = feishu.fields;
  if (mappings !== undefined && !isObject(mappings)) throw new Error('Invalid field mappings');
  const { id, codeDigest, status, deviceLimit } = defaultFields.license;
  const fields: FieldNames = {
    license: fieldNames({ id, codeDigest, status, deviceLimit }, mappings?.license),
    device: fieldNames(defaultFields.device, mappings?.device),
  };

  const kid = required(signing, 'kid');
  const seedHex = required(signing, 'seedHex');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(kid) || !/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new Error('Invalid signing key configuration');
  }
  const seed = Buffer.from(seedHex, 'hex');
  const key = Buffer.from(nacl.sign.keyPair.fromSeed(seed).publicKey).toString('base64url');
  const publicKeys: Record<string, string> = Object.create(null);
  if (signing.previousPublicKeys !== undefined) {
    if (!isObject(signing.previousPublicKeys)) throw new Error('Invalid previous public keys');
    for (const [previousKid, previousKey] of Object.entries(signing.previousPublicKeys)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(previousKid) || previousKid === kid || typeof previousKey !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(previousKey) || Buffer.from(previousKey, 'base64url').toString('base64url') !== previousKey) {
        throw new Error('Invalid previous public key');
      }
      publicKeys[previousKid] = previousKey;
    }
  }
  publicKeys[kid] = key;

  const host = required(listen, 'host');
  const { port, trustLoopbackProxy = false } = listen;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof trustLoopbackProxy !== 'boolean' ||
      (trustLoopbackProxy && host !== '127.0.0.1' && host !== '::1')) throw new Error('Invalid listen configuration');

  return {
    feishu: {
      appId: required(feishu, 'appId'),
      appSecret: required(feishu, 'appSecret'),
      baseToken: required(feishu, 'baseToken'),
      licenseTableId: required(feishu, 'licenseTableId'),
      deviceTableId: required(feishu, 'deviceTableId'),
      fields,
    },
    keys: { kid, seed, publicKeys },
    host, port, trustLoopbackProxy,
  };
}
