// Start page. Shows the version of the running code, so anyone can compare it with the repository.
// A phone that is in a bag gets a button back to its capture screen.
import { $, api, boot, t, lastSession } from '/ui.js';
import { scanButton } from '/scan.js';

boot();
scanButton($('scan'), '/join', 'c');
api('GET', '/api/health').then(r => { $('commit').textContent = r.ok ? r.data.commit : '-'; });
const answer = await api('GET', '/api/op/session');
// With no network, the bag from the last contact of this phone.
const session = answer.ok ? answer.data : answer.status === 0 ? lastSession() : null;
if (session) {
  $('continue').textContent = t('home.continue', session);
  $('continue').hidden = false;
}
