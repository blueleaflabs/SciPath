/**
 * Every public route is prerendered once per tenant.
 *
 * Two failures this catches, both of which build cleanly and look fine on
 * one hostname:
 *
 *   1. A public page left outside src/pages/[org]/. It renders for whichever
 *      organization PUBLIC_ORG named at build time and shows that school's
 *      name to every other school.
 *   2. A tenant missing pages the others have, which means a route's
 *      getStaticPaths was not crossed with the tenant list.
 *
 * Run: npm run test:routes
 */

import fs from 'node:fs';
import path from 'node:path';

const PAGES = 'src/pages';
const TENANTED = path.join(PAGES, '[org]');

/* On demand, hostname aware at request time. Plus the one file Astro
   requires at the root. */
const EXEMPT = new Set(['app', 'auth', '404.astro']);

const problems = [];

for (const entry of fs.readdirSync(PAGES)) {
  if (entry === '[org]' || EXEMPT.has(entry)) continue;
  problems.push(`src/pages/${entry} is public but not under [org]/`);
}

/* Every tenant should receive the same set of pages. */
const DIST = 'dist';
if (fs.existsSync(DIST)) {
  const orgs = Object.keys(
    JSON.parse(fs.readFileSync('package.json', 'utf8')) && {}
  );
  const dirs = fs
    .readdirSync(DIST, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') &&
                   !['pagefind', 'pdf'].includes(d.name))
    .map((d) => d.name);

  const counts = dirs.map((d) => [d, countHtml(path.join(DIST, d))]);
  const values = new Set(counts.map(([, n]) => n));

  if (values.size > 1) {
    problems.push(
      'Tenants have different page counts: ' +
        counts.map(([d, n]) => `${d}=${n}`).join(', ')
    );
  }
}

function countHtml(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countHtml(path.join(dir, e.name));
    else if (e.name.endsWith('.html')) n += 1;
  }
  return n;
}

console.log('Public routes checked for tenant scoping.');

if (problems.length > 0) {
  console.error('\nTenant routing:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nEvery public route belongs under src/pages/[org]/ with getStaticPaths\n' +
      'crossed against the tenant list. See src/lib/tenant-paths.ts.'
  );
  process.exit(1);
}

console.log('Every public route is tenant scoped.');
