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
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { createClient } from '@supabase/supabase-js';
import { loadCloudVars } from './dev-vars.mjs';
import { loadOrgs } from './orgs-library.mjs';
import { originFor, apexOrigin } from '../src/lib/deployment.ts';

/* `.cloud.vars`, not `.dev.vars`. The local file names the database
   `npm run reset` destroys, and the two must never be the same thing. */
const cloudVars = loadCloudVars();

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

/**
 * Say where the value came from, not just that it is wrong.
 *
 * Three things can supply `PUBLIC_SUPABASE_URL` and they do not have equal
 * standing: an exported shell variable beats every file, `.cloud.vars` is
 * what this script means, and `.dev.vars` names the database `npm run reset`
 * destroys. Told only *this is the local database*, somebody edits the file
 * that is already correct — the shell is invisible and therefore the last
 * place anybody looks.
 */
function whereFrom(name) {
  if (cloudVars.applied.includes(name)) return '.cloud.vars';
  return 'the shell (there is no .cloud.vars)';
}

if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL)) {
  fail(
    `PUBLIC_SUPABASE_URL is ${URL}, from ${whereFrom('PUBLIC_SUPABASE_URL')}.\n\n` +
      'That is the local database, and `npm run reset` is the command for it.\n\n' +
      'Put the project URL in .cloud.vars, which overrides the shell and is\n' +
      'separate from .dev.vars because `npm run reset` destroys whatever that\n' +
      'one names.'
  );
}

const ref = URL.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1];
if (!ref) fail(`Could not read a project ref out of ${URL}.`);

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify');

/* Said out loud, above the block that names the project. A shell variable
   exported for local work is invisible and long forgotten, and replacing one
   silently is how somebody comes to distrust the tool rather than the
   variable. */
if (cloudVars.overrode.length > 0) {
  console.log(`\n  .cloud.vars overrode ${cloudVars.overrode.join(', ')} from the shell`);
}

/**
 * The CLI's link and `.cloud.vars` must name the same project.
 *
 * They are two independent settings. `supabase db reset --linked` goes
 * wherever `npx supabase link` last pointed, recorded in
 * `supabase/.temp/project-ref`; everything else here goes wherever
 * `.cloud.vars` says. **Nothing made them agree**, so a link left over from
 * another project would have this script rebuild one database and then seed a
 * different one — both steps reporting success, and the damage in the
 * database nobody was looking at.
 *
 * Read rather than trusted, and checked before the confirmation prompt so
 * that the ref somebody types is the ref that everything will use.
 */
const linkedRef = (() => {
  const file = 'supabase/.temp/project-ref';
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
})();

if (!verifyOnly) {
  if (!linkedRef) {
    fail(
      `No project is linked, so the schema cannot be rebuilt.\n\n` +
        `  npx supabase link --project-ref ${ref}`
    );
  }

  if (linkedRef !== ref) {
    fail(
      `These disagree, and one of them is wrong:\n\n` +
        `  .cloud.vars names   ${ref}\n` +
        `  the CLI is linked to ${linkedRef}\n\n` +
        `Rebuilding one and seeding the other would report success twice.\n\n` +
        `  npx supabase link --project-ref ${ref}`
    );
  }
}

/**
 * The whole environment, then one question.
 *
 * This asked for the project ref typed out, which is a good check and answers
 * only half of it: somebody typing a ref correctly can still be pointed at
 * the wrong bucket, or linked to a project the file does not name. What is
 * actually needed is to *see* every setting that decides where this acts, at
 * the moment of deciding, and then say yes to that rather than to a word.
 *
 * The two refusals above stay ahead of it — a local address, and a link
 * disagreeing with the file, are not choices to offer somebody at eleven at
 * night. This is for the ordinary case, where everything is right and worth
 * reading anyway.
 */
