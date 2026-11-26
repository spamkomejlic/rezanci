import test from 'node:test';
import assert from 'node:assert/strict';
import { jpegSize, jpegClean, exifTime, localTime, sha256Hex } from '../public/jpeg.js';
import { tileSharpness } from '../public/quality.js';
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

test('jpegClean keeps the picture and drops the data of the phone, and refuses a file that is not complete', () => {
  const clean = s => { const out = jpegClean(hex(s)); return out && Buffer.from(out).toString('hex').toUpperCase(); };
  const text = s => Buffer.from(s, 'latin1').toString('hex').toUpperCase();
  const FRAME = 'FFC0000B0817E81FE003000000';
  const DATA = 'FFDA0002' + '1234FF00ABFFD0CDFFFF';                 // image data with a stuffed byte, a restart mark and fill
  // A record that is not color data goes (here the APP0 part of SOF). The bytes after the end marker go.
  assert.equal(clean(SOF + DATA + 'FFD9'), 'FFD8' + FRAME + DATA + 'FFD9');
  assert.equal(clean(SOF + DATA + 'FFD9' + 'DEADBEEF00'), 'FFD8' + FRAME + DATA + 'FFD9');
  assert.equal(clean(SOF + DATA + 'FFC400040000' + 'FFDA0002' + '77' + 'FFD9'), 'FFD8' + FRAME + DATA + 'FFC400040000' + 'FFDA0002' + '77' + 'FFD9');   // two scans
  // Not complete: no end marker after the image data.
  assert.equal(clean(SOF + DATA), null);                            // cut off inside the image data
  assert.equal(clean(SOF + DATA + 'FF'), null);
  assert.equal(clean(SOF), null);                                   // header only
  assert.equal(clean('FFD8' + 'FFE10006FFD90000' + FRAME + 'FFDA0002' + '1234'), null);   // end marker of a thumbnail only
  assert.equal(clean('FFD8FFD9'), null);                            // no image data
  assert.equal(clean('89504E470D0A1A0A0000'), null);

  // A camera file: record with the turn of the picture and a place, a second record, a comment, a color profile,
  // a list of more pictures, a table, the frame, the image data, and data of the phone after the end marker.
  const turned = 'FFE10022' + text('Exif') + '0000' + '49492A0008000000' + '0100' + '120103000100000006000000' + '00000000';
  const place = 'FFE1000F' + text('GPS 44.8,20.4');
  const comment = 'FFFE0009' + text('Phone X');
  const color = 'FFE20010' + text('ICC_PROFILE') + '000101', adobe = 'FFEE0009' + text('Adobe') + '0064';
  const more = 'FFE20008' + text('MPF') + '000000', table = 'FFDB00040000';
  const camera = 'FFD8' + turned + place + comment + color + adobe + more + table + FRAME + DATA + 'FFD9' + text('trailer of the phone');
  const onlyTurn = 'FFE10022' + text('Exif') + '0000' + '4D4D002A00000008' + '0001' + '011200030000000100060000' + '00000000';
  const copy = 'FFD8' + onlyTurn + color + adobe + table + FRAME + DATA + 'FFD9';
  assert.equal(clean(camera), copy);
  assert.equal(clean(copy), copy);                                  // a copy of a copy is the same file
  for (const gone of ['GPS', 'Phone X', 'MPF', 'trailer']) assert.ok(!clean(camera).includes(text(gone)), gone);
  // A file with a capture time and no turn value: the time goes, and no record is written.
  assert.equal(clean(EXIF + FRAME + DATA + 'FFD9'), 'FFD8' + FRAME + DATA + 'FFD9');
});

test('tileSharpness is high for hard edges and low for focus blur and for motion blur', () => {
  const size = 64;
  // Gray values of a tile with bars in both directions, then the same tile after a blur of "rx" by "ry" pixels.
  const bars = (x, y) => ((x >> 3) & 1) ^ ((y >> 3) & 1) ? 220 : 40;
  const tile = (rx, ry) => {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let sum = 0, count = 0;
      for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) { sum += bars(x + dx, y + dy); count++; }
      data.fill(sum / count, (y * size + x) * 4, (y * size + x) * 4 + 3);
    }
    return data;
  };
  const sharp = tileSharpness(tile(0, 0), size);
  assert.ok(sharp > 150, `sharp ${sharp}`);
  assert.ok(tileSharpness(tile(3, 3), size) < sharp * 0.5, 'focus blur');
  assert.ok(tileSharpness(tile(4, 0), size) < sharp * 0.5, 'motion blur in one direction');
  assert.equal(tileSharpness(new Uint8ClampedArray(size * size * 4).fill(128), size), 0);   // no content
});

test('exifTime reads the capture time and returns null with no EXIF block', () => {
  assert.equal(exifTime(hex(EXIF)), '2026:11:25 10:00:00');
  assert.equal(exifTime(hex(SOF)), null);
  // The same time as a number, on the clock of the phone. The gallery rule compares it with the join time.
  assert.equal(localTime(exifTime(hex(EXIF))), new Date(2026, 10, 25, 10).getTime());
  assert.ok(Number.isNaN(localTime(null)) && Number.isNaN(localTime('2026-11-25T10:00:00')));
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
