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

  /* insert into public.table (a, b, c) values (...) — the parenthesised list
     only, so an INSERT ... SELECT without a column list is skipped rather
     than guessed at. The values are captured too, because a name that exists
     is only half of what has to be true. */
  for (const stmt of sql.matchAll(
    /insert into public\.([a-z_]+)\s*\n?\s*\(([^)]*?)\)\s*\n?\s*(values\s*\(|select)/gi
  )) {
    const [, table, list, opener] = stmt;
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

    /* And as many values as columns.
     
       A mismatch here is "INSERT has more expressions than target columns",
       raised by Postgres when somebody presses the button, and it is easy to
       create: adding a column to one list and forgetting the other is a two
       line edit where one line silently does not apply. Counting is the whole
       check, and it has to respect nesting because a value can be a function
       call with commas of its own. */
    if (opener.startsWith('values')) {
      const from = stmt.index + stmt[0].length;
      let depth = 1;
      let commas = 1;
      let at = from;

      for (; at < sql.length && depth > 0; at += 1) {
        const char = sql[at];

        /* A block comment can contain commas, and one did: the count came out
           right while Postgres disagreed, which is worse than no check at
           all because it reads as a pass. */
        if (char === '/' && sql[at + 1] === '*') {
          const close = sql.indexOf('*/', at + 2);
          at = close < 0 ? sql.length : close + 1;
          continue;
        }

        if (char === '-' && sql[at + 1] === '-') {
          const eol = sql.indexOf('\n', at);
          at = eol < 0 ? sql.length : eol;
          continue;
        }

        if (char === "'") {
          /* Skip the string, doubled quotes and all. */
          at += 1;
          while (at < sql.length && !(sql[at] === "'" && sql[at + 1] !== "'")) {
            at += sql[at] === "'" ? 2 : 1;
          }
          continue;
        }
        if (char === '(') depth += 1;
        else if (char === ')') depth -= 1;
        else if (char === ',' && depth === 1) commas += 1;
      }

      const names = list
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/--.*$/gm, '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean).length;

      if (commas !== names) {
        problems.push(
          `${file}: insert into public.${table} lists ${names} columns and ${commas} values`
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
  `${checked} column references and value counts checked against ${columns.size} tables. All exist.`
);
