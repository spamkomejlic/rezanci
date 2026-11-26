// Start page. Shows the version of the running code, so anyone can compare it with the repository.
// A phone that is in a bag gets a button back to its capture screen.
import { $, api, boot, t } from '/ui.js';

boot();
api('GET', '/api/health').then(r => { $('commit').textContent = r.ok ? r.data.commit : '-'; });
const session = await api('GET', '/api/op/session');
if (session.ok) {
  $('continue').textContent = t('home.continue', session.data);
  $('continue').hidden = false;
}
