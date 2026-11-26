// Moderator screen: open a bag, show the one-time code for phones, watch the phones, close the bag.
// Cloudflare Access guards this path. The API checks the login again on each call.
import { $, api, boot, t, say, show, errorText } from '/ui.js';
import { drawQr } from '/qr.js';

boot();
const status = $('status');
const CODE_LIFE = 115;     // seconds that one code stays on the screen. The server accepts a code for 120 seconds.
const bagFromAddress = () => new URLSearchParams(location.hash.slice(1)).get('bag');

let session = null;        // open bag of this moderator, as the server gave it
let wanted = bagFromAddress();   // label from a scanned bag code: /mod/#bag=<label>
let code = null;           // code on the screen: { until: time on this phone, phones: phone count at issue }
let codeBusy = false, lastPhones = '', offline = false;

// True if the call failed. Shows the reason. A login that ended gets its own screen.
function failed(r) {
  if (r.ok) return false;
  if (r.data.code === 'mod_login') show('main', 'login'); else say(status, errorText(r), 'bad');
  return true;
}
const forgetWanted = () => { wanted = null; history.replaceState(null, '', location.pathname); };

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
    if (wanted) { $('open-label').textContent = wanted; show('main', 'open'); } else show('main', 'idle');
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

// The close rule comes from the server: each phone Done and each photo in the archive.
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
  const material = new FormData($('open')).get('material');
  if (!material) return say(status, t('err.material'), 'bad');
  const r = await api('POST', '/api/mod/session', { label: wanted, material, reason: $('reason').value });
  if (r.data.needs_reason) $('reason-field').hidden = false;
  if (failed(r)) return;
  forgetWanted();
  $('open').reset();
  $('reason-field').hidden = true;
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
