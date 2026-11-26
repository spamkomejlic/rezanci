// Session logic against a real local D1 database (the same engine as production, in memory).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/worker.js';
import { routes, bagLabel, parseLabel, Refusal } from '../src/api.js';

let db, dispose;
before(async () => {
  const proxy = await getPlatformProxy({ persist: false });
  db = proxy.env.DB;
  dispose = proxy.dispose;
  const sql = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
});
after(() => dispose());

const ana = { email: 'ana@example.com' }, bo = { email: 'bo@example.com' };
const stamp = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
// A moderator endpoint, called the way worker.js calls it after the login check.
const mod = async (route, moderator, body = {}, now = stamp()) => routes[route]({ db, moderator, body, now });
// A public or operator endpoint, through the full Worker.
const call = (method, path, { body, cookie } = {}) => {
  const text = body && JSON.stringify(body);
  const headers = { ...(cookie && { Cookie: cookie }), ...(text && { 'Content-Type': 'application/json', 'Content-Length': String(text.length) }) };
  return worker.fetch(new Request('https://rezanci.net' + path, { method, headers, body: text }), { DB: db });
};
const refused = (promise, status) => assert.rejects(promise, e => e instanceof Refusal && e.status === status);

test('a bag label carries a check character that finds a wrong character', () => {
  const label = bagLabel('L01', 'B000123');
  assert.match(label, /^L01-B000123-[0-9A-Z]$/);
  assert.deepEqual(parseLabel(label), { location: 'L01', bag: 'B000123' });
  assert.equal(parseLabel(label.replace('B000123', 'B000124')), null);   // one wrong digit
  assert.equal(parseLabel(label.replace('B000123', 'B000132')), null);   // two neighbors swapped
  assert.equal(parseLabel(label.replace('L01', 'L02')), null);           // wrong location
  assert.equal(parseLabel('L01-B000123'), null);
  assert.equal(parseLabel(undefined), null);
});

