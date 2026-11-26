// Moderator screen: open a bag, show the one-time code for phones, watch the phones and their photos, close the bag.
// Cloudflare Access guards this path. The API checks the login again on each call.
import { $, api, boot, t, say, show, errorText } from '/ui.js';
import { drawQr } from '/qr.js';
import { scanButton } from '/scan.js';

boot();
scanButton($('scan'), '/mod/', 'bag');   // a scanned label changes the address, and the page opens that bag
const status = $('status');
const CODE_LIFE = 115;     // seconds that one code stays on the screen. The server accepts a code for 120 seconds.
const bagFromAddress = () => new URLSearchParams(location.hash.slice(1)).get('bag');

let session = null;        // open bag of this moderator, as the server gave it
let wanted = bagFromAddress();   // label from a scanned bag code: /mod/#bag=<label>
let asked = null;          // label for which the page asked the server about earlier contents
let fixed = null;          // contents of that bag from its first opening. Null: the bag was never opened.
let code = null;           // code on the screen: { until: time on this phone, phones: phone count at issue }
let codeBusy = false, lastPhones = '', offline = false;

// True if the call failed. Shows the reason. A login that ended gets its own screen.
function failed(r) {
  if (r.ok) return false;
  if (r.data.code === 'mod_login') show('main', 'login'); else say(status, errorText(r), 'bad');
  return true;
}
const forgetWanted = () => { wanted = asked = fixed = null; history.replaceState(null, '', location.pathname); showFixed(); };

// The contents of a bag are set one time, when it opens the first time. For a bag that was open before,
// the form shows them with no choice and asks for the reason to open the bag again.
function showFixed() {
  $('material-choice').hidden = fixed !== null;
  $('material-fixed').hidden = $('reason-field').hidden = fixed === null;
  $('material-fixed').textContent = fixed ? t('mod.open.fixed', { material: t('material.' + fixed) }) : '';
}
async function lookAtWanted() {
  if (!wanted || asked === wanted) return;
  const label = asked = wanted;
  fixed = null;
  showFixed();
  const r = await api('GET', '/api/mod/bag?label=' + encodeURIComponent(label));
  if (label !== wanted) return;                       // the moderator went on to a different bag
  if (r.ok) { fixed = r.data.material; showFixed(); }
  else if (r.status === 0) asked = null;              // no network: the next look at the server tries again
  else failed(r);                                     // not a printed label
}

async function refresh() {
  const r = await api('GET', '/api/mod/session');
  if (r.status === 0) { offline = true; say(status, errorText(r), 'bad'); return; }
  if (offline) { offline = false; say(status, ''); }
  if (failed(r)) return;
  session = r.data.session;
  render();
}

