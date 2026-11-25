// Worker for rezanci.net. Static files come from ./public. This code handles /api/ only.

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

// One entry per endpoint: "METHOD /path". A path that is not in this table does not exist.
const routes = {
  // Public endpoint, so it makes no storage call: each request must be cheap.
  // COMMIT is set at deploy time, so anyone can compare the running code with the repository.
  'GET /api/health': (request, env) => json({ ok: true, commit: env.COMMIT ?? 'dev' }),
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const safe = request.method === 'GET' || request.method === 'HEAD';
    if (!safe && isCrossSite(request.headers, url.origin)) return json({ error: 'cross-site request refused' }, 403);
    const handler = routes[`${request.method} ${url.pathname}`];
    return handler ? handler(request, env, url) : json({ error: 'not found' }, 404);
  },
};
