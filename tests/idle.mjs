/**
 * AN HOUR AWAY, INDENTATION, AND THE PASSWORD ON THE PROFILE (dev-151).
 *
 * Asserted: the idle stamp is set on a person's request and not on the
 * page's own polling, is re-stamped no more than once a minute, and
 * reads `expired` past the hour and never before; the middleware signs
 * out on `expired` and the sign-in page says why; the page's own clock
 * is the same hour. The Markdown rule for indented paragraphs renders
 * one level per four spaces and leaves fenced code alone. The profile
 * page's password form posts to the one handler, which takes the address
 * from the session and answers where it was asked.
 *
 * Run: npm run test:idle
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { judgeIdle, IDLE_COOKIE, IDLE_SECONDS, isAutomatic } from '../src/lib/idle.ts';
import { renderMarkdown } from '../src/lib/notes.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}
async function atest(name, fn) {
  try { await fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

/* A cookie jar the shape the middleware hands in. */
function jar() {
  const store = new Map();
  return {
    store,
    get: (name) => (store.has(name) ? { value: store.get(name) } : undefined),
    has: (name) => store.has(name),
    set: (name, value) => store.set(name, value),
    delete: (name) => store.delete(name),
  };
}

const SECRET = 'a-secret-long-enough-for-hmac';
const ME = 'e8ed334d-a325-4888-9012-6b9dd648c761';
const T0 = Date.parse('2026-09-11T16:00:00Z');
const min = (n) => n * 60 * 1000;

await atest('the first request stamps the cookie and is fresh; a request within the hour is seen', async () => {
  const c = jar();
  assert.equal(await judgeIdle(SECRET, ME, c, '/app/', true, T0), 'fresh');
  assert.ok(c.has(IDLE_COOKIE));
  assert.equal(await judgeIdle(SECRET, ME, c, '/app/project/x/', true, T0 + min(30)), 'seen');
});

await atest('the stamp moves with the person, no more than once a minute', async () => {
  const c = jar();
  await judgeIdle(SECRET, ME, c, '/app/', true, T0);
  const first = c.store.get(IDLE_COOKIE);
  await judgeIdle(SECRET, ME, c, '/app/', true, T0 + 20_000);
  assert.equal(c.store.get(IDLE_COOKIE), first, 'restamped inside a minute');
  await judgeIdle(SECRET, ME, c, '/app/', true, T0 + min(2));
  assert.notEqual(c.store.get(IDLE_COOKIE), first, 'not restamped after a minute');
});

await atest('the pulse and the version check do not count as presence; a person is signed out an hour after their last request', async () => {
  const c = jar();
  await judgeIdle(SECRET, ME, c, '/app/', true, T0);
  for (let i = 1; i <= 11; i += 1) assert.equal(await judgeIdle(SECRET, ME, c, '/app/api/pulse/', true, T0 + min(5 * i)), 'seen');
  assert.equal(await judgeIdle(SECRET, ME, c, '/app/api/version/', true, T0 + min(59)), 'seen');
  assert.equal(await judgeIdle(SECRET, ME, c, '/app/', true, T0 + min(61)), 'expired');
  assert.ok(isAutomatic('/app/api/pulse/') && !isAutomatic('/app/api/field/'));
});

await atest('an autosave is presence: typing every ten minutes for three hours never expires', async () => {
  const c = jar();
  await judgeIdle(SECRET, ME, c, '/app/', true, T0);
  for (let i = 1; i <= 18; i += 1) assert.equal(await judgeIdle(SECRET, ME, c, '/app/api/field/', true, T0 + min(10 * i)), 'seen');
});

await atest("another person's stamp, or a forged one, is no stamp", async () => {
  const c = jar();
  await judgeIdle(SECRET, 'somebody-else', c, '/app/', true, T0);
  assert.equal(await judgeIdle(SECRET, ME, c, '/app/', true, T0 + min(90)), 'fresh');
  c.store.set(IDLE_COOKIE, `${ME}.9999999999.eyJhdCI6MH0.forged`);
  assert.equal(await judgeIdle(SECRET, ME, c, '/app/', true, T0), 'fresh');
});

