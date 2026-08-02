/**
 * Two structural rules, checked rather than remembered.
 *
 * 1. No hex color outside tokens.css. Every value is a semantic token, so
 *    a theme switch is a token block rather than a rewrite.
 * 2. No component names a school, a district, a fair, or the operator.
 *    Those strings come from the organization record or the platform config,
 *    which is what makes running this for a second organization a config edit.
 *
 * Run: npm run test:tokens
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src/components', 'src/layouts', 'src/pages', 'src/styles', 'src/lib'];
const ALLOW_HEX = ['src/styles/tokens.css'];

/**
 * Extend this list when an organization is provisioned. A name appearing in a
 * component is the failure this catches; a name in src/config is expected.
 */
const ORG_STRINGS = ['Monta Vista', 'FUHSD', 'Synopsys', 'Blue Leaf Labs'];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.(astro|css|ts|tsx|js|mjs|md)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const files = ROOTS.flatMap(walk);
const problems = [];

for (const file of files) {
  const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
  const source = fs.readFileSync(file, 'utf8');

  if (!ALLOW_HEX.includes(rel)) {
    /* Ignore fragment identifiers in href and id attributes. */
    const stripped = source
      .replace(/href=(['"`])#[^'"`]*\1/g, '')
      .replace(/content:\s*'\\[0-9a-fA-F]+'/g, '');
    const hits = stripped.match(HEX);
    if (hits) problems.push(`${rel}: hex color ${[...new Set(hits)].join(', ')}`);
  }

  for (const name of ORG_STRINGS) {
    if (source.includes(name)) problems.push(`${rel}: names "${name}" directly`);
  }
}

console.log(`${files.length} files scanned.`);

if (problems.length > 0) {
  console.error('\nStructural rule breached:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nColors belong in src/styles/tokens.css under semantic names.\n' +
      'Organization names belong on the organization record in src/config/orgs.ts.'
  );
  process.exit(1);
}

console.log('No hex literals outside tokens.css, and no organization named in a component.');
