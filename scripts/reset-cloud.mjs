/**
 * REBUILD A CLOUD PROJECT FROM NOTHING.
 *
 * One command. Nothing to paste.
 *
 * **A rebuild rather than a truncate.** There is one migration and it is
 * still being edited: 11.7 splits it at the first deployment holding work
 * somebody would miss, and a deployment being tested is not that. So the way
 * to apply a schema change to a cloud project is to reinstall it — and
 * `db push` records a migration by name and skips one it has seen, which is
 * why editing the file and pushing again reports success and changes nothing
 * at all.
 *
 * `supabase db reset --linked` does the whole of that: it drops what is
 * there and reapplies every local migration to the linked project. Earlier
 * versions of this script printed `drop schema ... cascade` and a
 * `delete from supabase_migrations.schema_migrations` for somebody to paste,
 * which worked and asked a person to do by hand something a tool already did
 * — and a partial paste then surfaced two commands later as a confusing
 * refusal from a different script.
 *
 * The CLI needs the project linked and will ask for the database password if
 * it is not cached. That is the one prompt left.
 *
 * Accounts are separate, because `auth.users` survives a schema reset: it
 * lives in `auth`, which is not ours to drop, and the admin API is the
 * supported way to clear it.
 *
 * The count at the end proves the outcome rather than asserting it, and
 * distinguishes *the reset did not run* from *the migration did not apply*,
 * which look identical from outside.
 *
 * Run:
 *   PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... \
 *     node scripts/reset-cloud.mjs --yes --project=<ref>
 *
 *   --verify   count only, change nothing
 */

import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import readline from 'node:readline/promises';
import { loadCloudVars } from './dev-vars.mjs';

/* `.cloud.vars`, not `.dev.vars`. The local file names the database
   `npm run reset` destroys, and the two must never be the same thing. */
loadCloudVars();

const URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

if (!URL || !KEY) {
  fail(
    'PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed.\n\n' +
      'Copy .cloud.vars.example to .cloud.vars and fill it in. Separate from\n' +
      '.dev.vars on purpose: `npm run reset` destroys whatever that file names.'
  );
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
const verifyOnly = args.includes('--verify');

/**
 * Typed out, once.
 *
 * This used to want `--yes --project=<ref>`, which is two flags to compose
 * and both end up in shell history where a re-run costs a database. A prompt
 * asks at the moment it matters and cannot be recalled with an up arrow.
 *
 * The ref rather than "yes", because typing the name of the thing is the
 * check: somebody in the wrong terminal types the wrong name.
 */
if (!verifyOnly) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`\nThis empties ${ref} completely. There is no undo.`);
  const typed = await rl.question(`Type the project ref to continue: `);
  rl.close();

  if (typed.trim() !== ref) {
    fail('That is not the project ref. Nothing has been changed.');
  }
}

/**
 * Children before parents.
 *
 * `truncate ... cascade` makes the order redundant for the statement itself,
 * but the list is what matters: a table missing from it is never emptied, and
 * the next seed collides with rows nobody expected.
 *
 * **Derived from the migration, not written by hand.** My first attempt from
 * memory named two tables that do not exist and missed twelve that do.
 * `tests/scripts.mjs` asserts it covers the schema in both directions, and
 * separately that `organizations` references nothing — `cascade` reaches any
 * table holding a key into a truncated one, and that table is deliberately
 * left alone so an interrupted reset still has something coherent in it.
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

const db = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Row counts for every table, plus the accounts.
 *
 * `tolerant` for the count taken **before** the reset, because the schema
 * about to be replaced is allowed to be wrong — that is usually why somebody
 * is running this. A table the secret key cannot read is noted and stepped
 * over rather than ending the run, since aborting there would refuse to fix
 * the very fault being reported. After the reset the schema is the one this
 * repository describes, and an unreadable table is a real failure.
 */
