// Worker for rezanci.net. Static files come from ./public. This code handles /api/ only.
import { createRemoteJWKSet, jwtVerify } from 'jose';

// Headers for each API answer: no cache, no use inside a frame, no content type guess, no referrer.
const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const json = (body, status = 200) => Response.json(body, { status, headers: API_HEADERS });

// True if a browser sent the request from a different site. The Origin header is the fallback
// for a browser that sends no Sec-Fetch-Site header. A client that sends neither is not a browser.
export function isCrossSite(headers, selfOrigin) {
  const site = headers.get('Sec-Fetch-Site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = headers.get('Origin');
  return origin !== null && origin !== selfOrigin;
}

// Returns the claims of a moderator login token, or null if the token is not valid.
// Cloudflare Access adds the token to each request that passed the moderator login. The Worker
// checks it again: signature, issuer, audience of this application, expiry, and a person's email.
// A path that Access does not cover by mistake then stays closed.
export async function accessClaims(token, keys, issuer, audience) {
  if (!token || !audience) return null;
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms: ['RS256'] });
    return typeof payload.email === 'string' && payload.email ? payload : null;
  } catch {
    return null;
  }
}

// Signing keys of the Access team. jose keeps them and loads them again for an unknown key ID.
let accessKeys;

// One entry per endpoint: "METHOD /path". A path that is not in this table does not exist.
// A handler under /api/mod gets the claims of the moderator as the last argument.
const routes = {
  // Public endpoint, so it makes no storage call: each request must be cheap.
  // COMMIT is set at deploy time, so anyone can compare the running code with the repository.
  'GET /api/health': (request, env) => json({ ok: true, commit: env.COMMIT ?? 'dev' }),
  'GET /api/mod/whoami': (request, env, url, moderator) => json({ email: moderator.email, amr: moderator.amr ?? null }),
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const safe = request.method === 'GET' || request.method === 'HEAD';
    if (!safe && isCrossSite(request.headers, url.origin)) return json({ error: 'cross-site request refused' }, 403);
    let moderator = null;
    // The login check runs here and not in the handlers, so no moderator endpoint can omit it.
    if (url.pathname.startsWith('/api/mod')) {
      const issuer = `https://${env.ACCESS_TEAM}`;
      accessKeys ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      moderator = await accessClaims(request.headers.get('Cf-Access-Jwt-Assertion'), accessKeys, issuer, env.ACCESS_AUD);
      if (!moderator) return json({ error: 'moderator login required' }, 401);
    }
    const handler = routes[`${request.method} ${url.pathname}`];
    return handler ? handler(request, env, url, moderator) : json({ error: 'not found' }, 404);
  },
};
