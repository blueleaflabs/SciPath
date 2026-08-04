/**
 * The migration and the code that talks to it must agree on column names.
 *
 * A rename lands in one file and not the other, the build passes, every
 * other test passes, and the failure appears at runtime as "column X does
 * not exist" — which is exactly what happened when requires_sponsor became
 * requires_mentor and the seed script did not hear about it.
 *
 * This is a spelling check, not a type system: it collects the column names
 * the migration creates and the column names the code names in a select,
 * and reports anything the code asks for that the schema has never heard of.
 *
 * Run: npm run test:drift
 */

import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = 'supabase/migrations';
const ROOTS = ['src', 'scripts'];

/* Every identifier the migration defines: table columns, and the names of
   things a select can legitimately reference. */
const schema = new Set();

for (const file of fs.readdirSync(MIGRATIONS)) {
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

  /* Column definitions inside create table, plus anything renamed later. */
  for (const m of sql.matchAll(/^\s{2}([a-z_]+)\s+(uuid|text|int|integer|boolean|date|timestamptz|jsonb|bigserial)/gm)) {
    schema.add(m[1]);
  }
  /* Function parameters, referenced by name from every rpc call. They are
     declared on their own lines and sometimes inline with the signature. */
  for (const m of sql.matchAll(/\b(p_[a-z_]+)\b/g)) schema.add(m[1]);
  /* Table names, for embedded selects. */
  for (const m of sql.matchAll(/create table public\.([a-z_]+)/g)) schema.add(m[1]);
}

/* Column lists the code asks PostgREST for. */
const asked = new Map();

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(astro|ts|mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

for (const file of ROOTS.flatMap(walk)) {
  const source = fs.readFileSync(file, 'utf8');

  for (const m of source.matchAll(/\.select\(\s*'([^']+)'/g)) {
    for (const raw of m[1].split(',')) {
      /* Strip embedded resource syntax: users:author_id(display_name). */
      const name = raw.trim().split('(')[0].split(':').pop().trim();
      if (!name || name === '*' || /[^a-z_]/.test(name)) continue;
      if (!asked.has(name)) asked.set(name, file);
    }
  }

  for (const m of source.matchAll(/\b(p_[a-z_]+)\s*:/g)) {
    if (!asked.has(m[1])) asked.set(m[1], file);
  }
}

const unknown = [...asked].filter(([name]) => !schema.has(name));

console.log(`${schema.size} schema identifiers, ${asked.size} referenced by code.`);

if (unknown.length > 0) {
  console.error('\nThe code names something the migration does not define:');
  for (const [name, file] of unknown) console.error(`  ${name}  (${file})`);
  console.error(
    '\nUsually a rename that landed in one file and not the other. Check the\n' +
      'spelling against supabase/migrations/.'
  );
  process.exit(1);
}

console.log('Code and schema agree on every name.');