function render() {
  if (!session) {
    code = null; lastPhones = '';
    if (wanted) { $('open-label').textContent = wanted; show('main', 'open'); lookAtWanted(); } else show('main', 'idle');
    return;
  }
  show('main', 'bag');
  if (wanted && wanted !== session.label) say(status, t('mod.open.other', { label: wanted }), 'bad');
  if (wanted) forgetWanted();
  $('label').textContent = session.label;
  $('material').textContent = t('material.' + session.material);
  $('opened').textContent = t('mod.bag.opened', { time: new Date(session.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  const phones = JSON.stringify(session.phones);
  if (phones !== lastPhones) { lastPhones = phones; renderPhones(); }
  // Photo counts of the whole bag, with its earlier openings. The check screen (/mod/photos) shows the photos.
  const { verified, approved, rejected } = session.photos;
  $('photos-counts').textContent = t('mod.photos.counts', { v: verified, u: verified - approved - rejected, r: rejected });
  renderClose();
  // A phone used the code, or the code is old: show a new one.
  if (!code || code.phones !== session.phones.length || Date.now() >= code.until) newCode();
}

function renderPhones() {
  $('phones-none').hidden = session.phones.length > 0;
  $('phones').replaceChildren(...session.phones.map(p => {
    const name = Object.assign(document.createElement('div'), { className: 'name', textContent: p.name });
    const counts = Object.assign(document.createElement('div'), {
      className: 'muted small',
      textContent: [t('mod.phone.images', { v: p.verified, q: p.queue }), p.flagged && t('mod.phone.flagged', { n: p.flagged }),
        !p.removed_at && p.silent >= 2 && t('mod.phone.silent', { m: p.silent })].filter(Boolean).join(' · '),
    });
    const info = Object.assign(document.createElement('div'), { className: 'grow' });
    info.append(name, counts);
    const pill = Object.assign(document.createElement('span'), {
      className: 'pill ' + (p.removed_at ? 'bad' : p.done_at ? 'good' : 'warn'),
      textContent: t(p.removed_at ? 'mod.phone.removed' : p.done_at ? 'mod.phone.done' : 'mod.phone.working'),
    });
    const row = document.createElement('li');
    row.append(info, pill);
    if (!p.removed_at) {
      const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'btn ghost small', textContent: t('mod.phone.remove') });
      remove.onclick = async () => {
        if (!confirm(t('mod.phone.remove.ask', { name: p.name }))) return;
        failed(await api('POST', '/api/mod/phone/remove', { id: p.id }));
        await refresh();
      };
      row.append(remove);
    }
    return row;
  }));
}

// The close rule comes from the server: each phone Done, each photo in the archive, each flagged photo decided.
function renderClose() {
  const blocked = session.blockers.length > 0;
  $('close-lead').textContent = t(blocked ? 'mod.close.blocked' : 'mod.close.ready');
  $('blockers').replaceChildren(...session.blockers.map(b =>
    Object.assign(document.createElement('li'), { textContent: t('mod.block.' + b.kind, b) })));
  if (blocked) $('tray').checked = false;
  $('tray').disabled = blocked;
  $('close').disabled = blocked || !$('tray').checked;
}

async function newCode() {
  if (codeBusy || !session) return;
  codeBusy = true;
  const r = await api('POST', '/api/mod/enroll-code', {});
  codeBusy = false;
  if (r.status === 0 || failed(r)) return;
  // The clock of this phone counts the time. The clock of the server is not compared, so a wrong phone clock does no harm.
  code = { until: Date.now() + CODE_LIFE * 1000, phones: session.phones.length };
  drawQr($('qr'), `${location.origin}/join#c=${r.data.code}`);
  tick();
}

function tick() {
  if (!session || !code) return;
  const left = Math.max(0, Math.round((code.until - Date.now()) / 1000));
  $('qr-left').textContent = t('mod.qr.left', { s: left });
  $('qr-meter').style.transform = `scaleX(${left / CODE_LIFE})`;
  if (left === 0 && !document.hidden) newCode();
}

$('open').onsubmit = async event => {
  event.preventDefault();
  const material = fixed ?? new FormData($('open')).get('material');
  if (!material) return say(status, t('err.material'), 'bad');
  const r = await api('POST', '/api/mod/session', { label: wanted, material, reason: $('reason').value });
  if (r.data.needs_reason) { fixed = r.data.material; showFixed(); }   // the server knows the bag from an earlier opening
  if (failed(r)) return;
  forgetWanted();
  $('open').reset();
  say(status, '');
  await refresh();
};
$('open-cancel').onclick = () => { forgetWanted(); say(status, ''); render(); };

async function closeBag(body) {
  const r = await api('POST', '/api/mod/session/close', body);
  if (!failed(r)) {
    $('tray').checked = false;
    $('force-reason').value = '';
    say(status, t(r.data.manifest ? 'mod.closed' : 'mod.closed.nofile'), r.data.manifest ? 'good' : 'bad');
  }
  await refresh();
}
$('tray').onchange = () => { if (session) renderClose(); };
$('close').onclick = () => closeBag({ tray_empty: $('tray').checked });
$('force').onclick = () => closeBag({ force_reason: $('force-reason').value });
$('qr-new').onclick = newCode;

// A new label scan in this tab changes only the part of the address after "#".
addEventListener('hashchange', () => { wanted = bagFromAddress() ?? wanted; if (wanted) render(); });

api('GET', '/api/mod/whoami').then(r => { if (r.ok) $('who').textContent = t('mod.who', r.data) + ' ·'; });
await refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);   // the screen follows the phones
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
