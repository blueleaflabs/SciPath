/**
 * Search must not cross tenants.
 *
 * Every other surface here is scoped by organization. Search was not: one
 * index was built over the whole of dist/, and `/pagefind/` was exempt from
 * the tenant rewrite, so all three schools loaded the same file and Monta
 * Vista's search box returned Lynbrook's articles. Search is the one place a
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


/* ── The 404 must stay prerendered ───────────────────────────────────────── */

test('the not-found page is not on demand', () => {
  /* An unmatched path falls back to this route, so making it on demand makes
     every unmatched path an on-demand route. The middleware then rewrites
     /guides/ onto the prerendered /montavista/guides/, and Astro refuses:
     rewriting from on demand to prerendered is forbidden. It takes out every
     public page at once, and the symptom names the page you asked for rather
     than the 404, which is why it is worth a test rather than a comment. */
  const page = fs.readFileSync('src/pages/404.astro', 'utf8');
  assert.doesNotMatch(
    page,
    /export const prerender\s*=\s*false/,
    'an on-demand 404 breaks the tenant rewrite for every public page'
  );
});

if (fs.existsSync('dist')) {
  test('the build emits a static 404', () => {
    assert.ok(fs.existsSync('dist/404.html'), 'no prerendered 404 in the build');
  });
}

console.log('404 rendering checked.');

console.log(`${passed} search scoping assertions passed.`);
