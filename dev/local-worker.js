// Worker entry for a local run only (npm run local). The live site uses src/worker.js.
//
// One thing differs from the live site: a local machine has no Cloudflare Access, so each call to
// /api/mod/ counts as the moderator "moderator@localhost". All other paths run the real Worker code.
// This entry answers only on a local address.
import worker from '../src/worker.js';
import { routes, readJson, refusal, json, Refusal } from '../src/api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return refusal(404, 'not_found');
    if (!url.pathname.startsWith('/api/mod')) return worker.fetch(request, env);
    try {
      const handler = routes[`${request.method} ${url.pathname}`];
      if (!handler) return refusal(404, 'not_found');
      const ctx = { request, url, env, db: env.DB, now: new Date().toISOString(), moderator: { email: 'moderator@localhost' } };
      if (request.method === 'POST') ctx.body = await readJson(request);
      const answer = await handler(ctx);
      return answer instanceof Response ? answer : json(answer);
    } catch (e) {
      if (e instanceof Refusal) return refusal(e.status, e.code, e.extra);
      console.error(e);
      return refusal(500, 'server');
    }
  },
};
