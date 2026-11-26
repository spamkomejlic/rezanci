// Moderator page with the state of each bag of one location: not opened, open or closed, with its photo counts.
import { $, api, boot, t, say, errorText, keep } from '/ui.js';

boot();
const status = $('status');
let bags = [];             // bags of the selected location, as the server gave them
let filter = 'all';        // all, new, open or closed

// True if the call failed. Shows the reason. A login that ended sends the moderator to the login.
function failed(r) {
  if (r.ok) return false;
  if (r.data.code === 'mod_login') location.href = '/mod/'; else say(status, errorText(r), 'bad');
  return true;
}

const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text });
// A force close is one kind of close: the filter has one group for both, the row shows which one it was.
const group = bag => bag.state === 'forced' ? 'closed' : bag.state;
const time = at => new Date(at).toLocaleString([], { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const PILL = { new: 'pill plain', open: 'pill warn', closed: 'pill good', forced: 'pill bad' };

function render() {
  for (const tile of document.querySelectorAll('#filter button')) {
    const state = tile.dataset.state;
    tile.querySelector('b').textContent = String(bags.filter(b => state === 'all' || group(b) === state).length);
    tile.setAttribute('aria-pressed', String(state === filter));
  }
  $('none').hidden = bags.length > 0;
  $('bags').replaceChildren(...bags.filter(b => filter === 'all' || group(b) === filter).map(b => {
    // Facts of a bag that was opened: photos, problems, who has it open, time of the last change.
    const facts = b.state === 'new' ? [] : [
      t('bags.photos', { n: b.photos }), b.flagged && t('bags.flagged', { n: b.flagged }), b.missing && t('bags.missing', { n: b.missing }),
      b.sessions > 1 && t('bags.sessions', { n: b.sessions }), b.state === 'open' && b.moderator, time(b.at)];
    const info = el('span', '');
    info.append(el('b', 'mono', b.label), el('span', 'muted small', facts.filter(Boolean).join(' · ')));
    const link = Object.assign(el('a', 'bagrow'), { href: `/mod/#bag=${b.label}` });
    link.append(info, el('span', PILL[b.state], t('bags.state.' + b.state)));
    const row = document.createElement('li');
    row.append(link);
    return row;
  }));
}

async function load() {
  if (!$('location').value) return render();
  const r = await api('GET', '/api/mod/bags?location=' + encodeURIComponent($('location').value));
  if (r.status === 0) return say(status, errorText(r), 'bad');   // no network: the list stays as it is
  if (failed(r)) return;
  say(status, '');
  bags = r.data.bags;
  render();
}

for (const tile of document.querySelectorAll('#filter button')) tile.onclick = () => { filter = tile.dataset.state; render(); };
$('location').onchange = () => { keep.set('location', $('location').value); load(); };

const r = await api('GET', '/api/mod/locations');
if (!failed(r)) {
  $('location').replaceChildren(...r.data.locations.map(l =>
    Object.assign(document.createElement('option'), { value: l.code, textContent: `${l.code} · ${l.name}` })));
  // The page opens with the location that this moderator looked at last.
  if (r.data.locations.some(l => l.code === keep.get('location'))) $('location').value = keep.get('location');
  await load();
  setInterval(() => { if (!document.hidden) load(); }, 20000);   // the overview follows the work
}
