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

  /* Column definitions inside create table. */
  /* The type list is exhaustive on purpose: a type missing from it makes
     every column of that type look like drift, which is how two numeric
     columns were reported as nonexistent while sitting in the migration. */
  for (const m of sql.matchAll(
    /^\s{2}([a-z_]+)\s+(uuid|text|int|integer|bigint|smallint|numeric|decimal|real|double|boolean|date|time|timestamp|timestamptz|jsonb|json|bytea|bigserial|serial|inet|interval)\b/gm
  )) {
    schema.add(m[1]);
  }

  /* Columns added later. A table grows by ALTER as often as it is created,
     and a scanner that only reads CREATE reports false drift on every one. */
  for (const m of sql.matchAll(/add column\s+(?:if not exists\s+)?([a-z_]+)/gi)) {
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

/* ── The same names, checked against the table they were asked of ────────── */

/**
 * Columns per table.
 *
 * The check above asks whether a name exists anywhere in the schema, which
 * `organizations.select('name')` passed: `name` is a real column on
 * `programs` and half a dozen other tables. The organizations table has
 * `lockup_name`, so the query returned an error and no rows, and the seed
 * reported that a school it had just created did not exist.
 *
 * A name existing somewhere is not the same as a name existing here.
 */
const columnsOf = new Map();
for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

  for (const m of sql.matchAll(/create table public\.(\w+)\s*\(\n([\s\S]*?)\n\);/g)) {
    const columns = new Set(
      [...m[2].matchAll(/^ {2}([a-z_]+)\s+\S/gm)]
        .map((c) => c[1])
        .filter((c) => !['unique', 'primary', 'check', 'constraint', 'foreign', 'exclude'].includes(c))
    );
    columnsOf.set(m[1], columns);
  }

  for (const m of sql.matchAll(/alter table (?:only )?public\.(\w+)([\s\S]*?);/g)) {
    for (const c of m[2].matchAll(/add column\s+(?:if not exists\s+)?([a-z_]+)/gi)) {
      columnsOf.get(m[1])?.add(c[1]);
    }
  }

  /**
   * Views, which page code reads and this check could not see.
   *
   * `cohort_participations` and `opportunity_participations` exist precisely
   * so that no page selects from `participations` directly (22.5), which
   * means every one of those reads was invisible here. A query asking the
   * cohort view for `cohort_id` -- a column that moved to `program_id` in the
   * merge -- passed this check and returned an error and no rows at runtime,
   * which is the exact failure the whole file exists to catch.
   *
   * Only `select *` views are resolved, and they inherit the columns of the
   * table they select from. A view with an explicit column list would need
   * its own parse, and there are none; if one appears, it is left unknown
   * rather than guessed at, because a wrong answer here is worse than none.
   */
  for (const m of sql.matchAll(
    /create view public\.(\w+) as\s*\n\s*select\s+(\w+)\.\*\s*\n\s*from public\.(\w+)/g
  )) {
    const inherited = columnsOf.get(m[3]);
    if (inherited) columnsOf.set(m[1], new Set(inherited));
  }
}

/**
 * Every column named in a select, with the table it belongs to.
 *
 * PostgREST's syntax nests: `a, b(c, d(e))` means `a` on this table, `c` on
 * `b`, and `e` on `d`. This walks it rather than pattern matching, because a
 * regular expression cannot count brackets and the columns worth checking
 * are the deepest ones.
 */
/**
 * Everything between an opening bracket and the one that closes it.
 *
 * `from` is the index just after `select(`. Counting is the only way: a
 * select carries nested brackets by design, and stopping at the first close
 * bracket reads a fragment and calls it a query.
 */
function callArgument(source, from) {
  let depth = 1;
  let quote = null;

  for (let i = from; i < source.length && i < from + 4000; i += 1) {
    const ch = source[i];

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(from, i);
    }
  }

  return null;
}

/** The call's first argument, ignoring commas inside brackets or quotes. */
function firstArgument(argument) {
  let depth = 0;
  let quote = null;

  for (let i = 0; i < argument.length; i += 1) {
    const ch = argument[i];

    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',' && depth === 0) return argument.slice(0, i);
  }

  return argument;
}

function selected(columns, table) {
  const out = [];
  let owner = table;
  const stack = [];
  let token = '';

  const flush = () => {
    const name = token.trim().split(':').pop().trim();
    token = '';
    if (!name || name === '*' || /[^a-z_]/.test(name)) return;
    out.push([name, owner]);
  };

  for (const ch of columns) {
    if (ch === '(') {
      /* The token before a bracket is a table, not a column. */
      const next = token.trim().split(':').pop().trim().replace(/!.*$/, '');
      stack.push(owner);
      owner = next;
      token = '';
    } else if (ch === ')') {
      flush();
      owner = stack.pop() ?? table;
    } else if (ch === ',') {
      flush();
    } else {
      token += ch;
    }
  }

  flush();
  return out;
}

const mismatched = [];

