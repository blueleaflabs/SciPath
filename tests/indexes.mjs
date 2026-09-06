/**
 * EVERY COLUMN A POLICY OR A JOIN READS HAS AN INDEX.
 *
 * Postgres indexes a primary key and a unique constraint and nothing else.
 * A foreign key is a constraint, not an index, and seventy-seven of them in
 * `0001` had none. Every policy asks `org_id = app.org_id()`;
 * `can_see_project` joins through `project_authors` and `participations`;
 * `my_nudges` reads `notifications.recipient_id`. Each one without an index
 * is a sequential scan that grows with the tenant, which is the one cost in
 * the performance list (12.15) that degrades nonlinearly.
 *
 * The rule: every `org_id`, and every foreign key that is not bookkeeping
 * about who did something, is the leading column of an index or a unique
 * constraint. The bookkeeping columns are read by looking a row up and
 * never by looking a person up, so an index on them is a cost on every
 * write with no read to pay for it.
 *
 * Read from the migration as text, like the other rules of this shape, and
 * proven to read: the count of foreign keys found is asserted so a pattern
 * that stops matching is a failure rather than a silent pass.
 *
 * Run: npm run test:indexes
 */

import assert from 'node:assert/strict';
import { migrationSql } from './migrations.mjs';

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

const raw = migrationSql();
const sql = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

/** Who-did-it columns: looked up by row, never by person. */
const BOOKKEEPING = /(_by|^actor_id|^actor_user_id|^identity_id|^supersedes|^from_project)$/;

/* Foreign keys, from column definitions and from later alters. */
const foreignKeys = [];
for (const m of sql.matchAll(/create table public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const [, table, body] = m;
  for (const line of body.split('\n')) {
    const col = line.match(/^\s*(\w+)\s+\w+[^,]*\breferences\s+(?:public|auth)\.(\w+)/);
    if (col && col[1] !== 'constraint') foreignKeys.push({ table, column: col[1], to: col[2] });
    /* A table-level `constraint x foreign key (col) references ...`. */
    const named = line.match(/^\s*constraint\s+\w+\s+foreign key\s*\((\w+)\)\s*references\s+public\.(\w+)/);
    if (named) foreignKeys.push({ table, column: named[1], to: named[2] });
  }
}
for (const m of sql.matchAll(/alter table public\.(\w+)\s+add\s+column\s+(\w+)[^;]*?\breferences\s+public\.(\w+)/g)) {
  foreignKeys.push({ table: m[1], column: m[2], to: m[3] });
}
for (const m of sql.matchAll(/alter table public\.(\w+)\s+add\s+constraint\s+\w+\s+foreign key\s*\((\w+)\)\s*references\s+public\.(\w+)/g)) {
  foreignKeys.push({ table: m[1], column: m[2], to: m[3] });
}

/* What is indexed: the leading column of every index, unique and primary key. */
const indexed = new Map();
const add = (table, column) => {
  if (!indexed.has(table)) indexed.set(table, new Set());
  indexed.get(table).add(column);
};
for (const m of sql.matchAll(/create (?:unique )?index (?:if not exists )?\w+\s+on public\.(\w+)\s*(?:using \w+\s*)?\(\s*(?:lower\()?(\w+)/g)) {
  add(m[1], m[2]);
}
for (const m of sql.matchAll(/create table public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const [, table, body] = m;
  for (const u of body.matchAll(/\b(?:unique|primary key)\s*\(\s*(\w+)/g)) add(table, u[1]);
  for (const line of body.split('\n')) {
    const inline = line.match(/^\s*(\w+)\s+\w+[^,]*\b(?:primary key|unique)\b/);
    if (inline) add(table, inline[1]);
  }
}
for (const m of sql.matchAll(/alter table public\.(\w+)\s+add\s+(?:constraint\s+\w+\s+)?(?:unique|primary key)\s*\(\s*(\w+)/g)) {
  add(m[1], m[2]);
}

test('the migration was read', () => {
  assert.ok(foreignKeys.length >= 100, `only ${foreignKeys.length} foreign keys found, so this read almost nothing`);
  assert.ok(indexed.size >= 30, `only ${indexed.size} tables carry any index, which cannot be right`);
});

test('every org_id and every joined foreign key is indexed', () => {
  const problems = [];
  for (const fk of foreignKeys) {
    if (fk.column !== 'org_id' && BOOKKEEPING.test(fk.column)) continue;
    if (!indexed.get(fk.table)?.has(fk.column)) {
      problems.push(`${fk.table}.${fk.column} -> ${fk.to}`);
    }
  }
  assert.deepEqual(problems, [], 'add `create index if not exists <table>_<column>_idx on public.<table> (<column>);` to the index block at the end of 0001');
});

console.log(`${passed} index assertions passed. ${foreignKeys.length} foreign keys read, ${indexed.size} tables with indexes.`);
