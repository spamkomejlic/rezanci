// Session logic: locations, bag labels, bag sessions, enrollment of operator phones.
// worker.js does the login checks. A handler here gets the checked identity in its context.
import { sha256Hex } from '../public/jpeg.js';

// Headers for each API answer: no cache, no use inside a frame, no referrer.
const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
export const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { ...API_HEADERS, ...headers } });

// Each refusal has a short code. The screens translate the code. The text here is the English form.
export const ERRORS = {
  cross_site: 'Request from a different site refused.',
  not_found: 'Not found.',
  server: 'Server error.',
  mod_login: 'Moderator login required.',
  op_none: 'This phone has no session. Scan the code on the moderator screen.',
  op_removed: 'The moderator removed this phone from the bag.',
  op_closed: 'This bag is closed.',
  body_size: 'Request body: JSON of 4096 bytes or less, with a length header.',
  body_json: 'Request body: a JSON object.',
  location_code: 'Location code: 2 to 6 capital letters or digits. The first is a letter.',
  location_name: 'Location name: 1 to 80 characters.',
  location_used: 'This location code is in use.',
  location_unknown: 'Location not found.',
  count: 'Count: 1 to 200.',
  label: 'This is not a valid bag label.',
  material: 'Material: shredded, torn or sheets.',
  bag_unknown: 'Bag not found. Only a printed label works.',
  mod_has_bag: 'You have an open bag. Close it first.',
  bag_open: 'A different moderator has this bag open.',
  reopen_reason: 'This bag was closed before. Write a reason (10 characters or more) to open it again.',
  open_race: 'This bag or this moderator already has an open session.',
  no_bag: 'You have no open bag.',
  force_reason: 'Force close: write a reason of 10 characters or more.',
  blocked: 'Close is blocked.',
  tray: 'Confirm that the source tray is empty.',
  phone_unknown: 'Phone not found in this session.',
  code: 'This code is not valid. Scan the code on the moderator screen again.',
  name: 'Name: 1 to 40 characters.',
  phone_id: 'Phone ID is not valid.',
  phone_holds: 'This phone holds photos of a different bag. Join that bag first.',
  photo_hash: 'Photo: the SHA-256 is not valid.',
  photo_size: 'Photo: a file of 1 byte to 64 MB, with a length header.',
  photo_pixels: 'Photo: 48 MP or more.',
  wrong_bag: 'This photo is from a different bag.',
  archive: 'The archive did not confirm the photo.',
};
export class Refusal extends Error {
  constructor(status, code, extra = {}) { super(ERRORS[code]); this.status = status; this.code = code; this.extra = extra; }
}
const refuse = (status, code, extra) => { throw new Refusal(status, code, extra); };
export const refusal = (status, code, extra = {}) => json({ error: ERRORS[code], code, ...extra }, status);

export const MATERIALS = ['shredded', 'torn', 'sheets'];
export const OPERATOR_COOKIE = '__Host-op';
const CODE_LIFE_MS = 120_000;   // a one-time enrollment code works for 2 minutes
const MIN_PIXELS = 48e6;        // camera specification: 48 MP or more
const MAX_PHOTO_BYTES = 64 * 1024 * 1024;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const hash = text => sha256Hex(new TextEncoder().encode(text));
const randomToken = bytes => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

