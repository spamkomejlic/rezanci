// Operator capture screen: take a photo, check it, hash it, save it in the phone queue, send it to the archive.
// A photo leaves this phone only after the server confirms that the archive holds the same bytes.
import { $, api, boot, t, say, show, errorText, keep, lastSession } from '/ui.js';
import { jpegSize, jpegClean, exifTime, localTime, sha256Hex } from '/jpeg.js';
import { measure } from '/quality.js';
import * as queue from '/queue.js';
import { scanButton } from '/scan.js';

const MIN_PIXELS = 48e6;   // camera specification: 48 MP or more
// Limits of the quality warnings. They are first values: tests with the jig and real material give the final ones.
const SHARP_LIMIT = 0.6;   // warn if the sharpness is under this share of the usual sharpness of this phone in this bag
const SHARP_AFTER = 3;     // photos of this phone in this bag before the comparison starts
const EXPOSURE_LIMIT = 0.98;   // warn if this share of the photo is pure white, or pure black
boot();
scanButton($('scan'), '/join', 'c');   // on the screen with no bag: scan the code of the next bag
const status = $('status'), shot = $('shot'), sync = $('sync');
let session = null;        // bag of this phone, as the server gave it
let held = [];             // photos on this phone, oldest first
let sending = false;       // one upload at a time
let wait = 0, timer = 0;   // wait before the next try after an upload that failed
let busy = false;          // a new photo is in the checks
let step = '';             // "Photo 2 of 5. " in front of the messages while photos from the gallery go through the checks
const refused = new Map(); // photos that the server refused in this visit: hash and reason
const previewed = new Set();   // photos whose small copy went to the server in this visit

