import assert from 'node:assert/strict';
import test from 'node:test';
import vector from './fixtures/license-vectors.json';
import { codeDigest, deviceDigest, generateCode, normalizeCode, signLease, verifyLease, type Lease } from '../src/license/format';

test('card text and scoped digests match the shared wire vectors', () => {
  assert.equal(normalizeCode(vector.code), vector.normalized);
  assert.equal(codeDigest(vector.code), vector.codeDigest);
  assert.equal(deviceDigest(vector.deviceId), vector.deviceDigest);
  assert.equal(generateCode(size => new Uint8Array(size).fill(255)), 'TGRW-ZZZZ-ZZZZ-ZZZZ-ZZZZ');
  assert.equal(normalizeCode('TGRW000000000000'), 'TGRW000000000000');
  assert.throws(() => normalizeCode('U'.repeat(16)));
});

test('independent Ed25519 vector matches exact UTF-8 payload bytes', () => {
  const keys = { 'test-1': vector.publicKey };
  assert.equal(signLease(vector.payload as Lease, Buffer.from(vector.seedHex, 'hex')), vector.lease);
  assert.deepEqual(verifyLease(vector.lease, keys), vector.payload);
  const [, payload, signature] = vector.lease.split('.');
  const modified = Buffer.from(JSON.stringify({ ...vector.payload, lic: 'f'.repeat(32) })).toString('base64url');
  for (const token of [`v1.${modified}.${signature}`, `v1.${payload}.${'A'.repeat(86)}`, `${vector.lease}=`, `v2.${payload}.${signature}`]) {
    assert.throws(() => verifyLease(token, keys));
  }
  assert.throws(() => verifyLease(vector.lease, {}));
});
