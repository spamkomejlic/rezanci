// Checks of the pages that need no browser: texts, element names, content security policy, vendored file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { TEXT } from '../public/i18n.js';
import { ERRORS, MATERIALS } from '../src/api.js';

const pub = new URL('../public/', import.meta.url);
const read = path => readFileSync(new URL(path, pub), 'utf8');
const pages = ['index.html', 'join.html', 'capture.html', 'mod/index.html', 'mod/labels.html', 'mod/bags.html', 'mod/photos.html'];
const scriptOf = html => /<script type="module" src="\/([^"]+)"><\/script>/.exec(html)[1];

test('each text that a page uses exists in English and in Serbian', () => {
  const used = new Set();
  for (const page of pages) {
    const html = read(page);
    for (const m of html.matchAll(/data-t(?:-placeholder|-label)?="([^"]+)"/g)) used.add(m[1]);
    // In a script, each quoted word group with dots is a text key: 'cap.saved', 'mod.close.go'.
    for (const m of (read(scriptOf(html)) + read('ui.js') + read('scan.js')).matchAll(/'([a-z]+(?:\.[a-z_]+)+)'/g)) used.add(m[1]);
  }
  // Keys that a script builds from a server value.
  for (const material of MATERIALS) used.add('material.' + material);
  for (const ended of ['none', 'closed', 'removed']) used.add('cap.ended.' + ended);
  for (const kind of ['not_done', 'queue', 'not_verified', 'review']) used.add('mod.block.' + kind);
  for (const mark of ['approved', 'rejected', 'flagged']) used.add('photos.mark.' + mark);
  for (const state of ['new', 'open', 'closed', 'forced']) used.add('bags.state.' + state);
  // Each refusal of the API, but not the two that only a broken client can cause.
  for (const code of Object.keys(ERRORS)) if (!code.startsWith('body_')) used.add('err.' + code);
  used.add('err.offline');

  assert.ok(used.size > 80, 'the scan found the keys');
  for (const key of used) for (const language of ['en', 'sr']) assert.ok(TEXT[language][key], `${language} has no text "${key}"`);
  assert.deepEqual(Object.keys(TEXT.sr).sort(), Object.keys(TEXT.en).sort());
  for (const key of Object.keys(TEXT.en)) assert.ok(used.has(key), `text "${key}" is not in use`);
});

test('each element that a page script names exists in the page', () => {
  for (const page of pages) {
    const html = read(page), script = scriptOf(html);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
    const code = read(script);
    const named = [...code.matchAll(/\$\('([^']+)'\)/g), ...code.matchAll(/show\('main'((?:, '[^']+')+)\)/g)]
      .flatMap(m => m[1].startsWith(',') ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [m[1]]);
    assert.ok(named.length > 0, `${script}: the scan found element names`);
    for (const id of [...named, 'lang']) assert.ok(ids.has(id), `${page} has no element "${id}" that ${script} uses`);
  }
});

test('no page has inline code or inline style, which the content security policy blocks', () => {
  for (const page of pages) {
    const html = read(page);
    assert.ok(!/<script(?![^>]*\ssrc=)/i.test(html), `${page}: inline script`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${page}: inline event handler`);
    assert.ok(!/\sstyle\s*=|<style/i.test(html), `${page}: inline style`);
    assert.ok(!/https?:\/\//i.test(html), `${page}: address of a different site`);
  }
});

test('the service worker keeps each file that the operator pages load, and each kept file exists', () => {
  const shell = [...read('sw.js').match(/const SHELL = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const file = path => ({ '/': 'index.html', '/capture': 'capture.html', '/join': 'join.html' })[path] ?? path.slice(1);
  // One missing file stops the install of the service worker, so each name must be a real file.
  for (const path of shell) assert.ok(existsSync(new URL(file(path), pub)), `sw.js keeps "${path}", which is not a file`);
  // Each file that an operator page needs: the page, its style sheet, its script, and each module behind the script.
  const needed = new Set();
  const follow = script => {
    if (needed.has(script)) return;
    needed.add(script);
    for (const m of read(script.slice(1)).matchAll(/from '(\/[^']+)'/g)) follow(m[1]);
  };
  for (const path of ['/', '/capture', '/join']) {
    needed.add(path);
    const html = read(file(path));
    follow('/' + scriptOf(html));
    for (const m of html.matchAll(/<link rel="(?:stylesheet|manifest|icon)" href="([^"]+)"/g)) needed.add(m[1]);
  }
  for (const path of needed) assert.ok(shell.includes(path), `sw.js does not keep "${path}"`);
  assert.ok(!shell.some(path => path.startsWith('/api') || path.startsWith('/mod')), 'no API call and no moderator page in the copy');
});

test('the vendored QR library is the recorded file and makes a code', async () => {
  const recorded = /SHA-256: ([0-9a-f]{64})/.exec(read('vendor/qrcode.NOTICE.txt'))[1];
  assert.equal(createHash('sha256').update(readFileSync(new URL('vendor/qrcode.js', pub))).digest('hex'), recorded);
  const { qrcode } = await import('../public/vendor/qrcode.js');
  const qr = qrcode(0, 'M');
  qr.addData('https://rezanci.net/join#c=' + 'A'.repeat(22));
  qr.make();
  const count = qr.getModuleCount();
  assert.ok(count >= 21 && count <= 45, `module count ${count}`);
  let dark = 0;
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) dark++;
  assert.ok(dark > count * count * 0.3 && dark < count * count * 0.7, 'a QR code is about half dark');
});
