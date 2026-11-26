// Local server for development: npm run local   (or: node dev/local-server.js [port])
//
// It serves the files of ./public and runs the real API code on a local database in memory.
// One thing differs from the live site: there is no Cloudflare Access here, so each call to
// /api/mod/ counts as the moderator "moderator@localhost". This file is not part of the Worker
// and never runs on the live site.
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/worker.js';
import { routes, readJson, refusal, json, Refusal } from '../src/api.js';

const port = Number(process.argv[2] ?? 8788);
const root = fileURLToPath(new URL('..', import.meta.url));
const pub = join(root, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

// The same response headers as on the live site, so the content security policy applies here too.
const pageHeaders = Object.fromEntries(readFileSync(join(pub, '_headers'), 'utf8').split('\n')
  .filter(line => /^\s+\S+:/.test(line)).map(line => { const at = line.indexOf(':'); return [line.slice(0, at).trim(), line.slice(at + 1).trim()]; }));

const { env } = await getPlatformProxy({ persist: false });
for (const file of readdirSync(join(root, 'migrations')).sort())
  for (const statement of readFileSync(join(root, 'migrations', file), 'utf8').replace(/--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean))
    await env.DB.prepare(statement).run();

// A moderator endpoint, called the way worker.js calls it after the login check.
async function moderatorCall(request, url) {
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
}

function staticFile(pathname) {
  const wanted = normalize(join(pub, decodeURIComponent(pathname)));
  if (wanted !== pub && !wanted.startsWith(pub + sep)) return {};
  if (existsSync(wanted) && statSync(wanted).isDirectory())
    return pathname.endsWith('/') ? { file: join(wanted, 'index.html') } : { redirect: pathname + '/' };
  if (existsSync(wanted)) return { file: wanted };
  return existsSync(wanted + '.html') ? { file: wanted + '.html' } : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const answer = await (url.pathname.startsWith('/api/mod') ? moderatorCall(request, url) : worker.fetch(request, { DB: env.DB, COMMIT: 'local' }));
    const headers = Object.fromEntries(answer.headers);
    if (answer.headers.getSetCookie().length) headers['set-cookie'] = answer.headers.getSetCookie();
    res.writeHead(answer.status, headers).end(Buffer.from(await answer.arrayBuffer()));
    return;
  }
  if (url.pathname === '/cdn-cgi/access/logout') return res.writeHead(302, { Location: '/' }).end();
  const { file, redirect } = staticFile(url.pathname);
  if (redirect) return res.writeHead(307, { Location: redirect }).end();
  if (!file || !existsSync(file)) return res.writeHead(404, pageHeaders).end('not found');
  res.writeHead(200, { ...pageHeaders, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
}).listen(port, () => console.log(`local app at http://localhost:${port}/  (moderator screen: /mod/)`));
