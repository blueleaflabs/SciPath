/**
 * EVERY MIGRATION AFTER THE FIRST ONLY ADDS.
 *
 * Decision 72. `0001` is what the pilot's database was built from, and there
 * is no down migration (19.11). The only rollback available is rolling the
 * code back, and that is only safe if the schema the old code expects is
 * still there: a column dropped, renamed or retyped by `0002` is a column the
 * previous build reads on its first request after the rollback.
 *
 * So, from `0002` onward: no `drop column`, no `drop table`, no `rename`, no
 * change of a column's type, and no `not null` on an added column without a
 * default. Expand now; contract, if ever, in a migration written after the
 * code that stopped needing the thing has been live for a while.
 *
 * Read as text, the way the other four rules of this shape are, and reported
 * by line so the fix is a jump rather than a search. Statements inside a
 * comment are stripped first, so a sentence explaining why something is
 * refused does not trip the refusal.
 *
 * Run: npm run test:additive
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

const DIR = 'supabase/migrations';
const later = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.sql') && !f.startsWith('0001'))
  .sort();

/** Comments out, line numbers kept. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '');
}

const REFUSED = [
  { why: 'drops a column', pattern: /\bdrop\s+column\b/i },
  { why: 'drops a table', pattern: /\bdrop\s+table\b/i },
  { why: 'renames something', pattern: /\balter\s+(?:table|column)\b[^;]*\brename\b/i },
  { why: 'changes a column type', pattern: /\balter\s+column\b[^;]*\btype\b/i },
  { why: 'sets not null on an existing column', pattern: /\balter\s+column\b[^;]*\bset\s+not\s+null\b/i },
];

test('every migration after 0001 is additive', () => {
  const problems = [];

  for (const file of later) {
    const text = stripComments(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const statements = text.split(';');
    let offset = 0;

    for (const statement of statements) {
      const line = text.slice(0, offset).split('\n').length;
      offset += statement.length + 1;

      for (const { why, pattern } of REFUSED) {
        if (pattern.test(statement)) problems.push(`${file}:${line} ${why}`);
      }

      /* `add column ... not null` with no default fails on apply against any
         table with rows in it, which the pilot's tables have. */
      if (/\badd\s+column\b/i.test(statement) && /\bnot\s+null\b/i.test(statement) && !/\bdefault\b/i.test(statement)) {
        problems.push(`${file}:${line} adds a not null column with no default`);
      }
    }
  }

  assert.deepEqual(problems, [], 'expand now, contract later, never in the same migration as the code that stops needing it');
});

test('the rule reads what it is pointed at', () => {
  /* A guard that finds nothing because it read nothing is the failure 19.9
     names most often. Prove the patterns fire on the statements they are
     written for. */
  const bait = [
    'alter table public.users drop column orcid;',
    'drop table public.identities;',
    'alter table public.users rename column orcid to orcid_id;',
    'alter table public.users alter column grad_year type text;',
    'alter table public.users alter column orcid set not null;',
    'alter table public.users add column region text not null;',
  ];
  for (const statement of bait) {
    const hit =
      REFUSED.some(({ pattern }) => pattern.test(statement)) ||
      (/\badd\s+column\b/i.test(statement) && /\bnot\s+null\b/i.test(statement) && !/\bdefault\b/i.test(statement));
    assert.ok(hit, `not refused: ${statement}`);
  }

  const fine = [
    'alter table public.users add column region text;',
    'alter table public.users add column region text not null default \'\';',
    'create index users_region_idx on public.users (region);',
    'create or replace function public.rename_project(p uuid, t text) returns void language sql as $$ select 1 $$;',
  ];
  for (const statement of fine) {
    const hit =
      REFUSED.some(({ pattern }) => pattern.test(statement)) ||
      (/\badd\s+column\b/i.test(statement) && /\bnot\s+null\b/i.test(statement) && !/\bdefault\b/i.test(statement));
    assert.ok(!hit, `wrongly refused: ${statement}`);
  }
});

console.log(`${passed} additive-migration assertions passed. ${later.length} migration${later.length === 1 ? '' : 's'} after 0001 read.`);
