/**
 * A path has to work with or without its trailing slash.
 *
 * `trailingSlash: 'ignore'` accepts both forms, so both arrive. The
 * middleware's test for a non-tenant tree compared a `/tree/` prefix, which
 * meant /projects/ was recognized and /projects was not: the second was
 * rewritten to /{org}/projects, matched nothing, and failed with a stack
 * trace. That is the bare address of every one of these trees — the one
 * somebody types and the one an external link uses.
 *
 * Run: npm run test:paths
 */

import assert from 'node:assert/strict';
import { NON_TENANT_TREES, ROOT_FILES, isNonTenantPath } from '../src/config/routes.ts';

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

test('every tree is recognized with and without a trailing slash', () => {
  for (const tree of NON_TENANT_TREES) {
    assert.equal(isNonTenantPath(`/${tree}`), true, `/${tree}`);
    assert.equal(isNonTenantPath(`/${tree}/`), true, `/${tree}/`);
  }
});

test('and at any depth beneath it', () => {
  for (const tree of NON_TENANT_TREES) {
    assert.equal(isNonTenantPath(`/${tree}/2027/a-slug/`), true, tree);
    assert.equal(isNonTenantPath(`/${tree}/2027/a-slug`), true, tree);
  }
});

test('a tenant page is not mistaken for one', () => {
  for (const path of ['/guides/', '/guides', '/about/', '/deadlines/', '/mistakes']) {
    assert.equal(isNonTenantPath(path), false, path);
  }
});

test('a longer name that merely starts the same is not one', () => {
  /* /apple is not /app. Comparing a prefix without the separator would have
     said otherwise. */
  for (const path of ['/apple/', '/application', '/trackers/', '/records-archive']) {
    assert.equal(isNonTenantPath(path), false, path);
  }
});

test('the root is never a tree', () => {
  assert.equal(isNonTenantPath('/'), false);
  assert.equal(isNonTenantPath(''), false);
});

test('the root files are named without a path', () => {
  /* They sit at src/pages/, so the middleware and the route test both need
     them as filenames rather than as trees. */
  for (const file of ROOT_FILES) {
    assert.match(file, /\.astro$/, file);
  }
});

/* ── The canonical form ──────────────────────────────────────────────────── */

import fs from 'node:fs';
const middleware = fs.readFileSync('src/middleware.ts', 'utf8');

test('a page without its trailing slash redirects rather than rendering twice', () => {
  assert.match(middleware, /Response\.redirect/, 'nothing redirects to the canonical form');
  assert.match(middleware, /308/, 'the redirect should be permanent');
});

test('a file keeps its shape', () => {
  /* /records-index/pagefind.js must not become /records-index/pagefind.js/,
     which is the whole reason trailingSlash is 'ignore'. */
  assert.match(middleware, /last\.includes\('\.'\)/, 'files are not excluded from the redirect');
});

test('only GET and HEAD are redirected', () => {
  /* A 308 resends the body, so a form posting to a path without its slash
     would submit twice. */
  assert.match(middleware, /request\.method === 'GET'/, 'the redirect is not limited to safe methods');
});

console.log(`${passed} path assertions passed.`);
