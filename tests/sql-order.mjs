/**
 * The migration runs top to bottom, and it only ever does that on a fresh
 * reset.
 *
 * A policy calling a function defined two thousand lines later works fine on
 * a database that already has both, and fails the moment somebody rebuilds.
 * That is exactly what happened: the visibility function went in at the end
 * of the file and forty-two policies above it referenced it, so every test
 * here passed and `npm run reset` did not.
 *
 * Postgres has `check_function_bodies` for the second half of this, and the
 * honest fix is to put things in an order that makes sense rather than to
 * turn the checking off.
 *
 * Run: npm run test:sqlorder
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

const dir = 'supabase/migrations';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

/* Concatenated in the order Postgres applies them, because a function in an
   earlier migration is available to a later one. */
const sql = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const lineOf = (index) => sql.slice(0, index).split('\n').length;

/** Where each function is first defined. */
const functions = new Map();
for (const m of sql.matchAll(/create or replace function (app|public)\.(\w+)\s*\(/g)) {
  const name = `${m[1]}.${m[2]}`;
  if (!functions.has(name)) functions.set(name, lineOf(m.index));
}

/** Where each table is created. */
const tables = new Map();
for (const m of sql.matchAll(/create table public\.(\w+)/g)) {
  if (!tables.has(m[1])) tables.set(m[1], lineOf(m.index));
}

/**
 * Where each column becomes available.
 *
 * A table existing is not enough. `can_see_project` read `programs.family`,
 * which an `alter table` added five thousand lines further down, and the
 * error names the column rather than the ordering — which is why this took
 * three attempts to see.
 */
const columns = new Map();
const noteColumn = (table, column, at) => {
  const key = `${table}.${column}`;
  if (!columns.has(key)) columns.set(key, at);
};

for (const m of sql.matchAll(/create table public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const at = lineOf(m.index);
  for (const line of m[2].split('\n')) {
    const col = line.match(/^\s{2}([a-z_]+)\s+\S/);
    if (col && !['constraint', 'unique', 'primary', 'check', 'foreign', 'exclude'].includes(col[1])) {
      noteColumn(m[1], col[1], at);
    }
  }
}

for (const m of sql.matchAll(/alter table (?:only )?public\.(\w+)([\s\S]*?);/g)) {
  const at = lineOf(m.index);
  for (const col of m[2].matchAll(/add column\s+(?:if not exists\s+)?([a-z_]+)/gi)) {
    noteColumn(m[1], col[1], at);
  }
}

test('the migration parses into something', () => {
  assert.ok(functions.size > 20, `only ${functions.size} functions`);
  assert.ok(tables.size > 20, `only ${tables.size} tables`);
});

test('no policy calls a function defined later in the file', () => {
  const problems = [];

  for (const m of sql.matchAll(/create policy (\w+) on public\.(\w+)[\s\S]*?;\n/g)) {
    const at = lineOf(m.index);
    for (const [name, defined] of functions) {
      const called = new RegExp(`\\b${name.replace('.', '\\.')}\\s*\\(`);
      if (called.test(m[0]) && defined > at) {
        problems.push(`${m[1]} at line ${at} calls ${name}, defined at ${defined}`);
      }
    }
  }

  assert.deepEqual(problems, [], 'these fail on a fresh reset and nowhere else');
});

test('no function calls another function defined later in the file', () => {
  /* The case the first version of this test missed, and the one that broke
     the second reset: `can_see_project` calls `is_advisor`, which was defined
     thirteen hundred lines further down. A SQL function has its body checked
     when it is created, so this fails outright rather than lying in wait. */
  const problems = new Set();

  for (const m of sql.matchAll(/create or replace function (app|public)\.(\w+)[\s\S]*?\n\$\$;/g)) {
    const me = `${m[1]}.${m[2]}`;
    const at = lineOf(m.index);
    const body = m[0];

    for (const [name, defined] of functions) {
      if (name === me) continue;
      const called = new RegExp(`\\b${name.replace('.', '\\.')}\\s*\\(`);
      if (called.test(body) && defined > at) {
        problems.add(`${me} at line ${at} calls ${name}, defined at ${defined}`);
      }
    }
  }

  assert.deepEqual([...problems], [], 'these fail on a fresh reset and nowhere else');
});

test('no function reads a table created later in the file', () => {
  /* A SQL-language function has its body checked at creation, so this is a
     hard failure rather than a latent one. */
  const problems = new Set();

  for (const m of sql.matchAll(/create or replace function (app|public)\.(\w+)[\s\S]*?\n\$\$;/g)) {
    const at = lineOf(m.index);
    for (const [table, created] of tables) {
      if (new RegExp(`public\\.${table}\\b`).test(m[0]) && created > at) {
        problems.add(`${m[1]}.${m[2]} at line ${at} reads public.${table}, created at ${created}`);
      }
    }
  }

  assert.deepEqual([...problems], []);
});

test('no function reads a column that does not exist yet', () => {
  /* The fourth variant of the same fault, and the one the first three checks
     did not cover: the table was there and the column was not. */
  const problems = new Set();

  for (const m of sql.matchAll(/create or replace function (app|public)\.(\w+)[\s\S]*?\n\$\$;/g)) {
    const at = lineOf(m.index);
    const body = m[0];

    for (const [key, added] of columns) {
      if (added <= at) continue;
      const [table, column] = key.split('.');
      /* Only worth flagging where the function actually names the table, or
         every late column in the schema matches every function. */
      if (!new RegExp(`public\\.${table}\\b`).test(body)) continue;
      if (new RegExp(`\\.${column}\\b`).test(body)) {
        problems.add(`${m[1]}.${m[2]} at line ${at} reads ${key}, added at ${added}`);
      }
    }
  }

  assert.deepEqual([...problems], [], 'these fail on a fresh reset and nowhere else');
});

test('no policy reads a column that does not exist yet', () => {
  const problems = new Set();

  for (const m of sql.matchAll(/create policy (\w+) on public\.(\w+)[\s\S]*?;\n/g)) {
    const at = lineOf(m.index);
    for (const [key, added] of columns) {
      if (added <= at) continue;
      const [table, column] = key.split('.');
      if (table !== m[2]) continue;
      if (new RegExp(`\\b${column}\\b`).test(m[0])) {
        problems.add(`${m[1]} at line ${at} reads ${key}, added at ${added}`);
      }
    }
  }

  assert.deepEqual([...problems], []);
});

test('no table references another that does not exist yet', () => {
  const problems = [];

  for (const m of sql.matchAll(/create table public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const at = lineOf(m.index);
    for (const ref of m[2].matchAll(/references\s+public\.(\w+)/g)) {
      const target = tables.get(ref[1]);
      /* A self-reference is fine; a forward one is not. */
      if (ref[1] !== m[1] && (target === undefined || target > at)) {
        problems.push(`public.${m[1]} at line ${at} references public.${ref[1]}`);
      }
    }
  }

  assert.deepEqual(problems, []);
});

test('every policy names a table that exists', () => {
  const problems = [];
  for (const m of sql.matchAll(/create policy (\w+) on public\.(\w+)/g)) {
    if (!tables.has(m[2])) problems.push(`${m[1]} is on public.${m[2]}, which is never created`);
  }
  assert.deepEqual(problems, []);
});

test('every grant names a function that exists', () => {
  const problems = [];
  for (const m of sql.matchAll(/grant execute on function (app|public)\.(\w+)/g)) {
    const name = `${m[1]}.${m[2]}`;
    if (!functions.has(name)) problems.push(`grant on ${name}, which is never defined`);
  }
  assert.deepEqual(problems, []);
});

/* ── One statement per table ─────────────────────────────────────────────── */

test('no table gains a column by ALTER', () => {
  /* A schema that is a create table followed by eleven alters five thousand
     lines apart is a schema nobody can read. Worse, it is the source of every
     ordering fault in this file: a function reading a column that the create
     statement does not have yet.
     
     While this migration is the only one, a column belongs in the create
     statement. When a second migration exists — after the first real
     deployment — an alter there is correct and this test moves with it. */
  const first = files[0];
  const text = fs.readFileSync(path.join(dir, first), 'utf8');

  const offenders = [...text.matchAll(/alter table (?:only )?public\.(\w+)[\s\S]*?;/g)]
    .filter((m) => /add column/i.test(m[0]))
    .map((m) => `${m[1]} at line ${text.slice(0, m.index).split('\n').length}`);

  assert.deepEqual(
    offenders,
    [],
    'put the column in the create table rather than adding it later'
  );
});

test('no column is declared twice in one table', () => {
  const problems = [];

  for (const m of sql.matchAll(/create table public\.(\w+)\s*\(\n([\s\S]*?)\n\);/g)) {
    const names = [...m[2].matchAll(/^ {2}([a-z_]+)\s+\S/gm)].map((c) => c[1]);
    const seen = new Set();
    for (const name of names) {
      if (seen.has(name)) problems.push(`${m[1]}.${name}`);
      seen.add(name);
    }
  }

  assert.deepEqual(problems, [], 'a duplicated column is a merge that went wrong');
});

test('table-level constraints come after the columns', () => {
  /* Postgres does not care, and a reader does: a `unique (a, b)` in the
     middle of a column list reads as a column. */
  for (const m of sql.matchAll(/create table public\.(\w+)\s*\(\n([\s\S]*?)\n\);/g)) {
    const lines = m[2].split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
    /* At exactly two spaces. A `check (...)` indented further is the
       continuation of a column definition, not a table constraint, and
       treating it as one flags every multi-line column in the schema. */
    const firstConstraint = lines.findIndex((l) =>
      /^ {2}(unique|primary key|check|constraint|foreign key|exclude)\b/i.test(l)
    );
    if (firstConstraint < 0) continue;

    const columnsAfter = lines
      .slice(firstConstraint)
      .filter((l) => /^ {2}[a-z_]+\s+\S/.test(l) && !/^\s*(unique|primary|check|constraint|foreign|exclude)/i.test(l));

    assert.deepEqual(columnsAfter, [], `${m[1]} has a column after a table constraint`);
  }
});

test('every create table has balanced parentheses', () => {
  /* Folding eleven alter blocks back into their create statements is exactly
     the edit that leaves a stray paren, and the error Postgres gives for one
     is unhelpful and a hundred lines from the cause. */
  const problems = [];
  for (const m of sql.matchAll(/create table public\.(\w+)\s*\(\n([\s\S]*?)\n\);/g)) {
    const open = (m[2].match(/\(/g) ?? []).length;
    const close = (m[2].match(/\)/g) ?? []).length;
    if (open !== close) problems.push(`${m[1]}: ${open} open, ${close} close`);
  }
  assert.deepEqual(problems, []);
});

test('no column carries two check constraints', () => {
  /* The signature of a constraint that was dropped and re-added rather than
     edited in place. */
  const problems = [];
  for (const m of sql.matchAll(/create table public\.(\w+)\s*\(\n([\s\S]*?)\n\);/g)) {
    /* Split into column definitions: a new one starts at exactly two spaces. */
    const chunks = m[2].split(/\n(?= {2}[a-z_]+\s)/);
    for (const chunk of chunks) {
      const checks = (chunk.match(/\bcheck\s*\(/g) ?? []).length;
      if (checks > 1) {
        problems.push(`${m[1]}: ${chunk.trim().split('\n')[0]}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

console.log(
  `${passed} ordering assertions passed. ${tables.size} tables, ${functions.size} functions.`
);
