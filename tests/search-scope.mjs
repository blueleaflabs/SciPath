/**
 * Search must not cross tenants.
 *
 * Every other surface here is scoped by organization. Search was not: one
 * index was built over the whole of dist/, and `/pagefind/` was exempt from
 * the tenant rewrite, so all three schools loaded the same file and Monta
 * Vista's search box returned another school's articles. Search is the one place a
 * visitor can enumerate an archive, which makes it the worst place to leak.
 *
 * This checks the two halves that have to stay true: the path is rewritten
 * like any other, and the build writes one index per tenant rather than one
 * for all of them.
 *
 * Run: npm run test:search
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

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

const middleware = fs.readFileSync('src/middleware.ts', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('the index path is not exempt from the tenant rewrite', () => {
  const skipList = middleware.slice(
    middleware.indexOf('const first = url.pathname.split'),
    middleware.indexOf('return next(`/${slug}')
  );
  assert.doesNotMatch(
    skipList,
    /'\/pagefind\//,
    'pagefind is in the rewrite skip list, so every tenant loads the same index'
  );
});

test('the build indexes per tenant rather than the whole of dist', () => {
  const build = pkg.scripts.build;
  assert.doesNotMatch(
    build,
    /pagefind\s+--site\s+dist(\s|$)/,
    'the build indexes all of dist at once, which mixes every tenant together'
  );
  assert.match(build, /index-search/, 'the per-tenant indexer is not in the build');
});

test('the indexer refuses to leave a shared index behind', () => {
  const script = fs.readFileSync('scripts/index-search.mjs', 'utf8');
  assert.match(script, /rmSync/, 'nothing removes a stale dist/pagefind');
});

test('the search page loads its index by a relative path', () => {
  const page = fs.readFileSync('src/pages/[org]/search.astro', 'utf8');
  /* A leading slash is what makes the rewrite apply. An absolute origin, or a
     hard coded tenant, would sidestep it. */
  assert.match(page, /'pagefind'/);
  assert.doesNotMatch(page, /https?:\/\/[^']*pagefind/);
});

/* If a build is present, check what it actually produced. */
if (fs.existsSync('dist')) {
  test('a completed build has one index per tenant and none shared', () => {
    /* A tenant is a directory holding prerendered pages. Its home page is no
       longer one of them: the archive moved to the record store, so the home
       page renders on demand. */
    const tenants = fs
      .readdirSync('dist', { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          !['_astro', 'pagefind', 'pdf', 'records'].includes(e.name) &&
          fs.existsSync(`dist/${e.name}/about/index.html`)
      )
      .map((e) => e.name);

    assert.ok(tenants.length > 1, 'expected several tenants in dist');

    for (const tenant of tenants) {
      assert.ok(
        fs.existsSync(`dist/${tenant}/pagefind`),
        `${tenant} has no search index of its own`
      );
    }

    assert.equal(fs.existsSync('dist/pagefind'), false, 'a shared index is still there');
  });
}

test('routes that serve files do not require a trailing slash', () => {
  /* `trailingSlash: 'always'` compiles every route to a pattern ending in a
     slash, which is right for a page and wrong for anything serving a file.
     /records-index/pagefind.js matched no route at all and fell through to
     the 404 page, so search could never load its index and published PDFs
     would have failed the same way. */
  const config = fs.readFileSync('astro.config.mjs', 'utf8');
  assert.doesNotMatch(
    config,
    /trailingSlash:\s*'always'/,
    "trailingSlash: 'always' makes every file-serving route unreachable"
  );

  const manifests = fs.existsSync('dist/_worker.js')
    ? fs.readdirSync('dist/_worker.js').filter((f) => f.startsWith('manifest'))
    : [];

  for (const file of manifests) {
    const text = fs.readFileSync(`dist/_worker.js/${file}`, 'utf8');
    for (const tree of ['records', 'records-index']) {
      const pattern = new RegExp(`\\^\\\\\\\\/${tree}\\(\\?:[^"]*?\\\\/(\\??)\\$`);
      const found = text.match(new RegExp(`"\\^\\\\\\\\/${tree}[^"]*"`));
      if (!found) continue;
      assert.match(
        found[0],
        /\\\\\/\?\$/,
        `/${tree}/ requires a trailing slash, so no file under it can be fetched`
      );
    }
  }
});


/* ── The 404 must stay on demand ─────────────────────────────────────────── */

test('the not-found page is on demand', () => {
  /**
   * **A static `404.html` is answered by Cloudflare before the worker runs**,
   * and that is what made every prerendered public page unreachable: a
   * request for `/guides/` matched no asset, Pages served the file, and the
   * middleware that would have rewritten it onto `/montavista/guides/` was
   * never invoked.
   *
   * This test used to assert the opposite, and its reasoning is worth keeping
   * because it was half right: making the 404 on demand once did take out
   * every public page, because the middleware's only mechanism was `next()`,
   * and Astro forbids rewriting from an on-demand route to a prerendered one.
   * The symptom was read as *the 404 must stay prerendered* when it was
   * really *`next()` cannot reach a prerendered page*. A guard written from a
   * symptom outlived the thing it was guarding against.
   *
   * The middleware fetches the file through the assets binding now and
   * returns it directly; `next()` is a wrapped fallback rather than the
   * mechanism. So the 404 can be on demand, and has to be.
   */
  const page = fs.readFileSync('src/pages/404.astro', 'utf8');
  assert.match(
    page,
    /export const prerender\s*=\s*false/,
    'a prerendered 404 is served before the worker and hides every public page'
  );
});

test('the middleware does not depend on next() to reach a prerendered page', () => {
  /* The other half of the same rule. With the 404 on demand, an unmatched
     path reaches the middleware — and if the only thing it does is `next()`
     into a prerendered route, Astro throws and every public page fails at
     once. The assets lookup is what makes the on-demand 404 safe. */
  const middleware = fs.readFileSync('src/middleware.ts', 'utf8');

  assert.match(
    middleware,
    /runtime\?\.env\?\.ASSETS/,
    'the middleware must fetch the file rather than rewriting into it'
  );

  assert.match(
    middleware,
    /catch[\s\S]{0,120}rewritefailed/,
    'a refused rewrite must report itself rather than becoming a blank site'
  );
});

if (fs.existsSync('dist')) {
  test('the build emits no static 404', () => {
    assert.equal(
      fs.existsSync('dist/404.html'),
      false,
      'a static 404 is served before the worker and hides every public page'
    );
  });
}

console.log('404 rendering checked.');

console.log(`${passed} search scoping assertions passed.`);
