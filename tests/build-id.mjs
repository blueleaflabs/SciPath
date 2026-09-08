/**
 * A PAGE LEFT OPEN ACROSS A DEPLOY (2.9).
 *
 * The build names itself once, the middleware says it on every response,
 * and the shell compares it with its own — on responses the page is
 * already getting, and once when a hidden tab is looked at again. What
 * this pins is the shape: no polling for it, a reload only when quiet.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const config = fs.readFileSync('astro.config.mjs', 'utf8');
const middleware = fs.readFileSync('src/middleware.ts', 'utf8');
const shell = fs.readFileSync('src/components/AppShell.astro', 'utf8');

test('the build names itself once, at build time', () => {
  assert.match(config, /'import\.meta\.env\.PUBLIC_BUILD': JSON\.stringify\(/);
  assert.match(config, /CF_PAGES_COMMIT_SHA/, 'the commit on Cloudflare');
});

test('every response says which build sent it, and the version endpoint does no work', () => {
  assert.match(middleware, /\[BUILD_HEADER\]: BUILD,/, 'in the headers every response gets');
  assert.match(middleware, /context\.url\.pathname === '\/app\/api\/version\/'\s*\? new Response\(null, \{ status: 204/, 'answered before the handler, no database call');
});

test('the shell compares on responses it already gets, asks once when looked at again, and never polls', () => {
  assert.match(shell, /data-build=\{BUILD\}/, 'the page carries its build');
  assert.match(shell, /window\.fetch = async/, 'responses the page already gets are read');
  assert.match(shell, /noticed\(res\.headers\.get\(BUILD_HEADER\)\)/);
  assert.match(shell, /if \(Date\.now\(\) - lastAsk < 5 \* 60_000\) return;/, 'at most one ask in five minutes');
  assert.match(shell, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) \{ ask\(\);/, 'when the tab is looked at again');
  /* The one timer that can ask is fifteen minutes apart and asks only
     when the page has heard nothing in that time: silence, not polling. */
  assert.match(shell, /window\.setInterval\(\(\) => \{ if \(!document\.hidden && Date\.now\(\) - lastHeard > 15 \* 60_000\) ask\(\); \}, 15 \* 60_000\);/);
  assert.match(shell, /\[BUILD_HEADER\]: BUILD \}/, 'the request says which build it comes from');
});

test('a reload waits for a quiet moment and never over an unsent form', () => {
  assert.match(shell, /const quiet = \(\) => Date\.now\(\) - lastKey > 30_000 && !unsaved\(\);/, 'nothing typed for half a minute, nothing unsaved');
  assert.match(shell, /if \(document\.querySelector\('\.fstate\.saving'\)\) return true;/, 'a box mid-save counts');
  assert.match(shell, /if \(el\.closest\('\.field\[data-field\]'\)\) continue;/, 'a box that saves as it goes does not block once saved');
  assert.match(shell, /el\.value !== el\.defaultValue && el\.value\.trim\(\) !== ''/, 'a form holding something unsent does');
  assert.match(shell, /if \(quiet\(\) && !document\.hidden\) \{ location\.reload\(\); return; \}/);
  assert.match(shell, /what is typed and not yet sent would be lost/, 'and the strip says what refreshing now would cost');
  assert.match(shell, /document\.addEventListener\('submit', \(\) => \{ if \(newer\) window\.setTimeout\(reloadWhenQuiet, 800\); \}\);/, 'a form sent is the moment');
});

test('built scripts and styles are immutable at the edge; pages are not', () => {
  const headers = fs.readFileSync('public/_headers', 'utf8');
  assert.match(headers, /^\/_astro\/\*\n  Cache-Control: public, max-age=31536000, immutable/m);
  assert.doesNotMatch(headers, /^\/\*\n/m, 'no blanket rule over pages');
});

console.log(`${passed} build-id assertions passed.`);
