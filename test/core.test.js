import test from 'node:test';
import assert from 'node:assert/strict';
import { jpegSize, exifTime, sha256Hex } from '../public/jpeg.js';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { isCrossSite, accessClaims } from '../src/worker.js';

const hex = s => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16))).buffer;
// Smallest JPEG start: SOI, APP0, SOF0 with height 6120 and width 8160.
const SOF = 'FFD8FFE000040000FFC0000B0817E81FE003000000';
// Smallest JPEG start with an EXIF block that holds one capture time.
const EXIF = 'FFD8FFE1004845786966000049492A00080000000100' + '69870400010000001A0000000000000001000390020014000000' +
  '2C00000000000000' + '323032363A31313A32352031303A30303A303000';

test('jpegSize reads the frame size and refuses other data', () => {
  assert.deepEqual(jpegSize(hex(SOF)), { w: 8160, h: 6120 });
  assert.equal(jpegSize(hex('89504E470D0A1A0A0000')), null);
  assert.equal(jpegSize(new ArrayBuffer(0)), null);
});

test('exifTime reads the capture time and returns null with no EXIF block', () => {
  assert.equal(exifTime(hex(EXIF)), '2026:11:25 10:00:00');
  assert.equal(exifTime(hex(SOF)), null);
});

test('sha256Hex gives the known hash of empty data', async () => {
  assert.equal(await sha256Hex(new ArrayBuffer(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('isCrossSite refuses other sites and accepts the own site', () => {
  const h = o => new Headers(o), self = 'https://rezanci.net';
  assert.equal(isCrossSite(h({ 'Sec-Fetch-Site': 'same-origin' }), self), false);
  assert.equal(isCrossSite(h({ 'Sec-Fetch-Site': 'cross-site' }), self), true);
  assert.equal(isCrossSite(h({ 'Sec-Fetch-Site': 'same-site' }), self), true);
  assert.equal(isCrossSite(h({ Origin: self }), self), false);
  assert.equal(isCrossSite(h({ Origin: 'https://evil.example' }), self), true);
  assert.equal(isCrossSite(h({}), self), false);
});

test('accessClaims accepts only a valid token of this application', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }] });
  const iss = 'https://team.example', aud = 'aud-1', now = Math.floor(Date.now() / 1000);
  const sign = (o = {}) => new SignJWT('email' in o ? { email: o.email } : { email: 'mod@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(o.iss ?? iss).setAudience(o.aud ?? aud)
    .setExpirationTime(o.exp ?? now + 300).sign(o.key ?? privateKey);
  const check = async o => accessClaims(await sign(o), keys, iss, aud);

  assert.equal((await check()).email, 'mod@example.com');
  assert.equal(await check({ aud: 'other-application' }), null);
  assert.equal(await check({ iss: 'https://evil.example' }), null);
  assert.equal(await check({ exp: now - 60 }), null);
  assert.equal(await check({ key: (await generateKeyPair('RS256')).privateKey }), null);
  assert.equal(await check({ email: undefined }), null); // a service token has no email
  assert.equal(await accessClaims(await sign(), keys, iss, undefined), null); // no audience configured: refuse all
  assert.equal(await accessClaims(null, keys, iss, aud), null);
  assert.equal(await accessClaims('not.a.token', keys, iss, aud), null);
});