function render() {
  $('label').textContent = session.label;
  $('material').textContent = t('material.' + session.material);
  $('operator').textContent = session.name;
  $('operator').hidden = false;
  $('archived').textContent = String(session.verified);
  $('capture').disabled = $('add').disabled = session.done || busy;
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
// With no network the screen stays as it is. After a page load with no network, the bag from the last
// contact is used: the operator can go on, and the photos wait on this phone.
async function load() {
  const r = await api('GET', '/api/op/session?queue=' + held.length);
  if (r.ok) {
    session = r.data;
    keep.set('session', JSON.stringify(session));
    if (!keep.get('since')) keep.set('since', String(Date.now()));   // a phone that joined before this value existed
    render();
    show('main', 'work');
    say(status, '');
  } else if (r.status === 401) {
    session = null;
    keep.set('session', '');
    $('operator').hidden = true;
    // With photos of the closed bag on this phone, the next step is that bag again, not the next bag.
    $('ended-text').textContent = (held.length && r.data.ended === 'closed' ? t('err.op_closed') : t('cap.ended.' + r.data.ended)) ?? errorText(r);
    show('main', 'ended');
    say(status, '');
  } else {
    if (!session && (session = lastSession())) { render(); show('main', 'work'); }
    say(status, errorText(r), 'bad');
  }
  renderHeld();
}

async function refresh() {
  held = (await queue.all()).sort((a, b) => a.saved - b.saved);
  $('count').textContent = String(held.length);
  renderHeld();
}

// Photos of the open bag that wait for the archive. A photo in the checks ("hold") waits for the operator first.
const waiting = () => held.filter(p => p.bag === session.label && !p.hold && !refused.has(p.sha));

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
      if (p.quality) for (const name of ['blur', 'clipped', 'dark']) q.set(name, p.quality[name].toFixed(4));
      if (p.flag) q.set('flag', '1');
      // The small copy for the moderator goes first, with one try. The photo never waits for it:
      // only a missing network stops the loop here, and then the photo could not go either.
      if (p.preview && !previewed.has(p.sha)) {
        const small = await api('PUT', '/api/op/preview?' + new URLSearchParams({ sha: p.sha, bag: p.bag }), p.preview);
        if (small.status === 0) { problem = errorText(small); break; }
        previewed.add(p.sha);
      }
      const r = await api('PUT', '/api/op/photo?' + q, p.blob);
      if (r.ok && r.data.verified === true && r.data.sha === p.sha) {
        await queue.remove(p.sha);              // the archive holds this photo: the copy on this phone can go
        if (session) { session.verified = r.data.count; $('archived').textContent = String(session.verified); }
        wait = 0;
        await refresh();
      } else if (r.status === 401) {
        await load();                           // bag closed or phone removed: the photos stay on this phone
        break;
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

// Sharpness scores of the earlier photos of this phone in one bag. A new photo is compared with their middle value,
// so each phone and each material has its own baseline.
const scoresOf = bag => { try { return JSON.parse(keep.get('sharp:' + bag) ?? '[]'); } catch { return []; } };
const median = list => [...list].sort((a, b) => a - b)[list.length >> 1];

// Text keys of the reasons to show this photo to the operator. An empty list means that the photo is good.
function concerns(q, usual) {
  const list = [];
  if (usual.length >= SHARP_AFTER && q.sharp < SHARP_LIMIT * median(usual)) list.push('cap.review.blur');
  if (q.clipped > EXPOSURE_LIMIT) list.push('cap.review.white');
  if (q.dark > EXPOSURE_LIMIT) list.push('cap.review.black');
  return list;
}

// Shows a part of the photo at full size and waits for the operator. Resolves to true for "keep".
function review(q, reasons) {
  $('review-why').textContent = reasons.map(key => t(key)).join(' ');
  if (q.crop) $('review-crop').getContext('2d').putImageData(q.crop, 0, 0);
  $('review').hidden = false;
  $('review').scrollIntoView({ block: 'start' });
  return new Promise(resolve => {
    $('keep').onclick = () => resolve(true);
    $('retake').onclick = () => resolve(false);
  }).finally(() => { $('review').hidden = true; });
}

// Puts one photo through the checks and into the queue. "picked" is true for a photo from the gallery.
// Returns true if the photo is in the queue, false if the operator removed it, or the text of the reason for a refusal.
async function take(file, picked) {
  if (!session || session.done) return false;
  const buf = await file.arrayBuffer();
  const size = jpegSize(buf);
  if (!size) return t('cap.notjpeg');
  const mp = (size.w * size.h / 1e6).toFixed(1);
  if (size.w * size.h < MIN_PIXELS) {
    $('gallery-box').open = true;                         // the way for a phone whose camera has no 50 MP choice here
    return t('cap.small', { mp });
  }
  // A photo from the gallery can be of a different bag. It counts only if it is newer than the moment
  // this phone joined the bag. With no known moment, no photo from the gallery counts.
  if (picked) {
    const at = localTime(exifTime(buf)) || file.lastModified;
    if (!(at >= (Number(keep.get('since')) || Infinity))) return t('cap.old');
  }
  // Only the picture leaves this phone. The data that the camera wrote into the file about the phone and the place
  // is removed here, before the hash: the archive never gets the file of the camera.
  const clean = jpegClean(buf);
  if (!clean) return t('cap.partial');
  const photo = new Blob([clean], { type: 'image/jpeg' });
  const sha = await sha256Hex(clean);                     // hash first, then one short storage transaction
  // The record keeps the bag of the photo. The server takes the photo only into that bag.
  // "hold": the photo is on the phone, and the upload waits for the quality checks.
  const record = { sha, bag: session.label, blob: photo, width: size.w, height: size.h, taken: exifTime(buf), saved: Date.now(), hold: true };
  await queue.put(record);
  const saved = t('cap.saved', { mp, mb: (photo.size / 1048576).toFixed(1) });
  say(shot, step + saved + ' ' + t('cap.checking'), 'good');
  if (!sending) say(sync, '');                            // "all photos are in the archive" is not true now
  await refresh();

  // A phone with little memory can stop the page during the decode. After two stops in a row,
  // this phone does not measure: its photos go to the archive with no quality numbers.
  let q = null;
  if (Number(keep.get('stops')) < 2) {
    keep.set('measuring', '1');
    q = await measure(photo);
    keep.set('measuring', '');
    if (q) keep.set('stops', '0');
  }
  say(shot, step + saved, 'good');
  delete record.hold;
  if (q) {
    record.quality = { blur: q.sharp, clipped: q.clipped, dark: q.dark };
    if (q.preview) record.preview = q.preview;
    const usual = scoresOf(record.bag), reasons = concerns(q, usual);
    if (!reasons.length) keep.set('sharp:' + record.bag, JSON.stringify([...usual, q.sharp].slice(-15)));
    else if (await review(q, reasons)) record.flag = 1;   // kept after a warning: the moderator sees the count
    else {
      await queue.remove(sha);                            // the operator takes the photo again
      say(shot, t('cap.retake'));
      await refresh();
      return false;
    }
  }
  await queue.put(record);
  await refresh();
  pump();
  return true;
}

// One photo at a time goes through the checks: the decode of a 50 MP photo needs much memory.
// Returns what take() returns.
async function checked(file, picked = false) {
  busy = true;
  $('capture').disabled = $('add').disabled = true;
  let result;
  try { result = await take(file, picked); } catch (err) { result = t('cap.notsaved', { why: err.message }); }
  busy = false;
  $('capture').disabled = $('add').disabled = !session || session.done;
  return result;
}

$('capture').onclick = () => $('camera').click();
$('camera').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';                                // the same input must fire again for the next shot
  const result = file && await checked(file);
  if (typeof result === 'string') say(shot, result, 'bad');
};

// Photos from the gallery: each one goes through the same checks, one after the other. The last message tells
// how many are in the queue and gives the reason for the first one that is not.
$('add').onclick = () => $('gallery').click();
$('gallery').onchange = async event => {
  const files = [...event.target.files], reasons = [];
  event.target.value = '';
  let added = 0;
  for (const [i, file] of files.entries()) {
    step = t('cap.gallery.step', { i: i + 1, n: files.length });
    say(shot, step + t('cap.checking'));
    const result = await checked(file, true);
    if (result === true) added++; else if (result) reasons.push(result);
  }
  step = '';
  if (files.length) say(shot, t('cap.gallery.done', { ok: added, bad: reasons.length }) + (reasons.length ? ' ' + reasons[0] : ''), reasons.length ? 'bad' : 'good');
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
// The page stopped during a decode: count it. A decode that works sets the count back to zero.
if (keep.get('measuring')) { keep.set('stops', String(Number(keep.get('stops')) + 1)); keep.set('measuring', ''); }
await refresh().catch(err => say(shot, t('cap.queue', { why: err.message }), 'bad'));
// A photo that was in the checks when the page closed has no decision of the operator: it goes as flagged.
for (const { hold, ...p } of held.filter(p => p.hold)) await queue.put({ ...p, flag: 1 });
await refresh().catch(() => {});
await look();
setInterval(look, 30000);
document.addEventListener('visibilitychange', look);
addEventListener('online', pump);
