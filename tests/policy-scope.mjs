/**
 * A policy that asks the wrong question and never says so.
 *
 * Inside a policy subquery, an unqualified column name resolves to the
 * innermost table that has it. So this, on `public.projects`:
 *
 *   exists (select 1 from public.project_authors a
 *            where a.project_id = id and a.user_id = auth.uid())
 *
 * does not mean "is this person an author of this project". `id` binds to
 * `project_authors.id`, so it means `a.project_id = a.id`, comparing a
 * foreign key to a primary key, which is false for every row that has ever
 * existed. The policy silently denies. The same shape with `project_id`
 * instead of `id` binds to `a.project_id = a.project_id`, which is true for
 * every row, and the policy silently permits.
 *
 * Both compile. Both pass every other test. One locks a co-author out of
 * their own project and the other hands one student's notebook to another.
 * Postgres will not warn, because nothing is ambiguous: there is a rule and
 * it is being followed.
 *
 * The fix is always the same, so the rule is simple enough to enforce: inside
 * a policy, a reference to the policy's own table is written with the table
 * name on it.
 *
 * Run: npm run test:policy
 */

import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = 'supabase/migrations';

/* Columns, per table, from every create table in every migration. */
const columns = new Map();

/* Columns added by ALTER, which a scanner reading only CREATE will miss. */
function readSchema(sql) {
  for (const block of sql.matchAll(
    /create table public\.([a-z_]+)\s*\(([\s\S]*?)\n\);/g
  )) {
    const [, table, body] = block;
    const set = columns.get(table) ?? new Set();
    for (const line of body.split('\n')) {
      const m = line.match(/^\s{2}([a-z_]+)\s+\S/);
      if (m && !['constraint', 'unique', 'primary', 'check', 'foreign'].includes(m[1])) {
        set.add(m[1]);
      }
    }
    columns.set(table, set);
  }

  for (const block of sql.matchAll(
    /alter table public\.([a-z_]+)([\s\S]*?);/g
  )) {
    const [, table, body] = block;
    const set = columns.get(table) ?? new Set();
    for (const m of body.matchAll(/add column\s+(?:if not exists\s+)?([a-z_]+)/gi)) {
      set.add(m[1]);
    }
    columns.set(table, set);
  }
}

const files = fs
  .readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const sources = files.map((f) => fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
sources.forEach(readSchema);

const problems = [];

for (const [index, sql] of sources.entries()) {
  const file = files[index];

  /* Every policy body, up to the closing paren of its final clause. Policies
     in this schema always end with `);` on its own indentation. */
  for (const policy of sql.matchAll(
    /create policy\s+([a-z_]+)\s+on\s+public\.([a-z_]+)([\s\S]*?)\n\s*\);/g
  )) {
    const [, name, onTable, body] = policy;

    /* Each subquery inside the policy, with the table it reads and its alias. */
    for (const sub of body.matchAll(/from\s+public\.([a-z_]+)\s+([a-z]{1,3})\b([\s\S]*)/g)) {
      const [, innerTable, alias, rest] = sub;
      const innerColumns = columns.get(innerTable) ?? new Set();

      for (const comparison of rest.matchAll(
        new RegExp(`\\b${alias}\\.([a-z_]+)\\s*=\\s*([a-z_]+)\\b`, 'g')
      )) {
        const [, , right] = comparison;

        /* A bare word on the right that the inner table also has. Whatever
           the author meant, this is not it. */
        if (innerColumns.has(right)) {
          problems.push(
            `${file}: policy ${name} on ${onTable}\n` +
              `    "${comparison[0]}" binds ${right} to ${innerTable}.${right}, not ${onTable}.${right}.\n` +
              `    Write ${onTable}.${right}.`
          );
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('\nPolicy references that bind to the wrong table:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    `${problems.length} found. Each one either denies everything or permits everything,\n` +
      'and neither shows up as an error.\n'
  );
  process.exit(1);
}

const policyCount = sources
  .join('\n')
  .match(/create policy/g)?.length ?? 0;

console.log(
  `${policyCount} policies scanned across ${columns.size} tables. Every reference to a policy's own table is qualified.`
);
