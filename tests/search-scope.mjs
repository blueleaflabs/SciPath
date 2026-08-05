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
    const tenants = fs
      .readdirSync('dist', { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(`dist/${e.name}/index.html`))
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

console.log(`${passed} search scoping assertions passed.`);
