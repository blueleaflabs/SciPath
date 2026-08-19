/**
 * THE SQL THAT EMPTIES A CLOUD PROJECT, WRITTEN OUT FOR SOMEBODY TO RUN.
 *
 * **This prints SQL rather than deleting anything, and that is not caution —
 * it is the only thing that works.** The migration revokes DELETE from
 * `service_role` on every table, because nothing in this system is ever hard
 * deleted: removal is a state column or an `archived_at`, and withholding the
 * privilege is what stops a policy handing it back. So the first version of
 * this script, which deleted through PostgREST with the secret key, was told
 * `permission denied for table org_domains` on its first statement — by a
 * rule the schema states plainly and I had not read.
 *
 * The privilege that can do this belongs to the database owner, and the place
 * you hold it is the Supabase SQL Editor. Emptying a real database is also a
 * thing worth doing where you can see the statement before it runs.
 *
 * The order is the constraint graph read backwards, derived from the
 * migration and checked against it by `tests/scripts.mjs` — a table missing
 * from the list would simply never be emptied, and the next seed would
 * collide with rows nobody expected.
 *
 * Accounts are separate: `auth.users` is not ours to truncate, and the admin
 * API is the supported way. `--accounts` does that part, which needs no
 * elevated privilege.
 *
 * Run:
 *   node scripts/reset-cloud.mjs                  # print the SQL
 *   node scripts/reset-cloud.mjs --accounts --yes --project=<ref>
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
 * Children before parents.
 *
 * Most foreign keys here are `on delete restrict` deliberately — a program
 * with projects in it is not something to quietly remove — so this order is
 * the constraint graph read backwards rather than a preference.
 *
 * **Derived from the migration, not written by hand.** My first attempt at
 * this list from memory named two tables that do not exist and missed twelve
 * that do. `tests/scripts.mjs` asserts it covers every table the migration
 * creates, in both directions.
 *
 * `organizations` is deliberately absent: `seed-orgs.mjs` recreates it, and
 * leaving it means a half-finished run still has something coherent in it.
 */
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

if (!process.argv.includes('--accounts')) {
  console.log(`
-- Empty ${ref}. Paste into the Supabase SQL Editor and run.
--
-- One statement, so it is one transaction: it either empties everything or
-- nothing, rather than stopping partway and leaving a shape no seed expects.
--
-- \`organizations\` is left alone. \`seed-orgs.mjs\` recreates it, and leaving it
-- means an interrupted reset still has something coherent in it.
--
-- Accounts are not here. \`auth.users\` is not ours to truncate:
--   node scripts/reset-cloud.mjs --accounts --yes --project=${ref}

truncate table
${TABLES.map((t) => `  public.${t}`).join(',\n')}
  cascade;
`);

  console.log(`-- Then, in order:
--   node scripts/reset-cloud.mjs --accounts --yes --project=${ref}
--   node scripts/seed-orgs.mjs
--   node --experimental-strip-types scripts/seed-programs.mjs
--   node scripts/seed-people.mjs
`);

  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);
const named = args.find((a) => a.startsWith('--project='))?.split('=')[1];

if (!args.includes('--yes') || named !== ref) {
  fail(
    `This removes every account from ${ref}. There is no undo.\n\n` +
      `To do it:\n` +
      `  node scripts/reset-cloud.mjs --accounts --yes --project=${ref}`
  );
}

const db = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`\nRemoving accounts from ${ref}\n`);

let removed = 0;

/* Paged, because the admin API returns a page at a time. Re-listing rather
   than walking pages, since each delete shifts what page two holds. */
for (;;) {
  const { data: list, error } = await db.auth.admin.listUsers({ perPage: 200 });
  if (error) fail(`Could not read the accounts: ${error.message}`);

  const batch = list?.users ?? [];
  if (batch.length === 0) break;

  for (const account of batch) {
    const { error: deleteError } = await db.auth.admin.deleteUser(account.id);
    if (deleteError) fail(`${account.email}: ${deleteError.message}`);
    removed += 1;
    console.log(`  ${account.email}`);
  }
}

console.log(`\n${removed} account${removed === 1 ? '' : 's'} removed.`);
console.log(
  '\nNext:\n' +
    '  node scripts/seed-orgs.mjs\n' +
    '  node --experimental-strip-types scripts/seed-programs.mjs\n' +
    '  node scripts/seed-people.mjs\n'
);
