/**
 * BACK TO WHERE THEY CAME FROM (2.8).
 *
 * An export's one link returns to the page it was opened from when the
 * browser says so and that page is ours; otherwise to the page's own
 * fallback. Run: npm run test:back
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { backFrom } from '../src/lib/back.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const here = 'https://montavista.scipath.org/app/project/p1/notebook/';
const fallback = { href: '/app/project/p1/', label: 'Back to the project' };
const req = (referer) => new Request(here, { headers: referer ? { Referer: referer } : {} });

test('the Workbench, the class and the project are named', () => {
  assert.deepEqual(backFrom(req('https://montavista.scipath.org/app/'), fallback), { href: '/app/', label: 'Back to the Workbench' });
  assert.deepEqual(backFrom(req('https://montavista.scipath.org/app/program/x/class/'), fallback), { href: '/app/program/x/class/', label: 'Back to the class' });
  assert.deepEqual(backFrom(req('https://montavista.scipath.org/app/project/p1/in/x/'), fallback), { href: '/app/project/p1/in/x/', label: 'Back to the project' });
});

test('the query survives, so a filtered list comes back filtered', () => {
  assert.equal(backFrom(req('https://montavista.scipath.org/app/?care=grid'), fallback).href, '/app/?care=grid');
});

test('another host, a public page, no referer, or this page itself fall back', () => {
  assert.deepEqual(backFrom(req('https://evil.example/app/'), fallback), fallback);
  assert.deepEqual(backFrom(req('https://montavista.scipath.org/showcase/'), fallback), fallback);
  assert.deepEqual(backFrom(req(null), fallback), fallback);
  assert.deepEqual(backFrom(req(here), fallback), fallback);
});

test('every export page uses it', () => {
  for (const f of ['src/pages/app/project/[id]/notebook.astro', 'src/pages/app/project/[id]/documents/print.astro', 'src/pages/app/project/[id]/doc/[deliverable]/print.astro']) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /backFrom\(Astro\.request/, `${f} does not use backFrom`);
    assert.match(src, /<a href=\{back\.href\}>\{back\.label\}<\/a>/, `${f} does not render the back link from it`);
  }
});

console.log(`${passed} back-link assertions passed.`);
