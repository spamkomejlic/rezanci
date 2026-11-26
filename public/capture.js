// Operator capture screen: take a photo, check it, hash it, save it in the phone queue, send it to the archive.
// A photo leaves this phone only after the server confirms that the archive holds the same bytes.
import { $, api, boot, t, say, show, errorText } from '/ui.js';
import { jpegSize, exifTime, sha256Hex } from '/jpeg.js';
import * as queue from '/queue.js';

const MIN_PIXELS = 48e6;   // camera specification: 48 MP or more
boot();
const status = $('status'), shot = $('shot'), sync = $('sync');
let session = null;        // bag of this phone, as the server gave it
let held = [];             // photos on this phone, oldest first
let sending = false;       // one upload at a time
let wait = 0, timer = 0;   // wait before the next try after an upload that failed
const refused = new Map(); // photos that the server refused in this visit: hash and reason

function render() {
  $('label').textContent = session.label;
  $('material').textContent = t('material.' + session.material);
  $('operator').textContent = session.name;
  $('operator').hidden = false;
  $('archived').textContent = String(session.verified);
  $('capture').disabled = session.done;
  $('done-lead').textContent = t(session.done ? 'cap.done.state' : 'cap.done.lead');
  $('done').textContent = t(session.done ? 'cap.done.off' : 'cap.done.on');
  $('done').className = 'btn wide ' + (session.done ? 'ghost' : 'soft');
}

// Photos that cannot go to the archive now: their bag is closed, or this phone is in a different bag.
// The operator must see them, because they leave this phone only through their own bag.
function renderHeld() {
  const stuck = held.filter(p => !session || p.bag !== session.label);
  say($('held'), stuck.length ? t('cap.held', { n: stuck.length, bag: stuck[0].bag }) : '', 'bad');
}

// Asks the server for the bag of this phone and reports how many photos this phone holds.
// The server decides: a closed bag or a removed phone stops the work on this screen.
// With no network the screen stays as it is.
async function load() {
  const r = await api('GET', '/api/op/session?queue=' + held.length);
  if (r.ok) {
    session = r.data;
    render();
    show('main', 'work');
    say(status, '');
  } else if (r.status === 401) {
    session = null;
    $('operator').hidden = true;
    // With photos of the closed bag on this phone, the next step is that bag again, not the next bag.
    $('ended-text').textContent = (held.length && r.data.ended === 'closed' ? t('err.op_closed') : t('cap.ended.' + r.data.ended)) ?? errorText(r);
    show('main', 'ended');
    say(status, '');
  } else {
    say(status, errorText(r), 'bad');
  }
  renderHeld();
}

async function refresh() {
  held = (await queue.all()).sort((a, b) => a.saved - b.saved);
  $('count').textContent = String(held.length);
  renderHeld();
}

// Photos of the open bag that wait for the archive.
const waiting = () => held.filter(p => p.bag === session.label && !refused.has(p.sha));

// Sends the photos of this bag, oldest first. A photo stays on the phone until the server answers "verified".
async function pump() {
  clearTimeout(timer);
  if (sending || !session) return;
  sending = true;
  let problem = '';
  try {
    while (session && waiting().length) {
      const p = waiting()[0];
      say(sync, t('cap.sending', { n: waiting().length }));
      const q = new URLSearchParams({ sha: p.sha, bag: p.bag, w: p.width, h: p.height, left: held.length - 1 });
      if (p.taken) q.set('taken', p.taken);
      const r = await api('PUT', '/api/op/photo?' + q, p.blob);
      if (r.ok && r.data.verified === true && r.data.sha === p.sha) {
        await queue.remove(p.sha);              // the archive holds this photo: the copy on this phone can go
        if (session) { session.verified = r.data.count; $('archived').textContent = String(session.verified); }
        wait = 0;
        await refresh();
      } else if (r.status === 401) {
        await load();                           // bag closed or phone removed: the photos stay on this phone
      } else if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
        refused.set(p.sha, errorText(r));       // the server will not take this photo: go on with the next one
      } else {
        problem = errorText(r);                 // no network or a server fault: try again after a wait
        break;
      }
    }
  } catch (err) {
    problem = err.message;
  }
  sending = false;
  if (problem) {
    wait = Math.min(60000, Math.max(3000, wait * 2));
    timer = setTimeout(pump, wait);
  }
  if (!session) say(sync, '');
  else if (problem) say(sync, t('cap.retry', { why: problem }), 'bad');
  else if (refused.size) say(sync, t('cap.refused', { n: refused.size, why: [...refused.values()][0] }), 'bad');
  else say(sync, held.length === 0 && session.verified > 0 ? t('cap.allsent') : '', 'good');
}

async function take(file) {
  if (!session || session.done) return;
  const buf = await file.arrayBuffer();
  const size = jpegSize(buf);
  if (!size) return say(shot, t('cap.notjpeg'), 'bad');
  const mp = (size.w * size.h / 1e6).toFixed(1);
  if (size.w * size.h < MIN_PIXELS) return say(shot, t('cap.small', { mp }), 'bad');
  const sha = await sha256Hex(buf);                       // hash first, then one short storage transaction
  // The record keeps the bag of the photo. The server takes the photo only into that bag.
  await queue.put({ sha, bag: session.label, blob: file, width: size.w, height: size.h, taken: exifTime(buf), saved: Date.now() });
  say(shot, t('cap.saved', { mp, mb: (file.size / 1048576).toFixed(1) }), 'good');
  await refresh();
  pump();
}

$('capture').onclick = () => $('camera').click();
$('camera').onchange = event => {
  const file = event.target.files[0];
  event.target.value = '';                                // the same input must fire again for the next shot
  if (file) take(file).catch(err => say(shot, t('cap.notsaved', { why: err.message }), 'bad'));
};

$('done').onclick = async () => {
  $('done').disabled = true;
  const r = await api('POST', '/api/op/done', { done: !session.done, queue: held.length });
  $('done').disabled = false;
  if (r.ok) { session.done = r.data.done; render(); } else await load();
  if (!r.ok && r.status !== 401) say(status, errorText(r), 'bad');
};

// Keep the screen on at the jig. The browser drops this lock each time the page hides.
const stayAwake = () => navigator.wakeLock?.request('screen').catch(() => {});
// The moderator can close the bag or remove this phone at any time: look again while the screen is in use.
const look = async () => {
  if (document.hidden) return;
  stayAwake();
  await load();
  pump();
};

// Ask the browser not to evict the queue under storage pressure.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
await refresh().catch(err => say(shot, t('cap.queue', { why: err.message }), 'bad'));
await look();
setInterval(look, 30000);
document.addEventListener('visibilitychange', look);
addEventListener('online', pump);
