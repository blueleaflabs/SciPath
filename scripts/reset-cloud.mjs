/**
 * EMPTY THE CLOUD PROJECT AND START AGAIN.
 *
 * `npm run reset` drops and recreates the local database, and its guards point
 * the other way: `seed-demo` refuses anything that is not loopback, precisely
 * so that a habit built on a laptop cannot reach a real deployment.
 *
 * This is the deliberate counterpart. It removes every row the application
 * owns and every account, and leaves the schema alone — so the migration does
 * not need reapplying and nothing has to be dropped. Afterwards:
 *
 *   node scripts/seed-orgs.mjs
 *   node --experimental-strip-types scripts/seed-programs.mjs
 *   node scripts/seed-people.mjs
 *
 * **It refuses loopback.** `supabase db reset` is the right tool locally and
 * this is not it; a script that did both would be one flag away from doing the
 * wrong one.
 *
 * Two confirmations, because there is no undo and no backup on the free tier:
 * `--yes`, and the project ref typed out. A single flag is a thing that ends
 * up in shell history and then in a re-run.
 *
 * Run:
 *   PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
 *     node scripts/reset-cloud.mjs --yes --project=<ref>
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars } from './dev-vars.mjs';

loadDevVars();

const URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!URL || !KEY) {
  fail('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed.');
}

if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL)) {
  fail(
    'This is the local database. Use `npm run reset`, which drops and recreates\n' +
      'it properly. This script exists only for a cloud project.'
  );
}

const ref = URL.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1];

if (!ref) fail(`Could not read a project ref out of ${URL}.`);

const args = process.argv.slice(2);
const named = args.find((a) => a.startsWith('--project='))?.split('=')[1];

if (!args.includes('--yes') || named !== ref) {
  fail(
    `This removes every row and every account from ${ref}.\n\n` +
      `The schema stays. There is no undo.\n\n` +
      `To do it:\n` +
      `  node scripts/reset-cloud.mjs --yes --project=${ref}`
  );
}

const db = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Children before parents.
 *
 * Most foreign keys here are `on delete restrict` deliberately — a program
 * with projects in it is not something to quietly remove — so this order is
 * the constraint graph read backwards rather than a preference.
 *
 * **Derived from the migration, not written by hand.** My first attempt at
 * this list by memory named two tables that do not exist and missed twelve
 * that do. `tests/scripts.mjs` now asserts it covers every table the
 * migration creates, so a table added next year fails a suite rather than
 * being silently left full of rows for the next seed to collide with.
 *
 * `organizations` is deliberately absent: `seed-orgs.mjs` recreates it, and
 * leaving it means a half-finished run still has something coherent in it.
 */
/**
 * The column each table is deleted by.
 *
 * PostgREST refuses an unfiltered delete, so every one needs a filter that
 * matches every row — and three of these have no `id`, because their key is
 * composite: `notification_settings` is keyed by person and category,
 * `record_authors` by record and order, `record_sequences` by org and year.
 *
 * A column that is `not null` in the schema is the safe choice, since
 * `not.is.null` then matches every row. Checked against the migration by
 * `tests/scripts.mjs` rather than trusted, because a delete filtered on a
 * column that does not exist fails at run time — halfway through, on a
 * database somebody has just decided to empty.
 */
const DELETE_BY = {
  notification_settings: 'user_id',
  record_authors: 'record_id',
  record_sequences: 'org_id',
};

const TABLES = [
  'org_domains',
  'audit_log',
  'identities',
  'user_roles',
  'guardian_consents',
  'pending_role_grants',
  'notifications',
  'notification_settings',
  'project_authors',
  'deliverables',
  'entry_milestones',
  'project_sponsors',
  'record_authors',
  'records',
  'participations',
  'note_media',
  'field_notes',
  'project_links',
  'step_warnings',
  'manuscript_sections',
  'manuscript_figures',
  'manuscript_references',
  'state_events',
  'reviews',
  'review_findings',
  'submissions',
  'manuscripts',
  'project_images',
  'projects',
  'memberships',
  'role_reservations',
  'users',
  'confirmation_tokens',
  'program_milestones',
  'programs',
  'record_sequences',
];

console.log(`\nEmptying ${ref}\n`);

for (const table of TABLES) {
  const { error, count } = await db
    .from(table)
    .delete({ count: 'exact' })
    .not(DELETE_BY[table] ?? 'id', 'is', null);

  if (error) {
    /* A table this migration does not have is not a failure: the list is
       written against the schema and the schema is allowed to be older. */
    if (/does not exist|schema cache/i.test(error.message)) {
      console.log(`  ${table.padEnd(24)} not in this schema, skipped`);
      continue;
    }
    fail(`${table}: ${error.message}`);
  }

  console.log(`  ${table.padEnd(24)} ${count ?? 0}`);
}

/* Accounts last, because `users.id` references them and the rows above have
   to go first. Paged, because the admin API returns a page at a time and a
   school with more than one page of students is the ordinary case. */
let removed = 0;

for (;;) {
  const { data: list, error } = await db.auth.admin.listUsers({ perPage: 200 });
  if (error) fail(`Could not read the accounts: ${error.message}`);

  const batch = list?.users ?? [];
  if (batch.length === 0) break;

  for (const account of batch) {
    const { error: deleteError } = await db.auth.admin.deleteUser(account.id);
    if (deleteError) fail(`${account.email}: ${deleteError.message}`);
    removed += 1;
  }

  if (batch.length < 200) break;
}

console.log(`\n${removed} account${removed === 1 ? '' : 's'} removed.`);
console.log(
  '\nNext:\n' +
    '  node scripts/seed-orgs.mjs\n' +
    '  node --experimental-strip-types scripts/seed-programs.mjs\n' +
    '  node scripts/seed-people.mjs\n'
);
