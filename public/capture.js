// Operator capture screen. This version does the phone half of the loop:
// take photo, check, hash, save in the phone queue. Upload comes with the next version.
import { $, api, boot, t, say, show, errorText } from '/ui.js';
import { jpegSize, exifTime, sha256Hex } from '/jpeg.js';
import * as queue from '/queue.js';

const MIN_PIXELS = 48e6;   // camera specification: 48 MP or more
boot();
const status = $('status'), shot = $('shot');
let session = null;        // bag of this phone, as the server gave it

function render() {
  $('label').textContent = session.label;
  $('material').textContent = t('material.' + session.material);
  $('operator').textContent = session.name;
  $('operator').hidden = false;
  $('capture').disabled = session.done;
  $('done-lead').textContent = t(session.done ? 'cap.done.state' : 'cap.done.lead');
  $('done').textContent = t(session.done ? 'cap.done.off' : 'cap.done.on');
  $('done').className = 'btn wide ' + (session.done ? 'ghost' : 'soft');
}

// Asks the server for the bag of this phone. The server decides: a closed bag or a removed phone
// stops the work on this screen. With no network the screen stays as it is.
async function load() {
  const r = await api('GET', '/api/op/session');
  if (r.ok) {
    session = r.data;
    render();
    show('main', 'work');
    say(status, '');
  } else if (r.status === 401) {
    session = null;
    $('operator').hidden = true;
    $('ended-text').textContent = t('cap.ended.' + r.data.ended) ?? errorText(r);
    show('main', 'ended');
    say(status, '');
  } else {
    say(status, errorText(r), 'bad');
  }
}

async function refresh() {
  const photos = await queue.all();
  $('count').textContent = String(photos.length);
  $('size').textContent = (photos.reduce((n, p) => n + p.blob.size, 0) / 1048576).toFixed(1);
}

async function take(file) {
  const buf = await file.arrayBuffer();
  const size = jpegSize(buf);
  if (!size) return say(shot, t('cap.notjpeg'), 'bad');
  const mp = (size.w * size.h / 1e6).toFixed(1);
  if (size.w * size.h < MIN_PIXELS) return say(shot, t('cap.small', { mp }), 'bad');
  const sha = await sha256Hex(buf);                       // hash first, then one short storage transaction
  await queue.put({ sha, blob: file, width: size.w, height: size.h, taken: exifTime(buf), saved: Date.now() });
  say(shot, t('cap.saved', { mp, mb: (file.size / 1048576).toFixed(1) }), 'good');
  await refresh();
}

$('capture').onclick = () => $('camera').click();
$('camera').onchange = event => {
  const file = event.target.files[0];
  event.target.value = '';                                // the same input must fire again for the next shot
  if (file) take(file).catch(err => say(shot, t('cap.notsaved', { why: err.message }), 'bad'));
};

$('done').onclick = async () => {
  $('done').disabled = true;
  const r = await api('POST', '/api/op/done', { done: !session.done });
  $('done').disabled = false;
  if (r.ok) { session.done = r.data.done; render(); } else await load();
  if (!r.ok && r.status !== 401) say(status, errorText(r), 'bad');
};

// Test help for this version only: empties the queue. The real app deletes a photo after the server confirms it.
$('clear').onclick = async () => {
  for (const p of await queue.all()) await queue.remove(p.sha);
  say(shot, t('cap.cleared'));
  await refresh();
};

// Ask the browser not to evict the queue under storage pressure.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
refresh().catch(err => say(shot, t('cap.queue', { why: err.message }), 'bad'));
await load();
// The moderator can close the bag or remove this phone at any time: look again while the screen is in use.
setInterval(() => { if (!document.hidden) load(); }, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
