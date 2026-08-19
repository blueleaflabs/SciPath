/**
 * REMOVE THE DEMO DATA.
 *
 * Fixtures are in production for now, deliberately, because a demo needs
 * something to show. This is how they leave.
 *
 * **What counts as demo data.** Every account whose email is on
 * `@demo.invalid`, and everything those accounts made: projects, notebook
 * entries, participations, sponsors, deliverables, records, notifications,
 * roles, memberships. Nothing else. Programs seeded from templates stay,
 * because they are the school's real calendar and not a fixture.
 *
 * **What it will not touch.** An account on a real domain, and anything that
 * account made. If a real student has joined a demo project, or a real
 * teacher has been recorded as its sponsor, that row is reported and left —
 * see `--force`. The whole point of a wipe is that it is the one operation
 * where being cautious costs a rerun and being clever costs somebody's work.
 *
 * Order matters. Most foreign keys here are `on delete restrict`, which is
 * the right default — it means nothing disappears quietly — and it means this
 * has to unwind by hand, children before parents.
 *
 *   node scripts/wipe-demo.mjs               # says what it would remove
 *   node scripts/wipe-demo.mjs --yes         # removes it
 *   node scripts/wipe-demo.mjs --yes --force # removes it even where a real
 *                                            # account shares a project
 */

import process from 'node:process';

import { createClient } from '@supabase/supabase-js';

import { loadDevVars } from './dev-vars.mjs';

loadDevVars();

const URL_ = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

if (!URL_ || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed.');
  process.exit(1);
}

const args = process.argv.slice(2);
const confirmed = args.includes('--yes');
const force = args.includes('--force');

const db = createClient(URL_, KEY, { auth: { persistSession: false } });

/* The one thing that identifies a fixture. `seed-demo` puts every account on
   this domain and nothing else does, which is why the domain is the test
   rather than a name pattern: a name can be typed by a person. */
const FIXTURE_DOMAIN = '@demo.invalid';

/**
 * The marker on a demo account, which is a flag and not a domain.
 *
 * `seed-people.mjs` writes presentable accounts on the organization's own
 * domain, because `demo.invalid` on screen during a demonstration reads as
 * broken. That domain is exactly the namespace a real member of staff will
 * one day have — so matching on it would make this tool destroy real
 * accounts, and matching on `demo.invalid` alone would leave accounts holding
 * advisor access that nothing can find.
 *
 * An explicit flag says what a namespace cannot. Set at creation and
 * re-stamped on every seed, so an account made before the flag existed
 * acquires it rather than becoming unreachable.
 */
const DEMO_FLAG = (account) => account?.user_metadata?.demo === true;

/* The addresses are in `auth.users`, not in `public.users` — the application
   table holds a display name and a population and deliberately no email, so
   the admin API is the only place that can answer "is this a fixture". A
   `users.email` query returns an error and no rows, which reads as "nothing
   found" rather than as a mistake, and `test:drift` catches exactly that. */
const fixtures = new Map();

for (let page = 1; page <= 20; page += 1) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });

  if (error) {
    console.error(`Could not list accounts: ${error.message}`);
    process.exit(1);
  }

  const batch = data?.users ?? [];
  for (const account of batch) {
    const address = (account.email ?? '').toLowerCase();
    if (address.endsWith(FIXTURE_DOMAIN) || DEMO_FLAG(account)) {
      fixtures.set(account.id, account.email);
    }
  }

  if (batch.length < 200) break;
}

const ids = [...fixtures.keys()];

if (ids.length === 0) {
  console.log('No demo accounts. Nothing to remove.');
  process.exit(0);
}

/* Projects a fixture is on, and whether anybody real is on them too. A real
   co-author is the case worth stopping for: deleting the project would delete
   their work, and they did not sign up to be a fixture. */
const { data: authored } = await db
  .from('project_authors')
  .select('project_id, user_id')
  .in('user_id', ids);

const projectIds = [...new Set((authored ?? []).map((a) => a.project_id))];

const { data: everyone } = projectIds.length
  ? await db
      .from('project_authors')
      .select('project_id, user_id, users(display_name)')
      .in('project_id', projectIds)
  : { data: [] };

const shared = new Map();

for (const row of everyone ?? []) {
  if (!fixtures.has(row.user_id)) {
    shared.set(row.project_id, row.users?.display_name ?? row.user_id);
  }
}

console.log(`${ids.length} demo accounts on ${FIXTURE_DOMAIN} or flagged demo`);
console.log(`${projectIds.length} projects they are on`);

if (shared.size > 0) {
  console.log(`\n${shared.size} of those also have a real person on them:`);
  for (const [, who] of shared) console.log(`  ${who}`);
  if (!force) {
    console.log('\nThose are left alone. Pass --force to remove them anyway.');
  }
}

const removable = force ? projectIds : projectIds.filter((id) => !shared.has(id));

if (!confirmed) {
  console.log('\nNothing removed. Pass --yes to do it.');
  process.exit(0);
}

/* Children before parents, because most of these are `on delete restrict`.
   Each step names the table it clears and the column it clears it by, so a
   failure says which relationship was not accounted for rather than only
   which constraint complained. */
const steps = [];

if (removable.length > 0) {
  const places = await db
    .from('participations')
    .select('id')
    .in('project_id', removable);

  const placeIds = (places.data ?? []).map((p) => p.id);

  const notes = await db.from('field_notes').select('id').in('project_id', removable);
  const noteIds = (notes.data ?? []).map((n) => n.id);

  if (noteIds.length) steps.push(['note_media', 'note_id', noteIds]);
  if (placeIds.length) {
    steps.push(['deliverables', 'participation_id', placeIds]);
    steps.push(['entry_milestones', 'participation_id', placeIds]);
    steps.push(['project_sponsors', 'participation_id', placeIds]);
    steps.push(['records', 'participation_id', placeIds]);
  }
  steps.push(['field_notes', 'project_id', removable]);
  steps.push(['project_links', 'project_id', removable]);
  steps.push(['participations', 'project_id', removable]);
  steps.push(['project_authors', 'project_id', removable]);
  steps.push(['projects', 'id', removable]);
}

steps.push(['notifications', 'recipient_id', ids]);
steps.push(['memberships', 'user_id', ids]);
steps.push(['user_roles', 'user_id', ids]);
steps.push(['guardian_consents', 'user_id', ids]);
steps.push(['users', 'id', ids]);

console.log('');

for (const [table, column, values] of steps) {
  if (!values?.length) continue;

  const { error } = await db.from(table).delete().in(column, values);

  if (error) {
    /* A table that does not exist in this schema is not a failure: this list
       outlives any one migration, and stopping the wipe half done is worse
       than skipping a table that was never there. */
    if (/does not exist|schema cache/i.test(error.message)) {
      console.log(`  ${table.padEnd(20)} skipped (${error.message})`);
      continue;
    }
    console.error(`\n${table}: ${error.message}`);
    console.error('Stopped. Nothing after this point was removed.');
    process.exit(1);
  }

  console.log(`  ${table.padEnd(20)} cleared by ${column}`);
}

/* The auth accounts last. A `users` row is gone by now; the auth account it
   pointed at is not, and an orphan auth account can still sign in. */
let signInsRemoved = 0;

for (const id of ids) {
  const { error } = await db.auth.admin.deleteUser(id);
  if (!error) signInsRemoved += 1;
}

console.log(`\n${signInsRemoved} of ${ids.length} sign-ins removed.`);
console.log(
  shared.size > 0 && !force
    ? `${shared.size} projects left, because a real person is on them.`
    : 'Demo data removed.'
);