if (!verifyOnly) {
  const bucketNamed = process.env.R2_BUCKET;
  const r2Ready = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].every(
    (name) => process.env[name]
  );

  console.log(`
  Project       ${ref}
  URL           ${URL}
  From          ${whereFrom('PUBLIC_SUPABASE_URL')}
  CLI linked to ${linkedRef}
  File storage  ${
    r2Ready && bucketNamed ? bucketNamed : 'skipped — R2 credentials not set'
  }

  This drops every table and recreates it from the migration, removes every
  account${r2Ready && bucketNamed ? `, empties ${bucketNamed}` : ''}, and then seeds the organizations, the programs, and
  any advisor accounts in local-data/people.yaml.

  There is no undo and no backup.
`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('  Proceed? (y/n) ')).trim().toLowerCase();
  rl.close();

  if (answer !== 'y' && answer !== 'yes') {
    console.log('\n  Stopped. Nothing has been changed.\n');
    process.exit(1);
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
 * **The demonstration fixtures are here, and only for the demonstration
 * tenant.** They used to be left out because they refused a non-loopback
 * target outright. That refusal is now narrower — `seed-demo` writes into a
 * project that is not loopback when every organization it was pointed at
 * carries `demo: true` — and until this software runs somewhere other than
 * here, the cloud project *is* where demonstrations are given from. A fixture
 * cast that exists only on one laptop is a cast nobody can show.
 *
 * `DEMO_ORGS` is set here rather than left to the script's default, which
 * names the real schools because that is the right answer locally. The two
 * environments seed different sets on purpose and the difference is exactly
 * one thing: on a laptop every school gets a cast, in the cloud only the
 * school that holds nothing real. `seed-demo` refuses the rest anyway; naming
 * them here would produce a refusal in the middle of a reset that had already
 * dropped the database.
 *
 * **The order is `npm run reset`'s order and must stay that way.** Fixtures
 * run *before* the programs, which looks backwards and is not: an officer's
 * role is scoped to a program, and `seed-programs` is the only thing that
 * knows which officer runs which — so it grants those roles to accounts
 * `seed-demo` has already created. Reversed, every account still appears and
 * every scoped officer role is silently missing, which is a demonstration
 * where the club has no officers and nothing errored.
 */
const SEEDS = [
  ['Organizations', ['scripts/seed-orgs.mjs'], {}],
  [
    'Demonstration fixtures',
    ['scripts/seed-demo.mjs', `--allow-remote=${ref}`],
    { DEMO_ORGS: 'demo' },
  ],
  ['Programs', ['--experimental-strip-types', 'scripts/seed-programs.mjs'], {}],
  ['People', ['scripts/seed-people.mjs', '--optional'], {}],
];

for (const [what, argv, extraEnv] of SEEDS) {
  console.log(`\n${what}\n`);

  const code = await new Promise((resolve) => {
    const child = spawn('node', argv, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });

  if (code !== 0) fail(`${what} failed. Nothing after it has run.`);
}

console.log(`\n${ref} is rebuilt and seeded.\n`);

/**
 * THE ONE SETTING THIS SCRIPT CANNOT WRITE.
 *
 * Supabase matches the address it is asked to return to against an allow list
 * in the dashboard, and it does not accept a wildcard subdomain reliably — so
 * every tenant is a line somebody types, and a tenant added later is a line
 * somebody forgets. The failure is quiet in the way that costs an evening:
 * every other school still signs in, so it reads as one school being broken
 * rather than as a setting that was never added.
 *
 * It cannot be seeded from here — it is project configuration rather than
 * schema, and `db reset` does not touch it, which is also why an existing
 * tenant keeps working across a rebuild.
 *
 * So it is printed instead, derived from the same org files everything else
 * reads, at the moment somebody is about to go and test sign-in. The list is
 * complete rather than a diff: comparing it against the dashboard takes ten
 * seconds and does not depend on knowing which tenant is new.
 *
 * The trailing slash is `src/pages/auth/signin.ts`'s, which builds
 * `/auth/callback/` and is the string Supabase is actually asked to match.
 */
const callbacks = [
  `${apexOrigin()}/auth/callback/`,
  ...Object.values(loadOrgs())
    /* The platform is the apex, already listed above. `example` has no
       database row by declaration, so nobody can sign in to it and a line
       for it is a line to wonder about later. */
    .filter((org) => !org.isPlatform && org.provisioned)
    .map((org) => `${originFor(org.subdomain ?? org.id)}/auth/callback/`),
];

console.log(`  Sign-in returns to these, and Supabase has to be told so:
  Authentication -> URL Configuration -> Redirect URLs

${callbacks.map((url) => `    ${url}`).join('\n')}

  Already there for every tenant that worked before this run. A new one is a
  new line, and without it Google sign-in fails for that school alone.
`);
