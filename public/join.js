// Operator join page. The phone opens it from the QR code on the moderator screen: /join#c=<one-time code>.
import { $, api, boot, t, say, errorText, keep } from '/ui.js';

boot();
const status = $('status');

// The code comes in the part of the address that the browser does not send to a server.
// Take it out of the address at once, so it does not stay in the history. Keep it for this tab only,
// so a language switch (page reload) does not lose it.
const fromAddress = new URLSearchParams(location.hash.slice(1)).get('c');
if (fromAddress) {
  sessionStorage.setItem('code', fromAddress);
  history.replaceState(null, '', location.pathname);
}
const code = sessionStorage.getItem('code');

if (!code) {
  $('form').hidden = true;
  say(status, t('join.nocode'), 'bad');
}
$('name').value = keep.get('name') ?? '';

$('form').onsubmit = async event => {
  event.preventDefault();
  const name = $('name').value.trim();
  // An ID that this phone makes one time. The record uses it to tell phones apart.
  let phone = keep.get('phone');
  if (!phone) keep.set('phone', phone = crypto.randomUUID());
  $('go').disabled = true;
  say(status, t('join.working'));
  const r = await api('POST', '/api/enroll', { code, name, phone });
  if (r.ok) {
    keep.set('name', name);
    sessionStorage.removeItem('code');
    location.replace('/capture');
    return;
  }
  $('go').disabled = false;
  say(status, errorText(r), 'bad');
  if (r.data.code === 'code') {          // the code is used up or too old: only a new scan helps
    sessionStorage.removeItem('code');
    $('form').hidden = true;
  }
};
