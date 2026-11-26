// Worker for rezanci.net. Static files come from ./public. This code handles /api/ only:
// it checks who sent the request, then calls the handler from api.js.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { json, routes as apiRoutes, readJson, operatorFor, Refusal } from './api.js';

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

const routes = {
  // Public endpoint, so it makes no storage call: each request must be cheap.
  // COMMIT is set at deploy time, so anyone can compare the running code with the repository.
  'GET /api/health': ({ env }) => ({ ok: true, commit: env.COMMIT ?? 'dev' }),
  ...apiRoutes,
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const safe = request.method === 'GET' || request.method === 'HEAD';
      if (!safe && isCrossSite(request.headers, url.origin)) return json({ error: 'cross-site request refused' }, 403);
      const ctx = { request, env, url, db: env.DB, now: new Date().toISOString() };

      // The login checks run here and not in the handlers, so no endpoint can omit them.
      if (url.pathname.startsWith('/api/mod')) {
        const issuer = `https://${env.ACCESS_TEAM}`;
        accessKeys ??= createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
        const claims = await accessClaims(request.headers.get('Cf-Access-Jwt-Assertion'), accessKeys, issuer, env.ACCESS_AUD);
        if (!claims) return json({ error: 'moderator login required' }, 401);
        ctx.moderator = { email: claims.email.toLowerCase(), amr: claims.amr };
      }
      if (url.pathname.startsWith('/api/op')) {
        const operator = await operatorFor(request, env.DB);
        // "ended" tells the phone why its session stopped, so the screen can show the reason.
        if (!operator) return json({ error: 'This phone has no session. Scan the code on the moderator screen.', ended: 'none' }, 401);
        if (operator.removed_at) return json({ error: 'The moderator removed this phone from the bag.', ended: 'removed' }, 401);
        if (operator.closed_at) return json({ error: 'This bag is closed.', ended: 'closed' }, 401);
        ctx.operator = operator;
      }

      const handler = routes[`${request.method} ${url.pathname}`];
      if (!handler) return json({ error: 'not found' }, 404);
      if (request.method === 'POST') ctx.body = await readJson(request);
      const answer = await handler(ctx);
      return answer instanceof Response ? answer : json(answer);
    } catch (e) {
      if (e instanceof Refusal) return json({ error: e.message, ...e.extra }, e.status);
      console.error(e);   // goes to the Worker log
      return json({ error: 'server error' }, 500);
    }
  },
};
