// Shared page code: texts, API calls, small helpers.
import { t, applyText, switchLang, lang } from '/i18n.js';
export { t };

export const $ = id => document.getElementById(id);

// One API call. It never throws:
// - no network, or no answer in time, gives status 0 and the code "offline",
// - a redirect (the moderator login ended) gives status 302 and the code "mod_login".
// A body that is a file (a photo) goes as it is. Each other body goes as JSON.
export async function api(method, path, body) {
  const file = body instanceof Blob;
  try {
    const r = await fetch(path, {
      method, redirect: 'manual',
      headers: body ? { 'Content-Type': file ? 'image/jpeg' : 'application/json' } : undefined,
      body: file ? body : body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(file ? 300000 : 20000),   // a photo of 10 MB on a slow network needs minutes
    });
    if (r.type === 'opaqueredirect') return { ok: false, status: 302, data: { code: 'mod_login' } };
    const data = await r.json().catch(() => ({}));
    // A refusal that does not come from the app comes from the login gate in front of it.
    if ((r.status === 401 || r.status === 403) && !data.code) data.code = 'mod_login';
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: { code: 'offline' } };
  }
}

// Text for a refused call, in the language of the page.
export const errorText = r => t('err.' + r.data.code, r.data) ?? r.data.error ?? t('err.offline');

// Status line of a page. kind: "good", "bad" or nothing. An empty text hides the line.
export function say(el, text, kind = '') {
  el.textContent = text;
  el.className = ('status ' + kind).trim();
  el.hidden = !text;
}

// Shows the named sections and hides the other sections of the same group.
export function show(group, ...ids) {
  for (const el of document.querySelectorAll(`[data-group="${group}"]`)) el.hidden = !ids.includes(el.id);
}

// Values that this phone keeps between visits. Storage can be off (private mode): then nothing is kept.
export const keep = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* not kept */ } },
};

// The bag of this phone from its last contact with the server, for a start with no network. Null if there is none.
export const lastSession = () => { try { return JSON.parse(keep.get('session') || 'null'); } catch { return null; } };

// Fills the texts and connects the language button. Each page calls it one time.
export function boot() {
  applyText();
  // The operator pages get a service worker, so they open with no network. The moderator pages need the login, so they do not.
  if ('serviceWorker' in navigator && !location.pathname.startsWith('/mod')) navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Chrome on Android can put the app on the home screen. The button shows only when the browser offers that.
  addEventListener('beforeinstallprompt', event => {
    const install = $('install');
    if (!install) return;
    event.preventDefault();
    install.hidden = false;
    install.onclick = () => { install.hidden = true; event.prompt(); };
  });
  const button = $('lang');
  if (button) {
    button.textContent = lang === 'sr' ? 'English' : 'Srpski';
    button.onclick = switchLang;
  }
}
