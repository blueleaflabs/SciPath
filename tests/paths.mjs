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

/* ── Every on-demand page loads a session ────────────────────────────────── */

test('the home page loads a session', () => {
  /* It renders on demand and shows the masthead, so without a session
     somebody who is signed in is offered a Sign in button they have already
     used. This has now happened twice: once to the tracker, once here. */
  assert.match(
    middleware,
    /const isHome = url\.pathname === '\/'/,
    'the home page must be in the session-loading set'
  );
  assert.match(
    middleware,
    /needsSession = isHome \|\| isNonTenantPath/,
    'and it must reach needsSession rather than returning before it'
  );
});

test('nothing returns before the session is decided', () => {
  /* A `return next()` above `needsSession` skips session loading for that
     path, which is the shape of the bug both times. The redirect above it is
     the one legitimate early exit, because it renders nothing. */
  const beforeSession = middleware.slice(0, middleware.indexOf('const needsSession'));
  const exits = [...beforeSession.matchAll(/return (next\(\)|new Response)/g)];
  assert.deepEqual(
    exits.map((m) => m[0]),
    [],
    'an early return here renders a page with no session'
  );
});

/* ── A rewritten route cannot rely on props alone ────────────────────────── */

test('a parameterised page can render from its URL, not only from props', () => {
  /* `getStaticPaths` supplies props, and the middleware rewrite that puts a
     tenant slug on the front does not always carry them. The guides route
     took `Astro.props.guide` and nothing else, and rendered undefined —
     which reaches a reader as a framework error page.
   
     The parameters are in the URL either way, so a page with parameters
     should be able to find its own content from them. */
  const problems = [];

  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.astro')) out.push(full);
    }
    return out;
  };

  for (const file of walk('src/pages')) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/getStaticPaths/.test(text)) continue;
    if (!/Astro\.props/.test(text)) continue;

    /* A fallback reads the parameters, or guards the missing case. */
    const recovers = /Astro\.params/.test(text) || /\?\?\s*\(await/.test(text);
    const guards = /status: 404/.test(text);

    if (!recovers || !guards) {
      problems.push(`${file}${recovers ? '' : ' (no fallback)'}${guards ? '' : ' (no 404)'}`);
    }
  }

  assert.deepEqual(problems, [], 'fall back to the params, and 404 when there is nothing');
});

console.log(`${passed} path assertions passed.`);