async function census({ tolerant = false } = {}) {
  const counts = new Map();
  const unreadable = [];

  for (const table of TABLES) {
    let { count, error } = await db
      .from(table)
      .select('*', { count: 'exact', head: true });

    /**
     * Ask again without `head` when the error says nothing.
     *
     * `head: true` tells PostgREST to send headers and no body, which is what
     * makes a count cheap — and means a *failed* count arrives with an empty
     * body too, so the client builds an error whose message is the empty
     * string. `Could not count step_warnings: {"message":""}` is a true
     * report of what came back and no use to anybody.
     *
     * A `limit(0)` asks for a body and no rows, so the same failure returns
     * the actual text. Only on the error path, so nothing is paid for it when
     * things work.
     */
    if (error && !error.message) {
      const retry = await db.from(table).select('*').limit(0);
      if (retry.error) error = retry.error;
    }

    if (error) {
      /* A table this migration does not have is not a failure: the list is
         written against the schema and the schema may be older. */
      if (/does not exist|schema cache/i.test(error.message ?? '')) continue;

      /**
       * The whole error, not just `message`.
       *
       * A permission failure on `count` came back with an empty `message` and
       * the code in `hint` and `code`, so this printed `Could not count
       * step_warnings:` and stopped — a line with nothing after the colon,
       * about a table three files from the grant that caused it. An error
       * that names nothing is worse than a stack trace.
       */
      const detail =
        [error.message, error.details, error.hint, error.code]
          .filter(Boolean)
          .join(' · ') || JSON.stringify(error);

      if (tolerant) {
        unreadable.push(table);
        continue;
      }

      fail(
        `Could not count ${table}: ${detail}\n\n` +
          `If this is a permission failure, the table is missing a grant to\n` +
          `service_role. Everything declared below the blanket grant needs one\n` +
          `of its own, and \`npm test\` checks that.`
      );
    }

    counts.set(table, count ?? 0);
  }

  const { data: list, error: listError } = await db.auth.admin.listUsers({ perPage: 1 });
  if (listError) fail(`Could not read the accounts: ${listError.message}`);

  return { counts, unreadable, accounts: list?.total ?? (list?.users?.length ?? 0) };
}

function report({ counts, unreadable = [], accounts }) {
  const left = [...counts].filter(([, n]) => n > 0);

  if (unreadable.length > 0) {
    console.log(`\n  Could not read (the schema being replaced): ${unreadable.join(', ')}`);
  }

  if (left.length === 0 && accounts === 0) {
    console.log(`\n  Every table is empty, and there are no accounts.`);
    return true;
  }

  console.log(`\n  Still holding rows:\n`);
  for (const [table, n] of left) console.log(`    ${table.padEnd(24)} ${n}`);
  if (accounts > 0) console.log(`    ${'(accounts)'.padEnd(24)} ${accounts}`);
  return false;
}

/* ------------------------------------------------------------------ */

console.log(`\nProject ${ref}`);

if (verifyOnly) {
  const clean = report(await census({ tolerant: true }));
  process.exit(clean ? 0 : 1);
}

console.log(`\nBefore:`);
report(await census({ tolerant: true }));

/* --- 1. rows ------------------------------------------------------ */

/**
 * `supabase db reset --linked`, inherited so its prompts reach the terminal.
 *
 * `--yes` is passed because this script has already asked: the project ref
 * had to be typed to get here, and asking twice for the same decision trains
 * somebody to answer without reading. The password prompt, if the CLI needs
 * one, still appears — that is the CLI's own and is not suppressed.
 *
 * Through `scripts/supabase.mjs` rather than `npx supabase` directly, so the
 * CLI gets `.dev.vars` in its environment the way everything else does.
 *
 * `--no-seed` because `supabase/seed.sql` says of itself that it never
 * reaches production, and a linked reset would run it. It is empty today, so
 * this changes nothing now and keeps that sentence true the day somebody
 * puts a demo project in it.
 */
console.log(`\nResetting the schema and reapplying the migration.\n`);

const status = await new Promise((resolve) => {
  const child = spawn(
    'node',
    ['scripts/supabase.mjs', 'db', 'reset', '--linked', '--yes', '--no-seed'],
    { stdio: 'inherit', env: process.env }
  );
  child.on('exit', (code) => resolve(code ?? 1));
  child.on('error', () => resolve(1));
});

if (status !== 0) {
  fail(
    'The reset failed.\n\n' +
      `If it could not find the project, link it first:\n` +
      `  npx supabase link --project-ref ${ref}`
  );
}

/**
 * The schema is back and empty, checked rather than believed.
 *
 * The CLI exiting zero is not proof: a reset that drops and then fails to
 * reapply leaves an empty database and a successful exit, and so does one
 * that silently skips. Counting distinguishes the two — no tables at all
 * means the migration did not apply, while tables holding rows means
 * something survived that should not have.
 *
 * PostgREST caches the schema, so a count immediately after a rebuild can
 * read the old shape. One retry, because a stale cache is a timing accident
 * and a missing table is not.
 */
