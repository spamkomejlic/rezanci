// Moderator page for locations and bag labels. A label holds a QR code that opens the bag on the moderator screen.
import { $, api, boot, t, say, errorText } from '/ui.js';
import { drawQr } from '/qr.js';

boot();
const status = $('status');

// True if the call failed. Shows the reason. A login that ended sends the moderator to the login.
function failed(r) {
  if (r.ok) return false;
  if (r.data.code === 'mod_login') location.href = '/mod/'; else say(status, errorText(r), 'bad');
  return true;
}

async function loadLocations() {
  const r = await api('GET', '/api/mod/locations');
  if (failed(r)) return;
  const { locations } = r.data;
  $('loc-none').hidden = locations.length > 0;
  $('make').hidden = locations.length === 0;
  $('locations').replaceChildren(...locations.map(l => {
    const row = document.createElement('li');
    row.append(
      Object.assign(document.createElement('span'), { className: 'pill plain', textContent: l.code }),
      Object.assign(document.createElement('span'), { className: 'name grow', textContent: l.name }));
    return row;
  }));
  $('make-location').replaceChildren(...locations.map(l =>
    Object.assign(document.createElement('option'), { value: l.code, textContent: `${l.code} · ${l.name}` })));
}

$('loc-form').onsubmit = async event => {
  event.preventDefault();
  const r = await api('POST', '/api/mod/locations', { code: $('loc-code').value.trim().toUpperCase(), name: $('loc-name').value });
  if (failed(r)) return;
  $('loc-form').reset();
  say(status, '');
  await loadLocations();
  $('make-location').value = r.data.code;
};

$('make').onsubmit = async event => {
  event.preventDefault();
  const r = await api('POST', '/api/mod/bags', { location: $('make-location').value, count: Number($('make-count').value) });
  if (failed(r)) return;
  say(status, '');
  // Each label: the QR code with the address of the moderator screen and the bag, and the same label as text.
  $('sheet').replaceChildren(...r.data.labels.map(label => {
    const tag = Object.assign(document.createElement('a'), { className: 'tag', href: `/mod/#bag=${label}` });
    const canvas = document.createElement('canvas');
    drawQr(canvas, `${location.origin}/mod/#bag=${label}`, 6);
    tag.append(canvas, Object.assign(document.createElement('b'), { textContent: label }));
    return tag;
  }));
  $('sheet-card').hidden = false;
  $('sheet-card').scrollIntoView({ behavior: 'smooth' });
};

$('print').onclick = () => print();
await loadLocations();
