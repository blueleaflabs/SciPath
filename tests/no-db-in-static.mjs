/**
 * The rule that protects the archive.
 *
 * A prerendered route may never import lib/supabase. The public surface
 * builds from files in the repository and nothing else, and it has to keep
 * serving with the database gone.
 *
 * Under a monorepo this was guaranteed by structure. In one project it is
 * guaranteed by this test, which is why the test is not optional.
 *
 * Run: npm run test:static
 */

import fs from 'node:fs';
import path from 'node:path';

const pagesDir = path.join(process.cwd(), 'src/pages');
const DB_IMPORT = /from\s+['"][^'"]*lib\/supabase[^'"]*['"]/;
const ON_DEMAND = /export\s+const\s+prerender\s*=\s*false/;

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.(astro|ts|tsx|js|mjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

if (!fs.existsSync(pagesDir)) {
  console.error('No src/pages directory found.');
  process.exit(1);
}

const files = walk(pagesDir);
const offenders = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  if (DB_IMPORT.test(source) && !ON_DEMAND.test(source)) {
    offenders.push(path.relative(process.cwd(), file));
  }
}

console.log(`${files.length} routes scanned.`);

if (offenders.length > 0) {
  console.error('\nPrerendered routes importing the database client:');
  for (const file of offenders) console.error(`  ${file}`);
  console.error(
    '\nEither mark the route on-demand with `export const prerender = false`,\n' +
      'or read the data from the repository instead. The archive must build\n' +
      'with the database environment variables absent entirely.'
  );
  process.exit(1);
}

console.log('No prerendered route imports the database client.');