// Check character of a bag label (Luhn mod 36 over the letters and digits).
// It finds each single wrong character and most swaps of two neighbor characters.
export function checkChar(text) {
  let factor = 2, sum = 0;
  for (const c of [...text.replace(/[^0-9A-Z]/g, '')].reverse()) {
    const addend = factor * ALPHABET.indexOf(c);
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(addend / 36) + (addend % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36];
}

// Bag label: location code, bag ID, check character. Example: L01-B000123-K.
export const bagLabel = (location, bag) => `${location}-${bag}-${checkChar(location + bag)}`;
export function parseLabel(label) {
  const m = /^([A-Z][A-Z0-9]{1,5})-(B\d{6})-([0-9A-Z])$/.exec(String(label));
  return m && checkChar(m[1] + m[2]) === m[3] ? { location: m[1], bag: m[2] } : null;
}

// Folder of one bag in the archive. A location whose code starts with TEST is a trial location:
// its files go under test/, where the lock rule of the archive does not apply, so they can be deleted.
const bagFolder = (location, bag) => `${location.startsWith('TEST') ? 'test' : 'locations'}/${location}/bags/${bag}`;
const hex = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
// The archive stores a file only if its name is free. A stored file never changes.
const WRITE_ONCE = { etagDoesNotMatch: '*' };

// One line in the append-only event record.
const event = (db, at, session, actor, type, detail = null) =>
  db.prepare('INSERT INTO events (at, session_id, actor, type, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(at, session, actor, type, detail && JSON.stringify(detail));

const openSession = (db, moderator) => db.prepare(
  `SELECT s.id, s.bag_id, b.location_code, s.material, s.opened_at
   FROM sessions s JOIN bags b ON b.id = s.bag_id WHERE s.moderator = ? AND s.closed_at IS NULL`).bind(moderator).first();
const mustHaveOpen = async (db, moderator) => (await openSession(db, moderator)) ?? refuse(409, 'no_bag');

// Phones of one session. The counters come from the enrollment row: the database keeps them (migration 0002).
// "silent" is the number of full minutes since the last report of the phone.
const phonesOf = async (db, session, now) => (await db.prepare(
  `SELECT rowid AS id, operator_name AS name, enrolled_at, done_at, removed_at, images, verified, flagged, queue_len AS queue, seen_at
   FROM enrollments WHERE session_id = ? ORDER BY enrolled_at, rowid`).bind(session).all()).results
  .map(({ seen_at, ...p }) => ({ ...p, silent: seen_at ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(seen_at)) / 60000)) : null }));

// Reasons that block a normal close. An empty list means that the close rule holds:
// each phone is Done, no phone holds a photo, and each image record is verified.
const blockersOf = phones => [
  ...phones.filter(p => !p.removed_at && !p.done_at).map(p => ({ kind: 'not_done', name: p.name })),
  ...phones.filter(p => p.queue > 0).map(p => ({ kind: 'queue', name: p.name, count: p.queue })),
  ...phones.filter(p => p.images > p.verified).map(p => ({ kind: 'not_verified', name: p.name, count: p.images - p.verified })),
];

