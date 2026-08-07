/**
 * ONE SEARCH INDEX PER TENANT.
 *
 * `pagefind --site dist` builds a single index over everything Astro emitted,
 * which is every school's archive in one directory. Monta Vista's search box
 * then returned Lynbrook's articles, and `/pagefind/` was exempt from the
 * tenant rewrite so all three schools loaded the same file. Every other part
 * of this system is scoped by organization; search was not, and search is the
 * one place a visitor can enumerate an archive.
 *
 * So: pagefind runs once per tenant directory, writing an index that only
 * contains that tenant's pages, and the middleware rewrites `/pagefind/` onto
 * the front like everything else.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const DIST = 'dist';

if (!fs.existsSync(DIST)) {
  console.error('No dist/. Run the Astro build first.');
  process.exit(1);
}

/* Read from what was built rather than from the config, so this stays a
   plain script with no TypeScript import chain behind it.

   A tenant is a directory holding prerendered pages. It used to be spotted by
   its own index.html, which stopped working when the archive moved to the
   record store and the home page became on demand. Any page at all is the
   right test: what is being indexed here is the static half of the site. */
const NOT_TENANTS = new Set(['_astro', 'pagefind', 'pdf', 'articles', 'projects', 'records']);

function hasPages(dir, depth = 0) {
  if (depth > 3) return false;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) return true;
    if (entry.isDirectory() && hasPages(path.join(dir, entry.name), depth + 1)) return true;
  }
  return false;
}

const tenants = fs
  .readdirSync(DIST, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !NOT_TENANTS.has(e.name))
  .map((e) => e.name)
  .filter((name) => hasPages(path.join(DIST, name)));

if (tenants.length === 0) {
  console.error('No tenant directories in dist/. Nothing to index.');
  process.exit(1);
}

for (const slug of tenants) {
  execFileSync('npx', ['pagefind', '--site', path.join(DIST, slug)], { stdio: 'inherit' });
}

const indexed = tenants.length;

/* A stray index at the root would be the old shared one, and it would still
   be served to anybody who reached it. */
const shared = path.join(DIST, 'pagefind');
if (fs.existsSync(shared)) {
  fs.rmSync(shared, { recursive: true, force: true });
  console.log('Removed the shared index at dist/pagefind.');
}

console.log(`${indexed} search ${indexed === 1 ? 'index' : 'indexes'}, one per tenant.`);
