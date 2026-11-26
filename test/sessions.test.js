// Session logic against a real local D1 database (the same engine as production, in memory).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/worker.js';
import { routes, bagLabel, parseLabel, Refusal } from '../src/api.js';
import { sha256Hex } from '../public/jpeg.js';
import { migrate, buffered } from '../dev/migrate.js';

let db, archive, env, dispose;
before(async () => {
  const proxy = await getPlatformProxy({ persist: false });
  db = proxy.env.DB;
  archive = buffered(proxy.env.ARCHIVE);
  env = { DB: db, ARCHIVE: archive };
  dispose = proxy.dispose;
  await migrate(db);
});
after(() => dispose());

const ana = { email: 'ana@example.com' }, bo = { email: 'bo@example.com' };
const stamp = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
// A moderator endpoint, called the way worker.js calls it after the login check.
const mod = async (route, moderator, body = {}, now = stamp()) => routes[route]({ db, env, moderator, body, now });
// A public or operator endpoint, through the full Worker. A body that is not bytes goes as JSON.
const call = (method, path, { body, cookie } = {}) => {
  const data = body instanceof Uint8Array ? body : body && new TextEncoder().encode(JSON.stringify(body));
  const headers = { ...(cookie && { Cookie: cookie }), ...(data && { 'Content-Type': body === data ? 'image/jpeg' : 'application/json', 'Content-Length': String(data.length) }) };
  return worker.fetch(new Request('https://rezanci.net' + path, { method, headers, body: data }), env);
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
  await refused(mod('POST /api/mod/session', ana, { label: first[0], material: 'sheets' }), 400);   // an option of an earlier version
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
    { label: first[0], material: 'shredded', name: 'Mira', done: false, verified: 0 });
  assert.equal((await call('GET', '/api/op/session')).status, 401);
  assert.equal((await call('GET', '/api/op/session', { cookie: '__Host-op=' + 'A'.repeat(43) })).status, 401);

  // Close rule: each phone Done, tray confirmed.
  let state = (await mod('GET /api/mod/session', ana)).session;
  assert.equal(state.label, first[0]);
  assert.deepEqual(state.phones.map(p => p.name), ['Mira']);
  assert.deepEqual(state.blockers, [{ kind: 'not_done', name: 'Mira' }]);
  await refused(mod('POST /api/mod/session/close', ana, { tray_empty: true }), 409);
  assert.deepEqual(await (await call('POST', '/api/op/done', { cookie, body: { done: true } })).json(), { done: true });
  await refused(mod('POST /api/mod/session/close', ana, {}), 400);
  assert.deepEqual(await mod('POST /api/mod/session/close', ana, { tray_empty: true }), { closed: true, forced: false, manifest: true });
  const ended = await call('GET', '/api/op/session', { cookie });
  assert.equal(ended.status, 401);
  assert.equal((await ended.json()).ended, 'closed');          // the phone session stops at close

  // Open a closed bag again: needs a written reason. The contents of the bag are set at its first opening:
  // the open form gets them from the server, and a different value in a later opening changes nothing.
  const contents = label => routes['GET /api/mod/bag']({ db, url: new URL('https://rezanci.net/api/mod/bag?label=' + label) });
  assert.deepEqual(await contents(first[0]), { label: first[0], material: 'shredded' });
  assert.deepEqual(await contents(first[2]), { label: first[2], material: null });     // never opened
  await refused(contents(bagLabel('L01', 'B000999')), 404);
  await refused(contents('nothing'), 400);
  await assert.rejects(open(ana, first[0]), e => e.status === 409 && e.extra.needs_reason && e.extra.material === 'shredded');
  await mod('POST /api/mod/session', ana, { label: first[0], material: 'crosscut', reason: 'Two pieces were found under the table' });
  assert.equal((await mod('GET /api/mod/session', ana)).session.material, 'shredded');
  assert.deepEqual((await db.prepare('SELECT material FROM sessions WHERE bag_id = ?').bind('B000001').all()).results.map(r => r.material),
    ['shredded', 'shredded']);

  // Remove a phone, then force close.
  const cookie2 = (await join((await mod('POST /api/mod/enroll-code', ana)).code, 'Jovan')).headers.get('Set-Cookie').split(';')[0];
  state = (await mod('GET /api/mod/session', ana)).session;
  assert.deepEqual(state.phones.map(p => p.name), ['Jovan']);
  assert.deepEqual(await mod('POST /api/mod/phone/remove', ana, { id: state.phones[0].id }), { removed: true });
  assert.equal((await (await call('GET', '/api/op/session', { cookie: cookie2 })).json()).ended, 'removed');
  await refused(mod('POST /api/mod/phone/remove', ana, { id: state.phones[0].id }), 404);
  await refused(mod('POST /api/mod/session/close', ana, { force_reason: 'short' }), 400);
  assert.deepEqual(await mod('POST /api/mod/session/close', ana, { force_reason: 'Fire alarm, room cleared' }), { closed: true, forced: true, manifest: true });

  // The event record holds each action in order.
  const events = (await db.prepare('SELECT type FROM events ORDER BY id').all()).results.map(r => r.type);
  assert.deepEqual(events, ['location', 'labels', 'labels', 'open', 'open', 'enroll', 'done', 'close', 'reopen', 'enroll', 'remove', 'force close']);
});

