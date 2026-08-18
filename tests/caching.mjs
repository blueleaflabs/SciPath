/**
 * A page with a masthead on it is not publicly cacheable.
 *
 * Twelve pages set `Cache-Control: public, max-age=120`, which was right for
 * their content and wrong for the page: every one renders the masthead, and
 * the masthead shows your name. The browser stored the signed-out copy, and
 * signing in and clicking home showed a Sign in button again.
 *
 * It looked exactly like a session bug, and I went looking there three times
 * before reading the response headers.
 *
 * Run: npm run test:caching
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(astro|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const pages = walk('src/pages');
const helper = fs.readFileSync('src/lib/caching.ts', 'utf8');

test('no page sets Cache-Control by hand', () => {
  /* One place decides, because the decision depends on whether somebody is
     signed in and every copy of it would have to remember that. */
  const offenders = pages
    .filter((f) => f.endsWith('.astro'))
    .filter((f) => /headers\.set\(\s*'Cache-Control'/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => f);

  assert.deepEqual(offenders, [], 'use cachePublicPage(Astro) instead');
});

test('the helper never stores a signed-in response', () => {
  assert.match(helper, /locals\.session/, 'it has to look at the session');
  assert.match(helper, /private, no-store/, 'a page with a name on it is not stored');
});

test('and it varies on cookie either way', () => {
  /* Without this, a shared cache that did store a signed-in copy would hand
     it to the next reader. The consequence of getting this wrong is somebody
     else's name on your screen, not a stale button. */
  const varyLine = helper.slice(helper.indexOf("headers.set('Vary'"));
  assert.match(varyLine.slice(0, 120), /Cookie/);

  const beforeSessionCheck = helper.slice(0, helper.indexOf('if (locals.session)'));
  assert.match(
    beforeSessionCheck,
    /headers\.set\('Vary'/,
    'Vary must be set before the branch, so both paths carry it'
  );
});

test('every page that renders a masthead uses the helper', () => {
  /* The masthead is in Base, so any page using Base varies by session. */
  const problems = [];

  for (const file of pages.filter((f) => f.endsWith('.astro'))) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/from '.*layouts\/Base.astro'/.test(text)) continue;
    if (!/export const prerender = false/.test(text)) continue;

    /* An on-demand page that says nothing about caching is fine: the default
       is not to cache. Only a page that opts in has to opt in correctly. */
    if (/cachePublicPage|Cache-Control/.test(text) && !/cachePublicPage/.test(text)) {
      problems.push(file);
    }
  }

  assert.deepEqual(problems, []);
});

test('nothing under the working surface is publicly cached', () => {
  /* /app/ is somebody's own work. `no-store` there is correct and expected;
     what must never appear is `public`. */
  const offenders = pages
    .filter((f) => f.startsWith('src/pages/app/'))
    .filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return /cachePublicPage/.test(text) || /Cache-Control['"]?\s*:?\s*,?\s*['"]public/.test(text);
    });

  assert.deepEqual(offenders, [], 'the working surface is not a public page');
});

console.log(`${passed} caching assertions passed. ${pages.length} routes read.`);
