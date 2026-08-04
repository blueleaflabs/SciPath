/**
 * No tenant's built pages may contain another tenant's name.
 *
 * This is the test that would have caught two separate bugs in a row, both
 * of which built cleanly and looked correct on one hostname. It reads the
 * output rather than the source, so it does not care how the mistake was
 * made: a stale function signature, a module-level import, a hardcoded
 * string. If one school's name appears in another school's HTML, it fails.
 *
 * Run after a build: npm run test:output
 */

import fs from 'node:fs';
import path from 'node:path';

const DIST = 'dist';

if (!fs.existsSync(DIST)) {
  console.error('No dist/. Run npm run build first.');
  process.exit(1);
}

/* Slug to name, read from the org config, so this test carries no literals
   of its own and cannot go stale when a tenant is added. */
const source = fs.readFileSync('src/config/orgs.ts', 'utf8');
const nameBySlug = {};
for (const m of source.matchAll(/^\s{2}(\w+):\s*\{([\s\S]*?)^\s{2}\},/gm)) {
  const body = m[2];
  /* ^\s+name: so hostname: does not match. */
  const name = body.match(/^\s+name:\s*'([^']+)'/m);
  /* The platform record's name appears in every tenant's footer by design
     ("on SciPath"), so it is not a tenant name and cannot be compared. */
  if (name && !/isPlatform:\s*true/.test(body)) nameBySlug[m[1]] = name[1];
}
const names = Object.values(nameBySlug);

const tenants = fs
  .readdirSync(DIST, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .filter((d) => !['pagefind', 'pdf'].includes(d.name))
  .map((d) => d.name);

function htmlFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(full));
    else if (e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const problems = [];

for (const tenant of tenants) {
  const dir = path.join(DIST, tenant);
  const own = nameBySlug[tenant];
  if (!own) continue;

  /* Without this, a build where every page rendered the same fallback would
     pass: no tenant names another when no tenant names anyone. */
  if (!fileMentions(path.join(dir, 'index.html'), own)) {
    problems.push(`${tenant}/index.html does not name ${own}`);
    continue;
  }

  for (const file of htmlFiles(dir)) {
    const html = fs.readFileSync(file, 'utf8');
    for (const name of names) {
      if (name === own) continue;
      if (html.includes(name)) {
        problems.push(`${file} contains "${name}" but belongs to ${tenant}`);
        break;
      }
    }
  }
}

function fileMentions(file, needle) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').includes(needle);
}

console.log(`${tenants.length} tenants checked for cross contamination.`);

if (problems.length > 0) {
  console.error('\nOne tenant\'s pages name another tenant:');
  for (const p of problems.slice(0, 12)) console.error(`  ${p}`);
  if (problems.length > 12) console.error(`  ...and ${problems.length - 12} more`);
  console.error(
    '\nEvery page takes its organization from activeOrg(Astro), which reads\n' +
      'the [org] route parameter when prerendered and the hostname the\n' +
      'middleware resolved when served on demand.'
  );
  process.exit(1);
}

console.log('No tenant names another tenant.');
