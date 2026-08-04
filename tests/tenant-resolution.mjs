/**
 * A layout that reads the organization from a module-level import renders the
 * same school at every hostname. It builds, it passes every other test, and
 * it is invisible until two tenants exist.
 *
 * Rule: no shared component, no layout, and no ON-DEMAND route imports the
 * resolved `org` singleton. They take it as a prop, or call
 * activeOrg(Astro.locals), which prefers the hostname the middleware
 * resolved.
 *
 * Nothing is exempt any more. Public routes used to be single tenant per
 * build, which made a module-level import defensible there. They are now
 * prerendered once per tenant under [org]/, so a page reading the singleton
 * would render one school's name into every school's files.
 *
 * Run: npm run test:tenant
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src/components', 'src/layouts', 'src/pages'];
const ALLOW = ['src/lib/tenant.ts'];

/* `import { org }` or `import { org, ... }` from the config module. */
const SINGLETON = /import\s*\{[^}]*\borg\b[^}]*\}\s*from\s*['"][^'"]*config\/orgs['"]/;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.(astro|ts|tsx|js|mjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const offenders = [];

for (const file of ROOTS.flatMap(walk)) {
  const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
  if (ALLOW.includes(rel)) continue;

  const source = fs.readFileSync(file, 'utf8');

  /* A type-only import of Org is fine; the value singleton is not. */
  const stripped = source.replace(/import\s+type\s*\{[^}]*\}\s*from\s*['"][^'"]*['"]/g, '');
  if (SINGLETON.test(stripped)) offenders.push(rel);
}

console.log('Shared components, layouts, and on-demand routes scanned.');

if (offenders.length > 0) {
  console.error('\nImporting the resolved org singleton:');
  for (const file of offenders) console.error(`  ${file}`);
  console.error(
    '\nTenancy is resolved per request from the hostname. Take the org as a\n' +
      'prop from the layout, or call activeOrg(Astro.locals). A module-level\n' +
      'import renders one school at every hostname and nothing catches it\n' +
      'until a second tenant exists.'
  );
  process.exit(1);
}

console.log('No component reads the org singleton directly.');