test('photo upload: checked by the archive, verified one time, kept in its bag, listed in the manifest', async () => {
  const cy = { email: 'cy@example.com' }, dee = { email: 'dee@example.com' };
  const open = (moderator, label) => mod('POST /api/mod/session', moderator, { label, material: 'torn' });
  const join = async (moderator, extra = {}) => call('POST', '/api/enroll',
    { body: { code: (await mod('POST /api/mod/enroll-code', moderator)).code, name: 'Lena', phone: 'phone-0002', ...extra } });
  const cookieOf = answer => answer.headers.get('Set-Cookie').split(';')[0];
  const phones = async moderator => (await mod('GET /api/mod/session', moderator)).session.phones;
  const photo = crypto.getRandomValues(new Uint8Array(3000)), sha = await sha256Hex(photo);
  const send = (cookie, bag, { bytes = photo, hash = sha, w = 8160, h = 6120, left = 0, ...more } = {}) => call('PUT',
    `/api/op/photo?${new URLSearchParams({ sha: hash, bag, w, h, left, taken: '2026:11:26 10:00:00', ...more })}`, { body: bytes, cookie });

  await mod('POST /api/mod/locations', cy, { code: 'L02', name: 'Room 2' });
  const [bagA, bagB] = (await mod('POST /api/mod/bags', cy, { location: 'L02', count: 2 })).labels;
  const sessionA = (await open(cy, bagA)).id;
  const cookie = cookieOf(await join(cy));
  const key = `locations/L02/bags/${bagA.slice(4, 11)}/${sha}.jpg`;

  // Refused before any write: no session, bad values, the label of a different bag.
  assert.equal((await send(undefined, bagA)).status, 401);
  assert.equal((await send(cookie, bagA, { hash: 'abc' })).status, 400);
  assert.equal((await send(cookie, bagA, { w: 4080, h: 3060 })).status, 400);      // 12 MP
  const wrongBag = await send(cookie, bagB);
  assert.equal(wrongBag.status, 409);
  assert.equal((await wrongBag.json()).code, 'wrong_bag');
  assert.equal(await archive.head(key), null);

  // Bytes that do not match the SHA-256: the archive stores nothing, the record stays "pending" and blocks the close.
  const damaged = await send(cookie, bagA, { bytes: photo.map(b => b ^ 1) });
  assert.equal(damaged.status, 502);
  assert.equal(await archive.head(key), null);
  let state = (await mod('GET /api/mod/session', cy)).session;
  assert.deepEqual([state.phones[0].images, state.phones[0].verified], [1, 0]);
  assert.deepEqual(state.blockers, [{ kind: 'not_done', name: 'Lena' }, { kind: 'not_verified', name: 'Lena', count: 1 }]);

  // The right bytes: stored, read back, verified. A repeated upload gives the same answer and counts one time.
  for (let i = 0; i < 2; i++) assert.deepEqual(await (await send(cookie, bagA, { left: 2 })).json(), { verified: true, sha, count: 1 });
  const stored = await archive.head(key);
  assert.equal(stored.size, photo.length);
  assert.equal(Buffer.from(stored.checksums.sha256).toString('hex'), sha);
  const [phone] = await phones(cy);
  assert.deepEqual([phone.images, phone.verified, phone.queue, phone.silent], [1, 1, 2, 0]);
  assert.equal((await (await call('GET', '/api/op/session', { cookie })).json()).verified, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'verify' AND session_id = ?").bind(sessionA).first()).n, 1);

  // The phone reports its queue. Photos on a phone block the close.
  await call('GET', '/api/op/session?queue=1', { cookie });
  assert.deepEqual(await (await call('POST', '/api/op/done', { cookie, body: { done: true, queue: 1 } })).json(), { done: true });
  state = (await mod('GET /api/mod/session', cy)).session;
  assert.deepEqual(state.blockers, [{ kind: 'queue', name: 'Lena', count: 1 }]);
  await refused(mod('POST /api/mod/session/close', cy, { tray_empty: true }), 409);

  // A phone that holds photos of bag A cannot join bag B. The refusal does not use up the code.
  await open(dee, bagB);
  const { code } = await mod('POST /api/mod/enroll-code', dee);
  const held = await call('POST', '/api/enroll', { body: { code, name: 'Lena', phone: 'phone-0002', holds: bagA } });
  assert.equal(held.status, 409);
  assert.deepEqual([(await held.json()).code, (await call('POST', '/api/enroll', { body: { code, name: 'Vuk', phone: 'phone-0003', holds: bagB } })).status],
    ['phone_holds', 200]);

  // The same phone joins bag A again: the new session takes over its queue report.
  const again = cookieOf(await join(cy, { holds: bagA }));
  await call('POST', '/api/op/done', { cookie: again, body: { done: true, queue: 0 } });
  assert.deepEqual((await phones(cy)).map(p => p.queue), [0, 0]);

  // Close: the manifest in the bag folder lists the session, the phones and the image records.
  assert.deepEqual(await mod('POST /api/mod/session/close', cy, { tray_empty: true }), { closed: true, forced: false, manifest: true });
  const manifest = await (await archive.get(`locations/L02/bags/${bagA.slice(4, 11)}/manifest-${sessionA}.json`)).json();
  assert.deepEqual([manifest.label, manifest.session, manifest.close_type, manifest.phones.length], [bagA, sessionA, 'normal', 2]);
  assert.deepEqual(manifest.images.map(i => [i.sha256, i.bytes, i.width, i.state, i.captured_at]), [[sha, 3000, 8160, 'verified', '2026:11:26 10:00:00']]);
  assert.equal((await send(cookie, bagA)).status, 401);          // a closed bag takes no photo

  // Bag overview of the location: state and counts of each bag.
  const overview = async code => (await routes['GET /api/mod/bags']({ db, url: new URL('https://rezanci.net/api/mod/bags?location=' + code) })).bags;
  assert.deepEqual((await overview('L02')).map(b => [b.label, b.state, b.sessions, b.photos, b.flagged, b.missing, b.moderator]),
    [[bagA, 'closed', 1, 1, 0, 0, 'cy@example.com'], [bagB, 'open', 1, 0, 0, 0, 'dee@example.com']]);
  assert.deepEqual((await overview('L01')).map(b => b.state), ['forced', 'open', 'new', 'new', 'new']);
  assert.deepEqual(await overview('NONE'), []);

  // A closed session with no manifest gets its file when the next bag opens.
  await db.prepare('UPDATE sessions SET manifest_at = NULL WHERE id = ?').bind(sessionA).run();
  await mod('POST /api/mod/session/close', dee, { force_reason: 'End of the upload test' });

  // Trial location: its photos go under test/, outside the locked part of the archive.
  await mod('POST /api/mod/locations', cy, { code: 'TEST1', name: 'Trial' });
  const [trial] = (await mod('POST /api/mod/bags', cy, { location: 'TEST1', count: 1 })).labels;
  await open(cy, trial);
  assert.ok((await db.prepare('SELECT manifest_at FROM sessions WHERE id = ?').bind(sessionA).first()).manifest_at);
  // The quality numbers of the phone go into the record. A photo that the operator kept after a warning counts as flagged.
  assert.equal((await send(cookieOf(await join(cy)), trial, { blur: 41.5, clipped: 0.02, dark: 7, flag: 1 })).status, 200);
  assert.deepEqual(await db.prepare('SELECT blur_score, clipped, dark, flagged FROM images WHERE sha256 = ? ORDER BY created_at DESC').bind(sha).first(),
    { blur_score: 41.5, clipped: 0.02, dark: null, flagged: 1 });
  assert.equal((await phones(cy))[0].flagged, 1);
  assert.equal((await archive.head(`test/TEST1/bags/${trial.slice(6, 13)}/${sha}.jpg`)).size, 3000);
  assert.equal(await archive.head(`locations/TEST1/bags/${trial.slice(6, 13)}/${sha}.jpg`), null);

  // A photo that did not arrive before a close shows in the overview, until it arrives in a later session of the bag.
  const second = crypto.getRandomValues(new Uint8Array(2000)), secondSha = await sha256Hex(second);
  assert.equal((await send(cookieOf(await join(cy)), trial, { bytes: second.map(b => b ^ 1), hash: secondSha })).status, 502);
  await mod('POST /api/mod/session/close', cy, { force_reason: 'A photo did not arrive' });
  assert.deepEqual((await overview('TEST1')).map(b => [b.state, b.sessions, b.photos, b.flagged, b.missing]), [['forced', 1, 1, 1, 1]]);
  await mod('POST /api/mod/session', cy, { label: trial, material: 'torn', reason: 'The phone has the photo' });
  assert.equal((await send(cookieOf(await join(cy)), trial, { bytes: second, hash: secondSha })).status, 200);
  await mod('POST /api/mod/session/close', cy, { force_reason: 'End of the overview test' });
  assert.deepEqual((await overview('TEST1')).map(b => [b.state, b.sessions, b.photos, b.missing]), [['forced', 2, 2, 0]]);
});

test('photo check: a moderator sees and decides the photos of the open bag, a flagged photo blocks the close', async () => {
  const eve = { email: 'eve@example.com' }, fay = { email: 'fay@example.com' };
  const join = async (moderator, name) => (await call('POST', '/api/enroll',
    { body: { code: (await mod('POST /api/mod/enroll-code', moderator)).code, name, phone: 'phone-' + name } })).headers.get('Set-Cookie').split(';')[0];
  const file = async size => { const bytes = crypto.getRandomValues(new Uint8Array(size)); return { bytes, sha: await sha256Hex(bytes) }; };
  const send = (cookie, bag, f, more = {}) => call('PUT',
    `/api/op/photo?${new URLSearchParams({ sha: f.sha, bag, w: 8160, h: 6120, ...more })}`, { body: f.bytes, cookie });
  const small = (cookie, bag, sha, bytes) => call('PUT', `/api/op/preview?${new URLSearchParams({ sha, bag })}`, { body: bytes, cookie });
  const photo = (moderator, sha, size) => routes['GET /api/mod/photo'](
    { db, env, moderator, url: new URL(`https://rezanci.net/api/mod/photo?sha=${sha}&size=${size}`) });
  const bytesOf = async answer => Buffer.from(await answer.arrayBuffer()).toString('hex');
  const review = (moderator, body) => mod('POST /api/mod/photo/review', moderator, body);
  const counts = async moderator => (await mod('GET /api/mod/session', moderator)).session.phones.map(p => [p.approved, p.rejected, p.flags_open]);

  await mod('POST /api/mod/locations', eve, { code: 'L03', name: 'Room 3' });
  const [bagA, bagB] = (await mod('POST /api/mod/bags', eve, { location: 'L03', count: 2 })).labels;
  const sessionA = (await mod('POST /api/mod/session', eve, { label: bagA, material: 'torn' })).id;
  await mod('POST /api/mod/session', fay, { label: bagB, material: 'torn' });
  const cookie = await join(eve, 'Nina'), cookieB = await join(fay, 'Oleg');
  const [one, two, kept, foreign, copy] = await Promise.all([3000, 3100, 3200, 3300, 400].map(file));
  const folder = `L03/bags/${bagA.slice(4, 11)}`;

  // The small copy goes into its own folder, outside the locked part of the archive, and only for the bag of the phone.
  assert.equal((await small(undefined, bagA, one.sha, copy.bytes)).status, 401);
  assert.equal((await small(cookie, bagB, one.sha, copy.bytes)).status, 409);
  assert.equal((await small(cookie, bagA, 'abc', copy.bytes)).status, 400);
  assert.equal((await small(cookie, bagA, one.sha, new Uint8Array(1024 * 1024 + 1))).status, 413);
  assert.deepEqual(await (await small(cookie, bagA, one.sha, copy.bytes)).json(), { stored: true });
  assert.deepEqual(await (await small(cookie, bagA, one.sha, new Uint8Array(500))).json(), { stored: true });   // the first copy stays
  assert.equal((await archive.head(`preview/locations/${folder}/${one.sha}.jpg`)).size, 400);
  assert.equal(await archive.head(`locations/${folder}/${one.sha}.jpg`), null);
  // A small copy alone is not a photo of the bag: the moderator cannot read it.
  await refused(photo(eve, one.sha, 'preview'), 404);

  for (const f of [one, two]) assert.equal((await send(cookie, bagA, f)).status, 200);
  assert.equal((await send(cookie, bagA, kept, { flag: 1 })).status, 200);
  assert.equal((await send(cookieB, bagB, foreign)).status, 200);

  // The list holds the photos of the own open bag only.
  const list = await mod('GET /api/mod/photos', eve);
  assert.equal(list.label, bagA);
  assert.deepEqual(list.photos.map(p => [p.sha, p.name, p.bytes, p.flagged, p.review]).sort(),
    [[one.sha, 'Nina', 3000, 0, null], [two.sha, 'Nina', 3100, 0, null], [kept.sha, 'Nina', 3200, 1, null]].sort());
  assert.deepEqual((await mod('GET /api/mod/photos', fay)).photos.map(p => p.sha), [foreign.sha]);
  await refused(mod('GET /api/mod/photos', { email: 'nobody@example.com' }), 409);

  // The files: small copy and stored photo of the own bag. A photo of a different bag is "not found".
  const preview = await photo(eve, one.sha, 'preview');
  assert.deepEqual([preview.headers.get('Content-Type'), preview.headers.get('Cache-Control'), preview.headers.get('X-Content-Type-Options')],
    ['image/jpeg', 'private, max-age=3600', 'nosniff']);
  assert.equal(await bytesOf(preview), Buffer.from(copy.bytes).toString('hex'));
  assert.equal(await bytesOf(await photo(eve, one.sha, 'full')), Buffer.from(one.bytes).toString('hex'));
  await refused(photo(eve, two.sha, 'preview'), 404);            // this photo came with no small copy
  await refused(photo(eve, foreign.sha, 'full'), 404);
  await refused(photo(eve, '../' + one.sha, 'full'), 404);

  // Decisions. A flagged photo with no decision blocks the close, and "approve all" does not cover it.
  assert.deepEqual(await counts(eve), [[0, 0, 1]]);
  assert.deepEqual((await mod('GET /api/mod/session', eve)).session.blockers.at(-1), { kind: 'review', name: 'Nina', count: 1 });
  await refused(review(eve, { sha: one.sha, decision: 'fine' }), 400);
  await refused(review(eve, { sha: foreign.sha, decision: 'approved' }), 404);
  await refused(review(eve, { all: true }), 400);
  assert.deepEqual(await review(eve, { sha: one.sha, decision: 'approved' }), { reviewed: 1, review: 'approved' });
  assert.deepEqual(await review(eve, { all: true, until: stamp(-60_000) }), { reviewed: 0 });   // a list from before the photos
  assert.deepEqual(await review(eve, { all: true, until: list.at }), { reviewed: 1 });
  assert.deepEqual(await counts(eve), [[2, 0, 1]]);
  await call('POST', '/api/op/done', { cookie, body: { done: true, queue: 0 } });
  await refused(mod('POST /api/mod/session/close', eve, { tray_empty: true }), 409);
  assert.deepEqual(await review(eve, { sha: kept.sha, decision: 'rejected' }), { reviewed: 1, review: 'rejected' });
  assert.deepEqual(await counts(eve), [[2, 1, 0]]);
  assert.deepEqual((await mod('GET /api/mod/session', eve)).session.blockers, []);
  // A changed decision moves the counts. The photo of the other bag has no decision.
  await review(eve, { sha: two.sha, decision: 'rejected' });
  assert.deepEqual(await counts(eve), [[1, 2, 0]]);
  assert.deepEqual(await counts(fay), [[0, 0, 0]]);

  // The event record has one line per decision. The manifest carries the decisions. A rejected photo stays in the archive.
  const events = (await db.prepare("SELECT actor, detail FROM events WHERE type = 'review' AND session_id = ? ORDER BY id").bind(sessionA).all()).results;
  assert.deepEqual(events.map(e => [e.actor, JSON.parse(e.detail).decision]),
    [['eve@example.com', 'approved'], ['eve@example.com', 'approved'], ['eve@example.com', 'rejected'], ['eve@example.com', 'rejected']]);
  assert.deepEqual(await mod('POST /api/mod/session/close', eve, { tray_empty: true }), { closed: true, forced: false, manifest: true });
  const manifest = await (await archive.get(`locations/${folder}/manifest-${sessionA}.json`)).json();
  assert.deepEqual(manifest.images.map(i => [i.sha256, i.review, i.reviewed_by]).sort(),
    [[one.sha, 'approved', 'eve@example.com'], [two.sha, 'rejected', 'eve@example.com'], [kept.sha, 'rejected', 'eve@example.com']].sort());
  assert.deepEqual([manifest.phones[0].approved, manifest.phones[0].rejected], [1, 2]);
  assert.equal((await archive.head(`locations/${folder}/${kept.sha}.jpg`)).size, 3200);
  // After the close there is no open bag: no list, no file, no decision.
  await refused(photo(eve, one.sha, 'full'), 409);
  await refused(review(eve, { sha: one.sha, decision: 'approved' }), 409);

  // The bag opens again: the photos from before are on the check screen, with their decisions, and a decision can change.
  const sessionA2 = (await mod('POST /api/mod/session', eve, { label: bagA, material: 'torn', reason: 'Check the photos again' })).id;
  const again = await mod('GET /api/mod/session', eve);
  assert.deepEqual([again.session.phones, again.session.photos, again.session.blockers], [[], { verified: 3, approved: 1, rejected: 2 }, []]);
  assert.deepEqual((await mod('GET /api/mod/photos', eve)).photos.map(p => [p.sha, p.review]).sort(),
    [[one.sha, 'approved'], [two.sha, 'rejected'], [kept.sha, 'rejected']].sort());
  assert.equal(await bytesOf(await photo(eve, two.sha, 'full')), Buffer.from(two.bytes).toString('hex'));
  await refused(photo(eve, foreign.sha, 'full'), 404);
  assert.deepEqual(await review(eve, { sha: two.sha, decision: 'approved' }), { reviewed: 1, review: 'approved' });
  // A photo that reaches the archive in both sessions shows one time, and one decision covers both records.
  const cookie2 = await join(eve, 'Nina');
  assert.equal((await send(cookie2, bagA, one)).status, 200);
  assert.deepEqual((await mod('GET /api/mod/photos', eve)).photos.map(p => [p.sha, p.review]).sort(),
    [[one.sha, null], [two.sha, 'approved'], [kept.sha, 'rejected']].sort());
  assert.deepEqual(await review(eve, { sha: one.sha, decision: 'rejected' }), { reviewed: 1, review: 'rejected' });
  assert.deepEqual((await db.prepare('SELECT review FROM images WHERE sha256 = ?').bind(one.sha).all()).results.map(r => r.review), ['rejected', 'rejected']);
  // The manifest of the second session holds the photos and phones of the whole bag, with the decisions of now.
  await mod('POST /api/mod/session/close', eve, { force_reason: 'End of the second session' });
  const second = await (await archive.get(`locations/${folder}/manifest-${sessionA2}.json`)).json();
  assert.deepEqual([second.format, second.session, second.phones.map(p => p.session)], [2, sessionA2, [sessionA, sessionA2]]);
  assert.deepEqual(second.images.map(i => [i.sha256, i.session, i.review]).sort(),
    [[one.sha, sessionA, 'rejected'], [one.sha, sessionA2, 'rejected'], [two.sha, sessionA, 'approved'], [kept.sha, sessionA, 'rejected']].sort());
  assert.equal((await (await archive.get(`locations/${folder}/manifest-${sessionA}.json`)).json()).images.length, 3);   // the first manifest stays
  await mod('POST /api/mod/session/close', fay, { force_reason: 'End of the photo check test' });
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