test('the hour is one hour, on the server and on the device', () => {
  assert.equal(IDLE_SECONDS, 3600);
  const shell = fs.readFileSync('src/components/AppShell.astro', 'utf8');
  assert.match(shell, /const IDLE_MS = 60 \* 60 \* 1000;/);
  assert.match(shell, /\/auth\/signout\/\?idle=1/);
  const mw = fs.readFileSync('src/middleware.ts', 'utf8');
  assert.match(mw, /judgeIdle\(/);
  assert.match(mw, /idle === 'expired'/);
  assert.match(mw, /signin=idle/);
  assert.match(fs.readFileSync('src/pages/app/index.astro', 'utf8'), /signin === 'idle'/);
  assert.match(fs.readFileSync('src/pages/auth/signout.ts', 'utf8'), /clearIdle\(cookies\)/);
});

/* ── Indentation ──────────────────────────────────────────────────────── */

test('four spaces per level is an indented paragraph, not code; fenced code is still code', () => {
  const html = renderMarkdown('Top\n\n    In one\n    still one\n\n        In two\n\n```\n    kept\n```');
  assert.match(html, /<p class="ind" data-ind="1">In one<br>still one<\/p>/);
  assert.match(html, /<p class="ind" data-ind="2">In two<\/p>/);
  assert.match(html, /<pre><code>    kept\n<\/code><\/pre>/);
  assert.doesNotMatch(html, /<code>In one/);
});

test('deeper than four levels is four; one to three leading spaces are an ordinary paragraph', () => {
  assert.match(renderMarkdown('                        Deep'), /data-ind="4"/);
  assert.match(renderMarkdown('   Shallow'), /^<p>\s*Shallow<\/p>/);
});

test('the editor writes the indent, the rule reads it, and the bar and keys offer it', () => {
  const ed = fs.readFileSync('src/components/MarkdownEditor.astro', 'utf8');
  assert.match(ed, /el\.dataset\.ind/);
  assert.match(ed, /ev\.key === 'Tab'/);
  assert.match(ed, /case 'indent': shift\(1\)/);
  const tools = fs.readFileSync('src/lib/markdown-tools.ts', 'utf8');
  assert.match(tools, /cmd: 'indent'/);
  assert.match(tools, /cmd: 'outdent'/);
  assert.match(fs.readFileSync('src/styles/ui.css', 'utf8'), /p\.ind\[data-ind="4"\]/);
});

test('the references field hangs, on the surface and on the page', () => {
  const shape = fs.readFileSync('src/config/shapes/literature-review.yaml', 'utf8');
  assert.match(shape, /id: references\n\s+kind: long\n(?:\s+#.*\n)*\s+style: hanging/);
  assert.match(fs.readFileSync('src/pages/app/project/[id]/doc/[deliverable].astro', 'utf8'), /hang=\{f\.style === 'hanging'\}/);
  assert.match(fs.readFileSync('src/components/DocumentPaper.astro', 'utf8'), /f\.style === 'hanging' && 'hang'/);
});

/* ── The password, from the profile ──────────────────────────────────── */

test('the profile posts to the change handler with the answer sent back; the handler takes the address from the session', () => {
  const profile = fs.readFileSync('src/pages/app/profile.astro', 'utf8');
  assert.match(profile, /action="\/auth\/change\/"/);
  assert.match(profile, /name="back" value="\/app\/profile\/"/);
  assert.doesNotMatch(profile, /name="email"/);
  const change = fs.readFileSync('src/pages/auth/change.astro', 'utf8');
  assert.match(change, /session\?\.email \?\? String\(form\.get\('email'\)/);
  assert.match(change, /BACK = new Set\(\['\/app\/profile\/'\]\)/);
});

console.log(`  ${passed} passed`);
