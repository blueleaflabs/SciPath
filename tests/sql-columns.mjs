/**
 * Columns named inside SQL against columns that exist.
 *
 * `test:drift` compares the schema with the column lists in PostgREST calls,
 * which covers every read the pages make and none of the writes the database
 * makes to itself. An INSERT inside a plpgsql function naming a column that
 * was never created compiles, deploys, and passes every test, then fails the
 * first time somebody presses the button that calls it.
 *
 * That is exactly what happened: `notifications` was designed with an
 * `immediate` flag, created without it, and three functions inserted into it
 * anyway. Assigning a reviewer failed with a message from Postgres in the
 * middle of a page.
 *
 * This reads the INSERT column lists out of the migration and checks each name
 * against the table it is being written to.
 *
 * Run: npm run test:sqlcols
 */

import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = 'supabase/migrations';

const columns = new Map();

function readSchema(sql) {
  for (const block of sql.matchAll(/create table public\.([a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
    const [, table, body] = block;
    const set = columns.get(table) ?? new Set();
    for (const line of body.split('\n')) {
      /* A column is two spaces, a name, then whitespace and a type. Constraint
         clauses and continuation lines are neither. */
      const m = line.match(/^\s{2}([a-z_]+)\s+\S/);
      if (
        m &&
        !['constraint', 'unique', 'primary', 'check', 'foreign', 'exclude'].includes(m[1])
      ) {
        set.add(m[1]);
      }
    }
    columns.set(table, set);
  }

  for (const block of sql.matchAll(/alter table (?:only )?public\.([a-z_]+)([\s\S]*?);/g)) {
    const [, table, body] = block;
    const set = columns.get(table) ?? new Set();
    for (const m of body.matchAll(/add column\s+(?:if not exists\s+)?([a-z_]+)/gi)) {
      set.add(m[1]);
    }
    columns.set(table, set);
  }
}

const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
const sources = files.map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
sources.forEach(readSchema);

const problems = [];
let checked = 0;

for (const [index, sql] of sources.entries()) {
  const file = files[index];

  /* insert into public.table (a, b, c) — the parenthesised list only, so an
     INSERT ... SELECT without a column list is skipped rather than guessed at. */
  for (const stmt of sql.matchAll(
    /insert into public\.([a-z_]+)\s*\n?\s*\(([^)]*?)\)\s*\n?\s*(?:values|select)/gi
  )) {
    const [, table, list] = stmt;
    const known = columns.get(table);
    if (!known) {
      problems.push(`${file}: insert into public.${table}, which is never created`);
      continue;
    }

    for (const raw of list.split(',')) {
      const name = raw.replace(/--.*$/gm, '').trim();
      if (!name) continue;
      checked += 1;
      if (!known.has(name)) {
        problems.push(
          `${file}: insert into public.${table} names "${name}", which that table does not have`
        );
      }
    }
  }
}

if (problems.length > 0) {
  console.error('\nColumns written in SQL that do not exist:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\n${problems.length} found. Each of these compiles and deploys, and fails the first\n` +
      'time somebody presses the button that runs it.\n'
  );
  process.exit(1);
}

console.log(
  `${checked} column references inside SQL inserts checked against ${columns.size} tables. All exist.`
);
