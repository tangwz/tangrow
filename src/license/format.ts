import nacl from 'tweetnacl';
import { hash } from 'fast-sha256';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PRODUCT = 'tangrow-local-lifetime';
export const DAY_SECONDS = 86400;
export type RandomBytes = (size: number) => Uint8Array;
export const randomBytes: RandomBytes = size => globalThis.crypto.getRandomValues(new Uint8Array(size));
export const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

export function generateCode(random: RandomBytes = randomBytes): string {
  const bytes = random(10);
  if (bytes.length !== 10) throw new Error('Invalid entropy length');
  const bits = Array.from(bytes, byte => byte.toString(2).padStart(8, '0')).join('');
  const code = bits.match(/.{5}/g)!.map(group => alphabet[parseInt(group, 2)]).join('');
  return `TGRW-${code.match(/.{4}/g)!.join('-')}`;
}

export function normalizeCode(input: string): string {
  let code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length === 20 && code.startsWith('TGRW')) code = code.slice(4);
  code = code.replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(code)) throw new Error('Invalid code');
  return code;
}

const digest = (text: string) => hex(hash(new TextEncoder().encode(text)));
export const codeDigest = (code: string) => digest('tangrow-code:v1:' + normalizeCode(code));
export function deviceDigest(id: string): string {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new Error('Invalid device ID');
  return digest('tangrow-device:v1:' + id);
}

export type PublicKeys = Readonly<Record<string, string>>;
export type Lease = { kid: string; lic: string; dev: string; prd: typeof PRODUCT; iat: number; rnb: number } &
  ({ st: 'active'; exp: number } | { st: 'released' | 'revoked'; exp?: never });

function check(payload: Lease): Lease {
  if (!payload || typeof payload.kid !== 'string' || !payload.kid || payload.prd !== PRODUCT ||
    typeof payload.lic !== 'string' || !/^[0-9a-f]{32}$/.test(payload.lic) ||
    typeof payload.dev !== 'string' || !/^[0-9a-f]{64}$/.test(payload.dev) ||
    !Number.isSafeInteger(payload.iat * 1000) || !Number.isSafeInteger(payload.iat) || payload.iat < 0 ||
    payload.rnb !== payload.iat + 7 * DAY_SECONDS ||
    !(payload.st === 'active' ? payload.exp === payload.iat + 30 * DAY_SECONDS :
      (payload.st === 'released' || payload.st === 'revoked') && payload.exp === undefined)) throw new Error('Invalid lease payload');
  return payload;
}

const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function decode(text: string): Uint8Array {
  if (!/^[\w-]+$/.test(text)) throw new Error('Invalid base64url');
  const bytes = Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  if (encode(bytes) !== text) throw new Error('Invalid base64url');
  return bytes;
}

export function signLease(payload: Lease, seed: Uint8Array): string {
  const bytes = new TextEncoder().encode(JSON.stringify(check(payload)));
  return `v1.${encode(bytes)}.${encode(nacl.sign.detached(bytes, nacl.sign.keyPair.fromSeed(seed).secretKey))}`;
}

export function verifyLease(token: string, keys: PublicKeys): Lease {
  const parts = token.split('.');
  if (token.length > 4096 || parts.length !== 3 || parts[0] !== 'v1') throw new Error('Invalid lease');
  const bytes = decode(parts[1]!);
  const payload = check(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const signature = decode(parts[2]!);
  const scalar = BigInt('0x' + (hex(signature.slice(32).reverse()) || '0'));
  if (!Object.hasOwn(keys, payload.kid) || signature.length !== 64 || scalar >= (1n << 252n) + 27742317777372353535851937790883648493n ||
    !nacl.sign.detached.verify(bytes, signature, decode(keys[payload.kid]!))) throw new Error('Invalid signature');
  return payload;
}