for (const file of ROOTS.flatMap(walk)) {
  const source = fs.readFileSync(file, 'utf8');

  /* `.from('x')` and the `.select(...)` that follows it, within a short
     window so an unrelated later select is not attributed to it.
   
     The end of the call is found by counting brackets rather than by
     matching, because a regular expression cannot. A lazy `\)` stops at the
     first close bracket, which in `select('a, b(c), d(users(email))')` is
     inside `b(...)` — so two thirds of the query went unread and the check
     reported agreement on a select it had barely seen. */
  for (const m of source.matchAll(/\.from\(\s*'(\w+)'\s*\)([\s\S]{0,400}?)\.select\(/g)) {
    const [, table, between] = m;
    if (/\.from\(/.test(between)) continue;

    const argument = callArgument(source, m.index + m[0].length);
    if (argument === null) continue;

    /* Only the first argument. A select may carry options —
       `select('id', { count: 'exact', head: true })` — and taking every
       quoted string in the call joined `id` to `exact` and reported a
       column called `idexact`. Split on the comma that ends the first
       argument, which is the one outside every bracket and quote. */
    const columns = [...firstArgument(argument).matchAll(/'([^']*)'/g)]
      .map((q) => q[1])
      .join('');

    if (!columns.trim()) continue;

    const known = columnsOf.get(table);
    if (!known) continue;

    /**
     * Embedded resources are checked too, against their own table.
     *
     * They used to be stripped, on the reasoning that the pass above already
     * knew every table name. It did, and it never looked at the *columns*
     * inside one — so `users(id, display_name, email)` went unexamined, and
     * a select naming a column that has never existed on `public.users`
     * reached a database before anybody noticed.
     *
     * The nesting is what made stripping tempting and what makes it wrong:
     * `projects(project_authors(users(...)))` is three tables deep, and the
     * columns that matter are at the bottom.
     */
    for (const [name, owner] of selected(columns, table)) {
      const knownThere = columnsOf.get(owner);
      if (!knownThere) continue;
      if (!knownThere.has(name)) {
        mismatched.push(`${owner}.${name}  (${file})`);
      }
    }
  }
}

const unknown = [...asked].filter(([name]) => !schema.has(name));

/**
 * A FILTER NAMES A COLUMN TOO.
 *
 * Everything above reads `.select(...)`. A `.eq('project_id', id)` names a
 * column just as surely and was never checked -- so when the sponsor moved
 * off the project onto the participation, three queries kept filtering on a
 * column that no longer existed and nothing said a word. The two the earlier
 * sweep did catch were caught only because they happened to *select*
 * `project_id` as well.
 *
 * Same failure as always: an error and no rows, which reads as "none".
 */
{
  const problems = [];
  const filter = /\.(?:eq|neq|gt|gte|lt|lte|is|in|not)\(\s*'([a-z_]+)'/g;
  const from = /\.from\(\s*'([a-z_]+)'\s*\)/g;

  for (const file of ROOTS.flatMap(walk)) {
    const text = fs.readFileSync(file, 'utf8');

    /* Which table a filter belongs to is the nearest `.from` above it, which
       is how these chains are written and is good enough to be useful. */
    for (const m of text.matchAll(filter)) {
      let table = null;
      for (const f of text.matchAll(from)) {
        if (f.index < m.index) table = f[1];
        else break;
      }

      const columns = table && columnsOf.get(table);
      if (!columns) continue;
      if (columns.has(m[1])) continue;
      /* `not` takes a column then an operator; `is` and `in` take a column.
         Anything that is not a column of that table is the bug. */
      problems.push(`${table}.${m[1]}  (${file})`);
    }
  }

  if (problems.length) {
    console.log('\nA query filters a table on a column it does not have:');
    for (const p of [...new Set(problems)]) console.log(`  ${p}`);
    console.log('\nThis returns an error and no rows, which reads as');
    console.log('"nothing found" rather than as a mistake.\n');
    process.exit(1);
  }
}

/**
 * AN EMBED ON A VIEW HAS TO NAME ITS FOREIGN KEY.
 *
 * `entries` and `project_cohorts` were tables, and a table carries its
 * foreign keys, so `.select('programs(name)')` resolved on its own. The two
 * participation views do not: a view has no constraints of its own, so the
 * relationship has to be spelled out as `programs:program_id(name)`.
 *
 * Left implicit the request errors and returns no rows, which reads on the
 * page as *"not in a class or entered anywhere yet"* -- a sentence that is
 * false and looks deliberate. It shipped that way, on the overview, while
 * the project page beside it worked, because that one happened to name the
 * key.
 *
 * Checked by reading the select rather than by calling the database, since
 * the failure is silent by construction.
 */
{
  const problems = [];
  const onView =
    /\.from\('(?:cohort|opportunity)_participations'\)\s*\n?\s*\.select\(\s*'([^']*)'/g;

  for (const file of ROOTS.flatMap(walk)) {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(onView)) {
      for (const embed of ['programs', 'projects']) {
        const bare = new RegExp(`(^|[ ,])${embed}\\(`);
        if (bare.test(m[1])) {
          problems.push(`${file}: ${embed}( on a participation view without its key`);
        }
      }
    }
  }

  if (problems.length) {
    console.log('\nAn embed on a view has to name the column it joins through:');
    for (const p of problems) console.log(`  ${p}`);
    console.log('\nWrite programs:program_id(...) rather than programs(...).');
    console.log('Left implicit this returns an error and no rows, which reads');
    console.log('as "nothing found" rather than as a mistake.\n');
    process.exit(1);
  }
}

console.log(`${schema.size} schema identifiers, ${asked.size} referenced by code.`);

if (mismatched.length > 0) {
  console.error('\nA query asks a table for a column it does not have:');
  for (const line of [...new Set(mismatched)]) console.error(`  ${line}`);
  console.error(
    '\nThis returns an error and no rows, which reads as "nothing found"\n' +
      'rather than as a mistake.'
  );
  process.exit(1);
}

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
