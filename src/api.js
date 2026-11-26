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
};
export class Refusal extends Error {
  constructor(status, code, extra = {}) { super(ERRORS[code]); this.status = status; this.code = code; this.extra = extra; }
}
const refuse = (status, code, extra) => { throw new Refusal(status, code, extra); };
export const refusal = (status, code, extra = {}) => json({ error: ERRORS[code], code, ...extra }, status);

export const MATERIALS = ['shredded', 'torn', 'sheets'];
export const OPERATOR_COOKIE = '__Host-op';
const CODE_LIFE_MS = 120_000;   // a one-time enrollment code works for 2 minutes
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

// One line in the append-only event record.
const event = (db, at, session, actor, type, detail = null) =>
  db.prepare('INSERT INTO events (at, session_id, actor, type, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(at, session, actor, type, detail && JSON.stringify(detail));

const openSession = (db, moderator) => db.prepare(
  `SELECT s.id, s.bag_id, b.location_code, s.material, s.opened_at
   FROM sessions s JOIN bags b ON b.id = s.bag_id WHERE s.moderator = ? AND s.closed_at IS NULL`).bind(moderator).first();
const mustHaveOpen = async (db, moderator) => (await openSession(db, moderator)) ?? refuse(409, 'no_bag');

const phonesOf = async (db, session) => (await db.prepare(
  `SELECT e.rowid AS id, e.operator_name AS name, e.enrolled_at, e.done_at, e.removed_at,
     COUNT(i.sha256) AS images, COALESCE(SUM(i.state = 'verified'), 0) AS verified, COALESCE(SUM(i.flagged), 0) AS flagged
   FROM enrollments e LEFT JOIN images i ON i.token_hash = e.token_hash
   WHERE e.session_id = ? GROUP BY e.token_hash ORDER BY e.enrolled_at, e.rowid`).bind(session).all()).results;

// Reasons that block a normal close. An empty list means that the close rule holds:
// each phone is Done and each image record is verified.
const blockersOf = phones => [
  ...phones.filter(p => !p.removed_at && !p.done_at).map(p => ({ kind: 'not_done', name: p.name })),
  ...phones.filter(p => p.images > p.verified).map(p => ({ kind: 'not_verified', name: p.name, count: p.images - p.verified })),
];

// Session of the operator phone that sent the request, from its cookie. Null if there is none.
export async function operatorFor(request, db) {
  const m = new RegExp(`(?:^|;\\s*)${OPERATOR_COOKIE}=([A-Za-z0-9_-]{43})(?:;|$)`).exec(request.headers.get('Cookie') ?? '');
  return m && db.prepare(
    `SELECT e.token_hash, e.session_id, e.operator_name AS name, e.done_at, e.removed_at,
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

  // Open session of this moderator with its phones, for the moderator screen. The screen polls it.
  'GET /api/mod/session': async ({ db, moderator }) => {
    const s = await openSession(db, moderator.email);
    if (!s) return { session: null };
    const phones = await phonesOf(db, s.id);
    return { session: { id: s.id, label: bagLabel(s.location_code, s.bag_id), material: s.material, opened_at: s.opened_at, phones, blockers: blockersOf(phones) } };
  },

  'POST /api/mod/session': async ({ db, body, moderator, now }) => {
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
    return { id, label: bagLabel(bag.location, bag.bag) };
  },

  'POST /api/mod/session/close': async ({ db, body, moderator, now }) => {
    const s = await mustHaveOpen(db, moderator.email);
    const blockers = blockersOf(await phonesOf(db, s.id));
    const reason = String(body.force_reason ?? '').trim(), forced = reason !== '';
    if (forced && reason.length < 10) refuse(400, 'force_reason');
    if (!forced && blockers.length) refuse(409, 'blocked', { blockers });
    if (!forced && body.tray_empty !== true) refuse(400, 'tray');
    // ponytail: no manifest file yet. It comes with the upload step, when image records exist.
    await db.batch([
      db.prepare('UPDATE sessions SET closed_at = ?, close_type = ?, force_reason = ? WHERE id = ? AND closed_at IS NULL')
        .bind(now, forced ? 'forced' : 'normal', forced ? reason : null, s.id),
      event(db, now, s.id, moderator.email, forced ? 'force close' : 'close', forced ? { reason, blockers } : null),
    ]);
    return { closed: true, forced };
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
    // One statement uses up the code. If two phones send the same code, only the first gets a session.
    const used = await db.prepare(
      `UPDATE enroll_codes SET used_at = ?1 WHERE code_hash = ?2 AND used_at IS NULL AND expires_at > ?1
         AND session_id IN (SELECT id FROM sessions WHERE closed_at IS NULL) RETURNING session_id`)
      .bind(now, await hash(code)).first();
    if (!used) refuse(403, 'code');
    // The phone keeps the token in a cookie that page code cannot read. The database keeps only its hash.
    const token = randomToken(32);
    await db.batch([
      db.prepare('INSERT INTO enrollments (token_hash, session_id, phone_id, operator_name, enrolled_at) VALUES (?, ?, ?, ?, ?)')
        .bind(await hash(token), used.session_id, phone, name, now),
      event(db, now, used.session_id, `operator:${name}`, 'enroll', { phone }),
    ]);
    return json({ enrolled: true }, 200, { 'Set-Cookie': `${OPERATOR_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400` });
  },

  'GET /api/op/session': ({ operator }) => ({
    label: bagLabel(operator.location_code, operator.bag_id), material: operator.material,
    name: operator.name, done: operator.done_at !== null,
  }),

  'POST /api/op/done': async ({ db, body, operator, now }) => {
    const done = body.done === true;
    await db.batch([
      db.prepare('UPDATE enrollments SET done_at = ? WHERE token_hash = ?').bind(done ? now : null, operator.token_hash),
      event(db, now, operator.session_id, `operator:${operator.name}`, done ? 'done' : 'not done'),
    ]);
    return { done };
  },
};

// Body of a POST request as an object. The size limit keeps a large body out of memory.
export async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') ?? NaN);
  if (!(length <= 4096)) refuse(length > 4096 ? 413 : 411, 'body_size');
  const value = await request.json().catch(() => null);
  return value && typeof value === 'object' && !Array.isArray(value) ? value : refuse(400, 'body_json');
}
