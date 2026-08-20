/**
 * THE EDGE RULES AND THE MIDDLEWARE MUST EXEMPT THE SAME THINGS.
 *
 * Two mechanisms put a tenant slug on a path: the middleware, which does it
 * in the worker, and a Cloudflare Transform Rule, which does it at the edge
 * for the paths the worker never sees. Each has to skip the same trees — the
 * non-tenant ones render on demand and resolve their organization from the
 * hostname, so prefixing one breaks it.
 *
 * `src/config/routes.ts` exists because that list was once in two places and
 * the tracker was added to one of them. This is the third place it could
 * live, and `scripts/edge-rules.mjs` reads the same file rather than
 * restating it — which is what this asserts, because a generator that quietly
 * stopped reading the shared list would keep producing rules that looked
 * right.
 *
 * **What this cannot check is the rule in Cloudflare.** It lives in a
 * dashboard, and nothing here can see it. The generator prints; a person
 * pastes. That gap is the argument for running `npm run edge-rules` after any
 * change to routes or organizations and replacing the rules wholesale rather
 * than editing them.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

import { NON_TENANT_TREES } from '../src/config/routes.ts';

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

const generator = fs.readFileSync('scripts/edge-rules.mjs', 'utf8');

test('the generator reads the shared list rather than restating it', () => {
  /* Matched by substring rather than by a regex describing an import
     statement. `tests/dependencies.mjs` scans every file for that shape to
     find imported packages, and a pattern spelling one out reads to it as an
     import of whatever the pattern contains — which it then cannot find in
     `package.json`. A test that trips another test is a poor way to make a
     point, and it took two attempts here to stop doing it. */
  assert.ok(
    generator.includes('NON_TENANT_TREES') && generator.includes('config/routes.ts'),
    'it must read src/config/routes.ts, which is where this list lives'
  );

  assert.match(
    generator,
    /\.\.\.NON_TENANT_TREES/,
    'the shared list must be spread into the exemptions, not referenced and ignored'
  );
});

test('every non-tenant tree reaches the generated exemptions', () => {
  /* Names written into the generator on top of the shared list. A tree that
     appears here *and* in the shared list would be the beginning of a second
     copy. */
  const literals = [
    ...generator
      .slice(generator.indexOf('const EXEMPT = ['), generator.indexOf('];', generator.indexOf('const EXEMPT = [')))
      .matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);

  const duplicated = literals.filter((name) => NON_TENANT_TREES.includes(name));

  assert.deepEqual(
    duplicated,
    [],
    'these are already in NON_TENANT_TREES and are being listed twice'
  );

  /* And the extras are what they should be: build output and the home page,
     which have no tenant copy to rewrite to. */
  assert.deepEqual(
    literals.sort(),
    ['404', '_astro', 'pdf', 'sitemap'],
    'the generator now exempts something else — is it a tree, and should it be in routes.ts?'
  );
});

test('the middleware exempts what the rules exempt', () => {
  const middleware = fs.readFileSync('src/middleware.ts', 'utf8');

  /* The middleware skips these by prefix rather than by the shared list,
     because it also has to skip things a URL rewrite never sees. What matters
     is that nothing the rules let through is rewritten twice. */
  for (const tree of ['_astro', 'pdf', 'sitemap']) {
    assert.match(
      middleware,
      new RegExp(`startsWith\\('/${tree}`),
      `the middleware does not skip /${tree}, which the edge rules exempt`
    );
  }

  assert.match(
    middleware,
    /isNonTenantPath\(url\.pathname\)/,
    'the middleware must consult the shared list, not its own copy'
  );
});

console.log(
  `\n${passed} edge rule assertions passed. ` +
    `${NON_TENANT_TREES.length} shared trees, 4 build paths.\n`
);