let afterSql = await census();

if (afterSql.counts.size === 0) {
  await new Promise((r) => setTimeout(r, 3000));
  afterSql = await census();
}

if (afterSql.counts.size === 0) {
  fail(
    'No tables. The reset dropped the schema and the migration did not apply.\n' +
      'Run `npx supabase db reset --linked` on its own and read what it says.'
  );
}

if ([...afterSql.counts].some(([, n]) => n > 0)) {
  console.log(`\nSomething survived the rebuild.`);
  report(afterSql);
  fail('The reset did not empty everything. Run it again and read the output.');
}

console.log(`\n  Schema: ${afterSql.counts.size} tables, all empty.`);

/* --- 2. accounts -------------------------------------------------- */

let removed = 0;

/* Re-listing rather than paging, since each delete shifts what page two
   holds. Stops when a pass finds nothing. */
for (;;) {
  const { data: list, error } = await db.auth.admin.listUsers({ perPage: 200 });
  if (error) fail(`Could not read the accounts: ${error.message}`);

  const batch = list?.users ?? [];
  if (batch.length === 0) break;

  for (const account of batch) {
    const { error: deleteError } = await db.auth.admin.deleteUser(account.id);
    if (deleteError) fail(`${account.email}: ${deleteError.message}`);
    removed += 1;
    console.log(`  removed ${account.email}`);
  }
}

console.log(`\n  Accounts: ${removed} removed.`);

/* --- 3. file storage ----------------------------------------------- */

/**
 * R2, which `supabase db reset --linked` knows nothing about.
 *
 * Photographs and signed forms survive a schema rebuild as objects no row
 * refers to — invisible, because `/app/media/` refuses to serve anything
 * without a row pointing at it, and therefore worse than visible. "The reset
 * left nothing behind" was only true of the local stack.
 *
 * Skipped rather than failed when the credentials are absent, because they
 * are not needed for anything else here and a deployment being tested may not
 * have them yet. Said out loud either way: a silent skip is how somebody
 * comes to believe a bucket is empty.
 */
const R2 = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const bucket = process.env.R2_BUCKET;

if (R2.every((name) => process.env[name]) && bucket) {
  console.log(`\nEmptying ${bucket}\n`);

  const code = await new Promise((resolve) => {
    const child = spawn(
      'node',
      ['scripts/reset-storage.mjs', '--remote', `--bucket=${bucket}`],
      { stdio: 'inherit', env: process.env }
    );
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });

  if (code !== 0) fail('File storage was not emptied. The database is already rebuilt.');
} else {
  const absent = [...R2.filter((name) => !process.env[name]), ...(bucket ? [] : ['R2_BUCKET'])];
  console.log(
    `\n  File storage: skipped, ${absent.join(' and ')} not set.\n` +
      `  Any photographs already in R2 are still there and no row points at them.`
  );
}

/* --- 3. prove it -------------------------------------------------- */

console.log(`\nAfter:`);

if (!report(await census())) {
  fail('Something is still there. Nothing below should be run until it is not.');
}

/* --- 4. seed ------------------------------------------------------- */

/**
 * The seeds, run here rather than listed for somebody to paste.
 *
 * Three commands in a fixed order, each needing the same two variables
 * inline, is three chances to run the middle one twice or the last one first.
 * The order matters — `seed-people` scopes a role to a program and cannot
 * resolve one that has not been written yet — so the script that knows the
 * order should be the thing enforcing it.
 *
 * The demo fixtures are not here. They refuse a non-loopback target outright,
 * which is the right default until there is a decision about what a
 * demonstration should contain.
 */
const SEEDS = [
  ['Organizations', ['scripts/seed-orgs.mjs']],
  ['Programs', ['--experimental-strip-types', 'scripts/seed-programs.mjs']],
  ['People', ['scripts/seed-people.mjs', '--optional']],
];

for (const [what, argv] of SEEDS) {
  console.log(`\n${what}\n`);

  const code = await new Promise((resolve) => {
    const child = spawn('node', argv, { stdio: 'inherit', env: process.env });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });

  if (code !== 0) fail(`${what} failed. Nothing after it has run.`);
}

console.log(`\n${ref} is rebuilt and seeded.\n`);
