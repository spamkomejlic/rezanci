// Worker for rezanci.net. Static files come from ./public. This code handles /api/ only.

// Headers for each API answer: no cache, no use inside a frame, no content type guess, no referrer.
const API_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const json = (body, status = 200) => Response.json(body, { status, headers: API_HEADERS });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // Public endpoint, so it makes no storage call: each request must be cheap.
    // COMMIT is set at deploy time, so anyone can compare the running code with the repository.
    if (pathname === '/api/health') return json({ ok: true, commit: env.COMMIT ?? 'dev' });
    return json({ error: 'not found' }, 404);
  },
};
