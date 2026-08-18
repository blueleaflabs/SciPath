/**
 * ONE NAME, ONE DECLARATION.
 *
 * Nothing is in the cloud yet, so schema work is an edit to the single
 * migration rather than a new one. The habit that grew out of that is
 * appending: a change was made by writing a second `create or replace
 * function` further down the file and leaving the first where it was.
 *
 * Postgres takes the last, so it works. What it costs is everything that
 * reads the file rather than applies it.
 *
 * Twelve functions had grown to twenty-eight definitions, sixteen of them
 * dead. `start_entry` was declared three times and the live one was the
 * third, so a grep landed on a body that had not run since the change that
 * superseded it. The rationale went with them: each later layer routinely
 * dropped the comment explaining the layer before, so the reason a rule
 * existed survived only in the copy that no longer enforced it.
 *
 * And the dead copies drifted out of the schema entirely. `app.is_staff`
 * tested for the role `mentor`, which `user_roles.role` no longer permits --
 * a predicate that could only ever answer false for half of its own name,
 * sitting above the live one that had been corrected.
 *
 * It reached the behavior too. `record_sponsor`'s first definition scoped the
 * approval it closed to one participation, exactly as 22.18 requires; its
 * second replaced that with a project-wide reconciliation, so naming the
 * teacher who runs the class closed the fair's approval as well. Both bodies
 * were in the file, the correct one was dead, and nothing said so.
 *
 * Five policies had been dropped and recreated identically, which does
 * nothing at all: a policy stores a reference to the function, and `create or
 * replace` keeps the same one, so redefining the function is enough.
 *
 * So: a name is declared once. A revision edits the declaration where it is.
 *
 * `sql-order.mjs` records where each function is FIRST defined, which meant
 * every ordering assertion in it was checked against a dead copy's position
 * for as long as the duplicates existed. That check and this one need each
 * other.
 *
 * Run: npm run test:declarations
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
const sql = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const lineOf = (index) => sql.slice(0, index).split('\n').length;

/**
 * What counts as a declaration.
 *
 * Anchored at the start of a line, because the same words appear inside
 * `execute format(...)` in the trigger loops and inside quoted strings in the
 * test harness, and a check that reports those is a check somebody turns off.
 *
 * A function's identity is its name and its argument types, so an overload is
 * two declarations of two different things. Postgres agrees, and so does the
 * one real overload here. The signature is normalized to argument type names
 * so that a rename of a parameter is not read as a new function.
 */
const kinds = [
  { what: 'function', pattern: /^create or replace function ((?:app|public)\.\w+)\s*\(([\s\S]*?)\)\s*\n?returns/gim },
  { what: 'policy', pattern: /^create policy (\w+) on (public\.\w+)/gim },
  { what: 'trigger', pattern: /^create trigger (\w+)/gim },
  { what: 'table', pattern: /^create table (public\.\w+)/gim },
  { what: 'view', pattern: /^create (?:or replace )?view (public\.\w+)/gim },
  { what: 'index', pattern: /^create (?:unique )?index (?:if not exists )?(\w+)/gim },
];

/* `p_name text default null` -> `text`. Defaults may name a function call
   with commas in it, so the split is on top-level commas only. */
function signature(args) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of args) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += ch;
  }
  parts.push(current);

  return parts
    .map((p) => p.trim().replace(/\s+default[\s\S]*$/i, '').split(/\s+/).slice(1).join(' '))
    .filter(Boolean)
    .join(', ');
}

const declarations = new Map();
let counted = 0;

for (const { what, pattern } of kinds) {
  for (const m of sql.matchAll(pattern)) {
    const key =
      what === 'function'
        ? `${what} ${m[1]}(${signature(m[2])})`
        : what === 'policy'
          ? `${what} ${m[1]} on ${m[2]}`
          : `${what} ${m[1]}`;

    if (!declarations.has(key)) declarations.set(key, []);
    declarations.get(key).push(lineOf(m.index));
    counted += 1;
  }
}

