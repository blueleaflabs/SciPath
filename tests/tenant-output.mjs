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
import yaml from 'js-yaml';

const DIST = 'dist';

if (!fs.existsSync(DIST)) {
  console.error('No dist/. Run npm run build first.');
  process.exit(1);
}

/* Slug to name, read from the org config, so this test carries no literals
   of its own and cannot go stale when a tenant is added.

   **Read from `src/config/orgs/*.yaml`, which is where a school has been
   described since 1.65.** This parsed `orgs.ts` for the literal object the
   file used to hold, and after the move that pattern matched nothing: the
   list of names went to zero and every assertion below became vacuously
   true. Silent, and the exact 1.12 fault this file exists to catch — a test
   passing because it compared nothing. Hence the floor: it fails if it reads
   no tenants rather than reporting a pass over an empty list (19.9). */
const dir = 'src/config/orgs';
const nameBySlug = {};

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
  const doc = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
  /* The platform record's name appears in every tenant's footer by design
     ("on SciPath"), so it is not a tenant name and cannot be compared. */
  if (doc?.name && !doc.is_platform) nameBySlug[doc.slug] = doc.name;
}

const names = Object.values(nameBySlug);

if (names.length === 0) {
  console.error(`No tenant names read from ${dir}/. This test would compare nothing.`);
  process.exit(1);
}

const tenants = fs
  .readdirSync(DIST, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
  .filter((d) => !['pagefind', 'pdf'].includes(d.name))
  .map((d) => d.name);

if (tenants.length === 0) {
  console.error(`No tenant directories in ${DIST}/. Run npm run build first.`);
  process.exit(1);
}

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

  /**
   * Without this, a build where every page rendered the same fallback would
   * pass: no tenant names another when no tenant names anyone. 1.12 added it
   * after exactly that.
   *
   * **Anchored on `about/index.html`, not `index.html`.** The home page moved
   * outside the tenant tree and became on demand at 1.39, so `{tenant}/
   * index.html` has not existed since — and this reported its absence as
   * *does not name Monta Vista High School*, which reads as a leak and is
   * not one. Open decision 64. The about page is prerendered per tenant and
   * carries the lockup, which is the property this assertion actually needs.
   *
   * If it ever stops being prerendered, this must be re-anchored again
   * rather than dropped, so the file is named rather than globbed: a missing
   * anchor has to be loud.
   */
  const anchor = path.join(dir, 'about', 'index.html');

  if (!fs.existsSync(anchor)) {
    problems.push(
      `${tenant}/about/index.html is not in the build, so nothing anchors this tenant. ` +
        `Re-anchor onto a page that is still prerendered per tenant.`
    );
    continue;
  }

  if (!fileMentions(anchor, own)) {
    problems.push(`${tenant}/about/index.html does not name ${own}`);
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