// Manifest: one JSON file in the bag folder with the session record, its phones and its image records.
// A reader can check the bag folder with it and needs no access to the database.
// The session is closed at this point, so its records do not change, and a repeated write gives the same file.
async function writeManifest(env, db, id) {
  const [[s], phones, images] = (await db.batch([
    db.prepare(
      `SELECT s.id AS session, b.location_code AS location, s.bag_id AS bag, s.material, s.moderator, s.opened_at, s.closed_at, s.close_type, s.force_reason
       FROM sessions s JOIN bags b ON b.id = s.bag_id WHERE s.id = ? AND s.closed_at IS NOT NULL`).bind(id),
    db.prepare(
      `SELECT rowid AS phone, phone_id, operator_name AS name, enrolled_at, done_at, removed_at, images, verified, flagged, queue_len AS left_on_phone
       FROM enrollments WHERE session_id = ? ORDER BY enrolled_at, rowid`).bind(id),
    // ponytail: all image records of the session in one read. Page the read if a session passes about 5000 photos.
    db.prepare(
      `SELECT i.sha256, i.bytes, i.width, i.height, i.captured_at, i.created_at, i.verified_at, i.state, i.flagged, i.blur_score, i.clipped, i.dark, e.rowid AS phone
       FROM images i JOIN enrollments e ON e.token_hash = i.token_hash WHERE i.session_id = ? ORDER BY i.created_at, i.sha256`).bind(id),
  ])).map(r => r.results);
  if (!s) return false;
  const file = JSON.stringify({ format: 1, label: bagLabel(s.location, s.bag), ...s, phones, images }, null, 1);
  const key = `${bagFolder(s.location, s.bag)}/manifest-${s.session}.json`;
  // A write that the archive refuses is not a failure if the file is there from an earlier try.
  await env.ARCHIVE.put(key, file, { onlyIf: WRITE_ONCE, httpMetadata: { contentType: 'application/json' } })
    .catch(async e => { if (!await env.ARCHIVE.head(key)) throw e; });
  await db.prepare('UPDATE sessions SET manifest_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
  return true;
}

const reportQueue = (db, operator, queue, now) =>
  db.prepare('UPDATE enrollments SET queue_len = ?, seen_at = ? WHERE token_hash = ?').bind(queue, now, operator.token_hash);

// Session of the operator phone that sent the request, from its cookie. Null if there is none.
export async function operatorFor(request, db) {
  const m = new RegExp(`(?:^|;\\s*)${OPERATOR_COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(request.headers.get('Cookie') ?? '');
  return m && db.prepare(
    `SELECT e.token_hash, e.session_id, e.operator_name AS name, e.done_at, e.removed_at, e.verified,
       s.closed_at, s.material, s.bag_id, b.location_code
     FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN bags b ON b.id = s.bag_id
     WHERE e.token_hash = ?`).bind(await hash(m[1])).first();
}

// One entry per endpoint: "METHOD /path". A path that is not in this table does not exist.
// /api/mod/ needs a moderator login, /api/op/ needs an operator phone session. worker.js checks both.
export const routes = {
  'GET /api/mod/whoami': ({ moderator }) => ({ email: moderator.email, amr: moderator.amr ?? null }),

  'GET /api/mod/locations': async ({ db }) =>
    ({ locations: (await db.prepare('SELECT code, name FROM locations ORDER BY code').all()).results }),

  'POST /api/mod/locations': async ({ db, body, moderator, now }) => {
    const code = String(body.code ?? ''), name = String(body.name ?? '').trim();
    if (!/^[A-Z][A-Z0-9]{1,5}$/.test(code)) refuse(400, 'location_code');
    if (!name || name.length > 80) refuse(400, 'location_name');
    if (await db.prepare('SELECT 1 FROM locations WHERE code = ?').bind(code).first()) refuse(409, 'location_used');
    await db.batch([
      db.prepare('INSERT INTO locations (code, name, created_at) VALUES (?, ?, ?)').bind(code, name, now),
      event(db, now, null, moderator.email, 'location', { code, name }),
    ]);
    return { code, name };
  },

  // Makes new bags for a label sheet. A bag ID is unique in the full project.
  // Only a bag from this endpoint can be opened, so a label that nobody printed does not work.
  'POST /api/mod/bags': async ({ db, body, moderator, now }) => {
    const location = String(body.location ?? ''), count = body.count;
    if (!Number.isInteger(count) || count < 1 || count > 200) refuse(400, 'count');
    if (!await db.prepare('SELECT 1 FROM locations WHERE code = ?').bind(location).first()) refuse(404, 'location_unknown');
    const [made] = await db.batch([
      db.prepare(
        `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?1)
         INSERT INTO bags (id, location_code, created_at)
         SELECT printf('B%06d', (SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) FROM bags) + n), ?2, ?3 FROM seq
         RETURNING id`).bind(count, location, now),
      event(db, now, null, moderator.email, 'labels', { location, count }),
    ]);
    return { labels: made.results.map(r => bagLabel(location, r.id)).sort() };
  },

  // Overview of the bags of one location: state of each bag (new, open, closed, forced) and its photo counts.
  'GET /api/mod/bags': async ({ db, url }) => {
    const location = url.searchParams.get('location') ?? '';
    const [bags, sessions] = (await db.batch([
      db.prepare('SELECT id FROM bags WHERE location_code = ? ORDER BY id').bind(location),
      db.prepare(
        `SELECT s.bag_id, s.moderator, s.opened_at, s.closed_at, s.close_type,
           COALESCE(SUM(e.images), 0) AS images, COALESCE(SUM(e.verified), 0) AS verified, COALESCE(SUM(e.flagged), 0) AS flagged
         FROM sessions s JOIN bags b ON b.id = s.bag_id LEFT JOIN enrollments e ON e.session_id = s.id
         WHERE b.location_code = ? GROUP BY s.id ORDER BY s.opened_at`).bind(location),
    ])).map(r => r.results);
    // Image records of closed sessions that are not verified. A photo that reached the archive in a later session
    // of the same bag does not count. The read runs only if a counter shows such a record.
    const missing = !sessions.some(s => s.closed_at && s.images > s.verified) ? [] : (await db.prepare(
      `SELECT s.bag_id, COUNT(DISTINCT i.sha256) AS n
       FROM enrollments e JOIN sessions s ON s.id = e.session_id JOIN bags b ON b.id = s.bag_id
         JOIN images i ON i.session_id = s.id AND i.token_hash = e.token_hash AND i.state <> 'verified'
       WHERE b.location_code = ? AND s.closed_at IS NOT NULL AND e.images > e.verified
         AND NOT EXISTS (SELECT 1 FROM sessions o JOIN images v ON v.session_id = o.id AND v.sha256 = i.sha256
                         WHERE o.bag_id = s.bag_id AND v.state = 'verified')
       GROUP BY s.bag_id`).bind(location).all()).results;
    // The last session of a bag gives its state and its time. The counts are the sums of all its sessions.
    const of = Map.groupBy(sessions, s => s.bag_id);
    return { bags: bags.map(({ id }) => {
      const all = of.get(id) ?? [], last = all.at(-1);
      return {
        label: bagLabel(location, id),
        state: !last ? 'new' : !last.closed_at ? 'open' : last.close_type === 'forced' ? 'forced' : 'closed',
        moderator: last?.moderator ?? null, at: last ? last.closed_at ?? last.opened_at : null, sessions: all.length,
        photos: all.reduce((n, s) => n + s.verified, 0), flagged: all.reduce((n, s) => n + s.flagged, 0),
        missing: missing.find(m => m.bag_id === id)?.n ?? 0,
      };
    }) };
  },

  // Open session of this moderator with its phones, for the moderator screen. The screen polls it.
  'GET /api/mod/session': async ({ db, moderator, now }) => {
    const s = await openSession(db, moderator.email);
    if (!s) return { session: null };
    const phones = await phonesOf(db, s.id, now);
    return { session: { id: s.id, label: bagLabel(s.location_code, s.bag_id), material: s.material, opened_at: s.opened_at, phones, blockers: blockersOf(phones) } };
  },

  'POST /api/mod/session': async ({ db, env, body, moderator, now }) => {
    const bag = parseLabel(body.label);
    if (!bag) refuse(400, 'label');
    if (!MATERIALS.includes(body.material)) refuse(400, 'material');
    const state = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM bags WHERE id = ?1 AND location_code = ?2) AS known,
              (SELECT COUNT(*) FROM sessions WHERE bag_id = ?1 AND closed_at IS NULL) AS open,
              (SELECT COUNT(*) FROM sessions WHERE bag_id = ?1 AND closed_at IS NOT NULL) AS closed,
              (SELECT COUNT(*) FROM sessions WHERE moderator = ?3 AND closed_at IS NULL) AS mine`)
      .bind(bag.bag, bag.location, moderator.email).first();
    if (!state.known) refuse(404, 'bag_unknown');
    if (state.mine) refuse(409, 'mod_has_bag');
    if (state.open) refuse(409, 'bag_open');
    const reason = String(body.reason ?? '').trim();
    if (state.closed && reason.length < 10)
      refuse(409, 'reopen_reason', { needs_reason: true });
    const id = crypto.randomUUID();
    try {
      await db.batch([
        db.prepare('INSERT INTO sessions (id, bag_id, material, moderator, opened_at) VALUES (?, ?, ?, ?, ?)')
          .bind(id, bag.bag, body.material, moderator.email, now),
        event(db, now, id, moderator.email, state.closed ? 'reopen' : 'open', state.closed ? { reason } : null),
      ]);
    } catch (e) {
      // Two requests at the same time: the unique indexes of the database refuse the second one.
      if (/constraint/i.test(e.message)) refuse(409, 'open_race');
      throw e;
    }
    // A close whose manifest write failed left a closed session with no manifest file. Write it now.
    for (const old of (await db.prepare('SELECT id FROM sessions WHERE closed_at IS NOT NULL AND manifest_at IS NULL LIMIT 2').all()).results)
      await writeManifest(env, db, old.id).catch(e => console.error('manifest', old.id, e));
    return { id, label: bagLabel(bag.location, bag.bag) };
  },

  'POST /api/mod/session/close': async ({ db, env, body, moderator, now }) => {
    const s = await mustHaveOpen(db, moderator.email);
    const blockers = blockersOf(await phonesOf(db, s.id, now));
    const reason = String(body.force_reason ?? '').trim(), forced = reason !== '';
    if (forced && reason.length < 10) refuse(400, 'force_reason');
    if (!forced && blockers.length) refuse(409, 'blocked', { blockers });
    if (!forced && body.tray_empty !== true) refuse(400, 'tray');
    await db.batch([
      db.prepare('UPDATE sessions SET closed_at = ?, close_type = ?, force_reason = ? WHERE id = ? AND closed_at IS NULL')
        .bind(now, forced ? 'forced' : 'normal', forced ? reason : null, s.id),
      event(db, now, s.id, moderator.email, forced ? 'force close' : 'close', forced ? { reason, blockers } : null),
    ]);
    // The close is final at this point. A manifest write that fails does not undo it: the next open writes the file.
    const manifest = await writeManifest(env, db, s.id).catch(e => { console.error('manifest', s.id, e); return false; });
    return { closed: true, forced, manifest };
  },

  // New one-time code for the QR code on the moderator screen. Only one code is valid at a time.
  'POST /api/mod/enroll-code': async ({ db, moderator, now }) => {
    const s = await mustHaveOpen(db, moderator.email);
    const code = randomToken(16), expires_at = new Date(Date.parse(now) + CODE_LIFE_MS).toISOString();
    await db.batch([
      db.prepare('DELETE FROM enroll_codes WHERE session_id = ? AND used_at IS NULL').bind(s.id),
      db.prepare('INSERT INTO enroll_codes (code_hash, session_id, expires_at) VALUES (?, ?, ?)').bind(await hash(code), s.id, expires_at),
    ]);
    return { code, expires_at };
  },

  'POST /api/mod/phone/remove': async ({ db, body, moderator, now }) => {
    const s = await mustHaveOpen(db, moderator.email);
    const phone = await db.prepare(
      'UPDATE enrollments SET removed_at = ?1 WHERE rowid = ?2 AND session_id = ?3 AND removed_at IS NULL RETURNING operator_name AS name')
      .bind(now, Number.isInteger(body.id) ? body.id : -1, s.id).first();
    if (!phone) refuse(404, 'phone_unknown');
    await event(db, now, s.id, moderator.email, 'remove', { phone: body.id, name: phone.name }).run();
    return { removed: true };
  },

  // Public endpoint. Changes a one-time code into the session of one phone.
  'POST /api/enroll': async ({ db, body, now }) => {
    const code = String(body.code ?? ''), phone = String(body.phone ?? '');
    // The name goes into the record and onto the moderator screen: one line, no control characters.
    const name = String(body.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^[A-Za-z0-9_-]{22}$/.test(code)) refuse(403, 'code');
    if (!name || name.length > 40) refuse(400, 'name');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(phone)) refuse(400, 'phone_id');
    // A phone that holds photos of one bag must not join a different bag: its photos could not reach their bag.
    // The phone names the bag of its photos. This check does not use up the code.
    if (body.holds !== undefined) {
      const target = await db.prepare(
        `SELECT b.location_code, s.bag_id FROM enroll_codes c JOIN sessions s ON s.id = c.session_id JOIN bags b ON b.id = s.bag_id
         WHERE c.code_hash = ?`).bind(await hash(code)).first();
      if (target && bagLabel(target.location_code, target.bag_id) !== body.holds)
        refuse(409, 'phone_holds', { bag: String(body.holds).slice(0, 20) });
    }
    // One statement uses up the code. If two phones send the same code, only the first gets a session.
    const used = await db.prepare(
      `UPDATE enroll_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1
         AND session_id IN (SELECT id FROM sessions WHERE closed_at IS NULL) RETURNING session_id`)
      .bind(now, await hash(code)).first();
    if (!used) refuse(403, 'code');
    // The phone keeps the token in a cookie that page code cannot read. The database keeps only its hash.
    const token = randomToken(32);
    await db.batch([
      // The same phone joins this session again: its new session reports the photos that it holds.
      db.prepare('UPDATE enrollments SET queue_len = 0 WHERE session_id = ? AND phone_id = ?').bind(used.session_id, phone),
      db.prepare('INSERT INTO enrollments (token_hash, session_id, phone_id, operator_name, enrolled_at) VALUES (?, ?, ?, ?, ?)')
        .bind(await hash(token), used.session_id, phone, name, now),
      event(db, now, used.session_id, `operator:${name}`, 'enroll', { phone }),
    ]);
    return json({ enrolled: true }, 200, { 'Set-Cookie': `${OPERATOR_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400` });
  },

  // The capture screen polls this. With "queue" the phone reports how many photos it holds:
  // the moderator screen shows the number, and the close rule uses it.
  'GET /api/op/session': async ({ db, url, operator, now }) => {
    const queue = Number(url.searchParams.get('queue') ?? NaN);
    if (Number.isInteger(queue) && queue >= 0) await reportQueue(db, operator, queue, now).run();
    return {
      label: bagLabel(operator.location_code, operator.bag_id), material: operator.material,
      name: operator.name, done: operator.done_at !== null, verified: operator.verified,
    };
  },

  'POST /api/op/done': async ({ db, body, operator, now }) => {
    const done = body.done === true;
    await db.batch([
      db.prepare('UPDATE enrollments SET done_at = ? WHERE token_hash = ?').bind(done ? now : null, operator.token_hash),
      ...(Number.isInteger(body.queue) && body.queue >= 0 ? [reportQueue(db, operator, body.queue, now)] : []),
      event(db, now, operator.session_id, `operator:${operator.name}`, done ? 'done' : 'not done'),
    ]);
    return { done };
  },

  // Photo upload. The request body is the JPEG file. The address carries the values that the phone computed:
  // sha (SHA-256 of the file), bag (label of the bag of this photo), w and h (pixel size), taken (capture time),
  // left (photos that stay on the phone after this one), and the quality numbers: blur (sharpness score),
  // clipped and dark (share of pure white and of pure black), flag (the operator kept the photo after a warning).
  // The archive checks the body against the SHA-256 and refuses a body that differs. It never overwrites a file.
  // Then the Worker reads the stored file data back and compares it. Only after that the photo is "verified",
  // and only that answer lets the phone delete its copy.
  'PUT /api/op/photo': async ({ request, env, url, db, operator, now }) => {
    const q = url.searchParams, sha = q.get('sha') ?? '';
    const bytes = Number(request.headers.get('Content-Length') ?? NaN);
    const width = Number(q.get('w')), height = Number(q.get('h')), left = Number(q.get('left') ?? 0);
    const taken = /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/.test(q.get('taken') ?? '') ? q.get('taken') : null;
    if (!/^[0-9a-f]{64}$/.test(sha)) refuse(400, 'photo_hash');
    if (!(Number.isInteger(bytes) && bytes >= 1 && bytes <= MAX_PHOTO_BYTES)) refuse(bytes > MAX_PHOTO_BYTES ? 413 : 411, 'photo_size');
    // ponytail: the pixel size comes from the phone. The Worker does not parse the JPEG header of the stream.
    if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width < 65536 && height < 65536
      && width * height >= MIN_PIXELS)) refuse(400, 'photo_pixels');
    // A photo goes only into the bag in which it was taken. A phone that joined bag B cannot put a photo of bag A into B.
    const label = bagLabel(operator.location_code, operator.bag_id);
    if (q.get('bag') !== label) refuse(409, 'wrong_bag', { bag: label });

    // The quality numbers are records, not checks. A value that is missing or out of range counts as "not measured".
    const measured = (name, max) => { const v = Number(q.get(name) ?? NaN); return v >= 0 && v <= max ? v : null; };
    await db.prepare(
      `INSERT OR IGNORE INTO images (session_id, sha256, token_hash, bytes, width, height, captured_at, blur_score, clipped, dark, flagged, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .bind(operator.session_id, sha, operator.token_hash, bytes, width, height, taken,
        measured('blur', 255), measured('clipped', 1), measured('dark', 1), q.get('flag') === '1' ? 1 : 0, now).run();

    // A repeated upload of the same file finds the name in use and stores nothing.
    // The answer of the write does not decide: the read below does, for a new file and for a repeated one.
    const key = `${bagFolder(operator.location_code, operator.bag_id)}/${sha}.jpg`;
    await env.ARCHIVE.put(key, request.body, { sha256: sha, onlyIf: WRITE_ONCE, httpMetadata: { contentType: 'image/jpeg' } })
      .catch(e => console.error('archive write', key, e));
    const stored = await env.ARCHIVE.head(key).catch(e => console.error('archive read', key, e));
    if (!stored || stored.size !== bytes || !stored.checksums.sha256 || hex(stored.checksums.sha256) !== sha) refuse(502, 'archive');

    // The record changes only while the session is open, so the manifest of a closed session stays complete.
    const [, , state] = await db.batch([
      db.prepare(
        `UPDATE images SET state = 'verified', verified_at = ?1 WHERE session_id = ?2 AND sha256 = ?3 AND state <> 'verified'
           AND EXISTS (SELECT 1 FROM sessions WHERE id = ?2 AND closed_at IS NULL)`).bind(now, operator.session_id, sha),
      reportQueue(db, operator, Number.isInteger(left) && left >= 0 ? left : 0, now),
      db.prepare('SELECT state, (SELECT verified FROM enrollments WHERE token_hash = ?3) AS count FROM images WHERE session_id = ?1 AND sha256 = ?2')
        .bind(operator.session_id, sha, operator.token_hash),
    ]);
    if (state.results[0]?.state !== 'verified') refuse(401, 'op_closed', { ended: 'closed' });
    // "count": photos of this phone in the archive, for the count on its screen.
    return { verified: true, sha, count: state.results[0].count };
  },
};

// Body of a POST request as an object. The size limit keeps a large body out of memory.
export async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') ?? NaN);
  if (!(length <= 4096)) refuse(length > 4096 ? 413 : 411, 'body_size');
  const value = await request.json().catch(() => null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : refuse(400, 'body_json');
}
