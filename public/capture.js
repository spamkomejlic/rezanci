// Operator capture screen. This version does the phone half of the loop:
// take photo, check, hash, save in the queue. Upload comes with the session endpoints.
import { jpegSize, exifTime, sha256Hex } from '/jpeg.js';
import * as queue from '/queue.js';

const MIN_PIXELS = 48e6;   // camera specification: 48 MP or more
const $ = id => document.getElementById(id);
const say = (text, bad = false) => { $('status').textContent = text; $('status').className = bad ? 'bad' : 'good'; };

async function refresh() {
  const photos = await queue.all();
  $('count').textContent = String(photos.length);
  const mb = photos.reduce((n, p) => n + p.blob.size, 0) / 1048576;
  $('size').textContent = mb.toFixed(1);
}

async function take(file) {
  const buf = await file.arrayBuffer();
  const size = jpegSize(buf);
  if (!size) return say('Not a JPEG photo. Take the photo again.', true);
  const mp = (size.w * size.h / 1e6).toFixed(1);
  if (size.w * size.h < MIN_PIXELS)
    return say(`Photo is ${mp} MP. Select the 50 MP mode in the camera and take the photo again.`, true);
  const sha = await sha256Hex(buf);                       // hash first, then one short storage transaction
  await queue.put({ sha, blob: file, width: size.w, height: size.h, taken: exifTime(buf), saved: Date.now() });
  say(`Saved on phone: ${mp} MP, ${(file.size / 1048576).toFixed(1)} MB.`);
  await refresh();
}

$('capture').onclick = () => $('camera').click();
$('camera').onchange = e => {
  const file = e.target.files[0];
  e.target.value = '';                                    // the same input must fire again for the next shot
  if (file) take(file).catch(err => say(`Not saved: ${err.message}. Take the photo again.`, true));
};

// Test help for this version only: empties the queue. The real app deletes a photo after the server confirms it.
$('clear').onclick = async () => {
  for (const p of await queue.all()) await queue.remove(p.sha);
  say('Test photos removed from this phone.');
  await refresh();
};

// Ask the browser not to evict the queue under storage pressure.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
refresh().catch(err => say(`Queue not available: ${err.message}`, true));
