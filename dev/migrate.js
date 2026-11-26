// Applies the files of ./migrations to a local database. The tests and the local run (npm run local) use it.
// The live database gets its migrations from wrangler (wrangler d1 migrations apply rezanci --remote).
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Statements of one SQL file. A trigger body holds semicolons, so a statement that has BEGIN ends at END.
export function statements(sql) {
  const found = [];
  let current = '';
  for (const part of sql.replace(/--.*$/gm, '').split(';')) {
    current += part;
    if (/\bBEGIN\b/.test(current) && !/\bEND\s*$/.test(current)) { current += ';'; continue; }
    if (current.trim()) found.push(current.trim());
    current = '';
  }
  return found;
}

export async function migrate(db) {
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort())
    for (const statement of statements(readFileSync(new URL(file, folder), 'utf8'))) await db.prepare(statement).run();
}

// In Node the body of a request is a stream with no known length, and the archive takes only a stream
// with a known length. The live Worker gives the archive the request stream as it is.
// For the tests, this wrapper reads the stream into memory first.
export const buffered = archive => ({
  put: async (key, value, options) =>
    archive.put(key, value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value, options),
  head: key => archive.head(key),
  get: key => archive.get(key),
});

// Run as a script: makes an empty local database for the local run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = path => fileURLToPath(new URL(path, import.meta.url));
  rmSync(here('./.wrangler'), { recursive: true, force: true });
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy({ configPath: here('./wrangler.local.jsonc'), persist: { path: here('./.wrangler/state/v3') } });
  await migrate(proxy.env.DB);
  await proxy.dispose();
  console.log('local database: empty, migrations applied');
}
