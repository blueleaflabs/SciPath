/**
 * A property that no longer exists reads as `undefined`, which is falsy,
 * which is a working page showing the wrong branch. Nothing errors and
 * nothing fails, which is why several stale references survived three
 * refactors of the role model before anybody noticed.
 *
 * This checks that every `me.<something>` the pages read is a property the
 * Standing type actually defines.
 *
 * Run: npm run test:props
 */

import fs from 'node:fs';
import path from 'node:path';

const SOURCE = 'src/lib/roles.ts';
const ROOTS = ['src/pages', 'src/components'];

const roles = fs.readFileSync(SOURCE, 'utf8');
const block = roles.slice(
  roles.indexOf('export interface Standing'),
  roles.indexOf('}', roles.indexOf('export interface Standing'))
);

const known = new Set(
  [...block.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1])
);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(astro|ts)$/.test(e.name)) out.push(full);
  }
  return out;
}

const problems = [];

for (const file of ROOTS.flatMap(walk)) {
  const source = fs.readFileSync(file, 'utf8');
  if (!/\bstanding\(/.test(source) && !/\bme\./.test(source)) continue;

  for (const m of source.matchAll(/\bme\.(\w+)/g)) {
    if (!known.has(m[1])) {
      problems.push(`${path.relative(process.cwd(), file)}: me.${m[1]}`);
    }
  }
}

console.log(`Standing defines: ${[...known].join(', ')}`);

if (problems.length > 0) {
  console.error('\nReading a property Standing does not define:');
  for (const p of [...new Set(problems)]) console.error(`  ${p}`);
  console.error(
    '\nThese evaluate to undefined, which is falsy, so the page renders the\n' +
      'wrong branch and nothing errors. Usually a rename that missed a file.'
  );
  process.exit(1);
}

console.log('No page reads a property that does not exist.');