test('session flow: labels, open, enroll a phone, done, close, open again, remove, force close', async () => {
  const open = (moderator, label, reason) => mod('POST /api/mod/session', moderator, { label, material: 'shredded', reason });
  const join = (code, name = 'Mira') => call('POST', '/api/enroll', { body: { code, name, phone: 'phone-0001' } });

  // Locations and labels.
  await mod('POST /api/mod/locations', ana, { code: 'L01', name: 'Room 1' });
  await refused(mod('POST /api/mod/locations', ana, { code: 'L01', name: 'Again' }), 409);
  await refused(mod('POST /api/mod/locations', ana, { code: 'l01', name: 'Lower case' }), 400);
  const first = (await mod('POST /api/mod/bags', ana, { location: 'L01', count: 3 })).labels;
  const next = (await mod('POST /api/mod/bags', ana, { location: 'L01', count: 2 })).labels;
  assert.deepEqual([...first, ...next].map(l => l.slice(4, 11)), ['B000001', 'B000002', 'B000003', 'B000004', 'B000005']);
  await refused(mod('POST /api/mod/bags', ana, { location: 'L99', count: 1 }), 404);
  await refused(mod('POST /api/mod/bags', ana, { location: 'L01', count: 201 }), 400);

  // Open: only a printed label works, one bag per moderator, one session per bag.
  const wrongCheck = first[0].slice(0, -1) + (first[0].endsWith('A') ? 'B' : 'A');
  await refused(open(ana, wrongCheck), 400);
  await refused(open(ana, bagLabel('L01', 'B000999')), 404);
  await refused(mod('POST /api/mod/session', ana, { label: first[0], material: 'glass' }), 400);
  assert.deepEqual(await mod('GET /api/mod/session', ana), { session: null });
  await refused(mod('POST /api/mod/enroll-code', ana), 409);
  assert.equal((await open(ana, first[0])).label, first[0]);
  await refused(open(ana, first[1]), 409);
  await refused(open(bo, first[0]), 409);
  await open(bo, first[1]);

  // Enrollment code: one valid code at a time, one use, 2 minutes.
  const old = (await mod('POST /api/mod/enroll-code', ana)).code;
  const { code } = await mod('POST /api/mod/enroll-code', ana);
  assert.equal((await join(old)).status, 403);                 // a new code stops the old one
  assert.equal((await join('x'.repeat(22))).status, 403);
  assert.equal((await join(code, '')).status, 400);            // a bad name does not use up the code
  const joined = await join(code);
  assert.equal(joined.status, 200);
  assert.match(joined.headers.get('Set-Cookie'), /^__Host-op=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict/);
  const cookie = joined.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await join(code)).status, 403);                // one use
  const stale = await mod('POST /api/mod/enroll-code', ana, {}, stamp(-180_000));
  assert.equal((await join(stale.code)).status, 403);          // older than 2 minutes
  const stored = (await db.prepare('SELECT token_hash FROM enrollments').all()).results.map(r => r.token_hash);
  assert.ok(!stored.includes(cookie.split('=')[1]));           // the database holds only the hash

  // Operator phone session.
  assert.deepEqual(await (await call('GET', '/api/op/session', { cookie })).json(),
    { label: first[0], material: 'shredded', name: 'Mira', done: false });
  assert.equal((await call('GET', '/api/op/session')).status, 401);
  assert.equal((await call('GET', '/api/op/session', { cookie: '__Host-op=' + 'A'.repeat(43) })).status, 401);

  // Close rule: each phone Done, tray confirmed.
  let state = (await mod('GET /api/mod/session', ana)).session;
  assert.equal(state.label, first[0]);
  assert.deepEqual(state.phones.map(p => p.name), ['Mira']);
  assert.deepEqual(state.blockers, ['Phone not done: Mira']);
  await refused(mod('POST /api/mod/session/close', ana, { tray_empty: true }), 409);
  assert.deepEqual(await (await call('POST', '/api/op/done', { cookie, body: { done: true } })).json(), { done: true });
  await refused(mod('POST /api/mod/session/close', ana, {}), 400);
  assert.deepEqual(await mod('POST /api/mod/session/close', ana, { tray_empty: true }), { closed: true, forced: false });
  const ended = await call('GET', '/api/op/session', { cookie });
  assert.equal(ended.status, 401);
  assert.equal((await ended.json()).ended, 'closed');          // the phone session stops at close

  // Open a closed bag again: needs a written reason.
  await refused(open(ana, first[0]), 409);
  await open(ana, first[0], 'Two pieces were found under the table');

  // Remove a phone, then force close.
  const cookie2 = (await join((await mod('POST /api/mod/enroll-code', ana)).code, 'Jovan')).headers.get('Set-Cookie').split(';')[0];
  state = (await mod('GET /api/mod/session', ana)).session;
  assert.deepEqual(state.phones.map(p => p.name), ['Jovan']);
  assert.deepEqual(await mod('POST /api/mod/phone/remove', ana, { id: state.phones[0].id }), { removed: true });
  assert.equal((await (await call('GET', '/api/op/session', { cookie: cookie2 })).json()).ended, 'removed');
  await refused(mod('POST /api/mod/phone/remove', ana, { id: state.phones[0].id }), 404);
  await refused(mod('POST /api/mod/session/close', ana, { force_reason: 'short' }), 400);
  assert.deepEqual(await mod('POST /api/mod/session/close', ana, { force_reason: 'Fire alarm, room cleared' }), { closed: true, forced: true });

  // The event record holds each action in order.
  const events = (await db.prepare('SELECT type FROM events ORDER BY id').all()).results.map(r => r.type);
  assert.deepEqual(events, ['location', 'labels', 'labels', 'open', 'open', 'enroll', 'done', 'close', 'reopen', 'enroll', 'remove', 'force close']);
});

test('the Worker refuses requests with no login, from a different site, or with a bad body', async () => {
  const env = { DB: db, ACCESS_TEAM: 'team.example', ACCESS_AUD: 'aud' };
  const send = (path, init) => worker.fetch(new Request('https://rezanci.net' + path, init), env);
  assert.equal((await send('/api/mod/session')).status, 401);
  assert.equal((await send('/api/mod/nothing-here')).status, 401);       // login check comes before "not found"
  assert.equal((await send('/api/op/session')).status, 401);
  assert.equal((await send('/api/enroll', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site', 'Content-Length': '2' }, body: '{}' })).status, 403);
  assert.equal((await send('/api/enroll', { method: 'POST', headers: { 'Content-Length': '5000' }, body: 'x'.repeat(5000) })).status, 413);
  assert.equal((await send('/api/enroll', { method: 'POST', headers: { 'Content-Length': '2' }, body: '[]' })).status, 400);
  assert.equal((await send('/api/nothing-here')).status, 404);
});
