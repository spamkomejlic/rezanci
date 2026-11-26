// Moderator page with the photos of the open bag: a grid of small copies, a large view, approve and reject.
// Cloudflare Access guards this path. The API gives a moderator only the photos of the bag that this moderator has open.
import { $, api, boot, t, say, errorText } from '/ui.js';

boot();
const status = $('status');
let photos = [];           // photos of the open bag in the archive, newest first, as the server gave them
let listed = '';           // server time of that list: "approve all" covers only the photos up to it
let changes = 0;           // decisions sent from this page. A list that the server made before a decision is not used.
let filter = 'all';        // all, open (no decision), flagged (flag and no decision) or rejected
let shown = '';            // photos in the grid now. The grid changes only when this changes.
let walk = [];             // photos of the large view, in the order of the grid at the moment it opened
let current = null;        // SHA-256 of the photo in the large view
let busy = false;          // a decision is on its way to the server
let loaded = false;        // the large view shows its photo. No decision is possible before that.
const tiles = new Map();   // one grid tile per photo

const GROUP = {
  all: () => true, open: p => !p.review, flagged: p => p.flagged && !p.review, rejected: p => p.review === 'rejected',
};
const PILL = { approved: 'pill good', rejected: 'pill bad', flagged: 'pill warn' };
const plain = p => !p.review && !p.flagged;   // "approve all" covers these photos
const find = sha => photos.find(p => p.sha === sha);
const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
const address = (p, size) => `/api/mod/photo?sha=${p.sha}&size=${size}`;
const caption = p => `${p.name} · ${new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

// True if the call failed. Shows the reason. A login that ended sends the moderator to the login.
function failed(r) {
  if (r.ok) return false;
  if (r.data.code === 'mod_login') location.href = '/mod/'; else say(current ? $('view-status') : status, errorText(r), 'bad');
  return true;
}

// Mark of a photo: the decision of the moderator, or the flag of the operator if there is no decision.
function setMark(pill, p) {
  const mark = p.review ?? (p.flagged ? 'flagged' : null);
  pill.hidden = !mark;
  pill.className = PILL[mark] ?? '';
  pill.textContent = mark ? t('photos.mark.' + mark) : '';
}

function tile(p) {
  const button = Object.assign(el('button', 'thumb'), { type: 'button' });
  const img = Object.assign(document.createElement('img'), { loading: 'lazy', alt: caption(p) });
  // A phone that cannot decode its photo sends no small copy. The tile shows a text, and the large view loads the stored photo.
  img.onerror = () => img.replaceWith(el('span', 'small', t('photos.nocopy')));
  img.src = address(p, 'preview');
  button.append(img, el('span', ''));
  button.onclick = () => openView(p.sha);
  return button;
}

function render() {
  for (const count of document.querySelectorAll('#filter button')) {
    count.querySelector('b').textContent = String(photos.filter(GROUP[count.dataset.show]).length);
    count.setAttribute('aria-pressed', String(count.dataset.show === filter));
  }
  $('none').hidden = photos.length > 0;
  $('approve-all').hidden = !photos.some(plain);
  for (const p of photos) {
    if (!tiles.has(p.sha)) tiles.set(p.sha, tile(p));
    setMark(tiles.get(p.sha).lastChild, p);
    tiles.get(p.sha).classList.toggle('rejected', p.review === 'rejected');
  }
  const list = photos.filter(GROUP[filter]), key = list.map(p => p.sha).join();
  if (key !== shown) { shown = key; $('grid').replaceChildren(...list.map(p => tiles.get(p.sha))); }
  view();
}

// Large view of the current photo. With no current photo the view is closed.
function view() {
  const p = find(current), img = $('view-img');
  $('viewer').hidden = !p;
  if (!p) {
    current = null;
    delete img.dataset.sha;
    img.removeAttribute('src');
    return;
  }
  if (img.dataset.sha !== p.sha) {
    // The photo before this one must not stay on the screen under the name of this one: hide it until this one shows.
    loaded = false;
    img.dataset.sha = p.sha;
    img.alt = caption(p);
    img.classList.add('loading');
    img.onload = () => { loaded = true; img.classList.remove('loading'); view(); };
    img.onerror = () => {   // no small copy: the stored photo. If that fails too, the view says so.
      img.onerror = () => say($('view-status'), t('photos.noload'), 'bad');
      img.src = address(p, 'full');
    };
    img.src = address(p, 'preview');
    say($('view-status'), '');
  }
  const at = walk.indexOf(p.sha);
  $('view-who').textContent = `${at + 1} / ${walk.length} · ${caption(p)}`;
  setMark($('view-mark'), p);
  $('view-facts').textContent = [`${p.width} × ${p.height}`, `${(p.bytes / 1048576).toFixed(1)} MB`, p.flagged && t('photos.flagnote')]
    .filter(Boolean).join(' · ');
  $('view-full').href = address(p, 'full');
  $('view-prev').disabled = at <= 0;
  $('view-next').disabled = at >= walk.length - 1;
  $('view-approve').disabled = $('view-reject').disabled = busy || !loaded;
}

function openView(sha) {
  walk = photos.filter(GROUP[filter]).map(p => p.sha);
  current = sha;
  history.pushState({ view: true }, '');   // the Back button of the phone then closes the large view, not the page
  view();
  $('view-close').focus();
}

// The check is complete when no photo is left with no decision: the page goes back to the bag screen.
// The list is read again first, so a photo that came in the meantime keeps the moderator here.
const complete = () => photos.length > 0 && !photos.some(p => !p.review);
async function leaveIfComplete() {
  if (!complete()) return false;
  await load();
  if (complete()) location.href = '/mod/';
  return complete();
}

function step(by) {
  const next = walk[walk.indexOf(current) + by];
  if (next) { current = next; view(); }
}

async function decide(decision) {
  const sha = current;
  if (!sha || busy || !loaded) return;
  busy = true;
  view();
  const r = await api('POST', '/api/mod/photo/review', { sha, decision });
  busy = false;
  const p = find(sha);
  if (!failed(r) && p) {
    changes++;
    say($('view-status'), '');
    const first = !p.review;
    p.review = r.data.review;
    // After the first decision for a photo, the view goes on to the next photo with no decision.
    const next = first && walk.slice(walk.indexOf(sha) + 1).find(other => !find(other)?.review);
    if (next && current === sha) current = next;
    // Only a first decision can end the check. A changed decision keeps the moderator on the page.
    if (first && await leaveIfComplete()) return;
  }
  render();
}

async function load() {
  const before = changes;
  const r = await api('GET', '/api/mod/photos');
  if (before !== changes) return;                                // a decision went out in the meantime: this list is old
  if (r.status === 0) return say(status, errorText(r), 'bad');   // no network: the page stays as it is
  if (!r.ok) {                                                   // no open bag, or the login ended
    $('work').hidden = true;
    current = null;
    view();
    return failed(r);
  }
  if (status.classList.contains('bad')) say(status, '');
  ({ at: listed, photos } = r.data);
  $('label').textContent = r.data.label;
  $('work').hidden = false;
  render();
}

for (const count of document.querySelectorAll('#filter button')) count.onclick = () => { filter = count.dataset.show; render(); };
$('approve-all').onclick = async () => {
  if (!confirm(t('photos.approveall.ask', { n: photos.filter(plain).length }))) return;
  const r = await api('POST', '/api/mod/photo/review', { all: true, until: listed });
  if (failed(r)) return;
  changes++;
  if (await leaveIfComplete()) return;
  await load();
  say(status, t('photos.approveall.done', { n: r.data.reviewed }), 'good');
};
$('view-approve').onclick = () => decide('approved');
$('view-reject').onclick = () => decide('rejected');
$('view-prev').onclick = () => step(-1);
$('view-next').onclick = () => step(1);
$('view-close').onclick = () => history.back();
addEventListener('popstate', () => { current = null; view(); });
addEventListener('keydown', event => {
  if (!current) return;
  if (event.key === 'Escape') history.back();
  if (event.key === 'ArrowLeft') step(-1);
  if (event.key === 'ArrowRight') step(1);
});

await load();
setInterval(() => { if (!document.hidden) load(); }, 15000);   // new photos of the phones show in the grid
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