test('the migration parses into something', () => {
  assert.ok(counted > 200, `only ${counted} declarations found, so this read almost nothing`);
});

test('every declaration in the file was read', () => {
  /* The failure this check exists for is its own. The patterns above assume a
     shape -- a schema-qualified name, `returns` after the argument list -- and
     a function written in a shape they do not match is not reported as a
     duplicate, because it is not seen at all. A guard that under-reads reports
     green, which is worse than no guard: the whole point of 19.9 is that a
     check reports how much it read, so a drop is visible.
 
     So the loose count and the parsed count are compared. If they diverge, a
     pattern above needs widening rather than the number here needs raising. */
  const loose = {
    function: /^create or replace function /gim,
    policy: /^create policy /gim,
    trigger: /^create trigger /gim,
    table: /^create table /gim,
    view: /^create (?:or replace )?view /gim,
    index: /^create (?:unique )?index /gim,
  };

  const problems = [];

  for (const [what, pattern] of Object.entries(loose)) {
    const found = [...sql.matchAll(pattern)].length;
    const read = [...declarations.entries()]
      .filter(([key]) => key.startsWith(`${what} `))
      .reduce((n, [, lines]) => n + lines.length, 0);

    if (found !== read) {
      problems.push(`${what}: the file has ${found} and this read ${read}`);
    }
  }

  assert.deepEqual(problems, [], 'widen the pattern; do not lower the count');
});

test('nothing is declared twice', () => {
  const problems = [];

  for (const [key, lines] of declarations) {
    if (lines.length > 1) {
      problems.push(`${key} at lines ${lines.join(', ')} — the last one wins and the rest are read as if they did not`);
    }
  }

  assert.deepEqual(problems, [], 'edit the declaration where it is');
});

test('no policy is dropped and recreated', () => {
  /* A policy references its function rather than copying it, so `create or
     replace function` is enough on its own and the drop is a no-op that reads
     as a change. Six of these were in the file.
 
     **This rule is narrower than it first looks and deliberately so.** It was
     briefly widened to every `drop ... if exists`, and that immediately
     flagged four statements that are correct: two triggers dropped before
     being created, which is how a trigger is redefined, and two functions
     dropped by an *older signature* than the one the file creates, which is
     the only way to remove an overload from a database built by an earlier
     version of this file. One of them carries a comment naming the failure it
     was written for. Reporting those as faults would have taught somebody to
     ignore the check, which is the failure mode 19.9 warns about twice.
 
     A policy is different because the no-op is provable: same name, same
     table, and `create or replace function` keeps the oid the policy points
     at, so the drop cannot be doing anything. */
  const problems = [];

  for (const m of sql.matchAll(/^drop policy (?:if exists )?(\w+)/gim)) {
    problems.push(`${m[1]} at line ${lineOf(m.index)}`);
  }

  assert.deepEqual(problems, [], 'redefine the function the policy calls instead');
});

test('no grant names a function declared further down', () => {
  /* This is the half that fails loudly rather than quietly: a grant on a
     function that does not exist yet aborts the migration. It is the reason
     collapsing to the earliest position is not always available. */
  const problems = [];

  for (const m of sql.matchAll(/^grant execute on function ((?:app|public)\.\w+)/gm)) {
    const at = lineOf(m.index);
    const declared = [...declarations.entries()]
      .filter(([key]) => key.startsWith(`function ${m[1]}(`))
      .flatMap(([, lines]) => lines);

    if (declared.length > 0 && Math.min(...declared) > at) {
      problems.push(`${m[1]} granted at line ${at}, declared at ${Math.min(...declared)}`);
    }
  }

  assert.deepEqual(problems, [], 'these abort a fresh reset');
});

console.log(
  `${passed} declaration assertions passed. ` +
    `${counted} declarations read, ${declarations.size} distinct names.`
);
