#!/usr/bin/env node
/**
 * WHICH SCHOOL IS EACH ACCOUNT IN.
 *
 * The question the middleware asks on every request, asked directly.
 *
 * An account belongs to exactly one school — `users.id` is the primary key
 * and references `auth.users`, so one credential means one row means one
 * `org_id` — and signing in at another school's address sends somebody home.
 * When that redirect is a surprise, this is the file that says whether the
 * software was right.
 *
 * **It reads rather than writes.** Nothing here changes anything, so it is
 * safe against the cloud project at any time, which is the point: the moment
 * you want this answer is usually a moment when you do not want to be
 * running a script that might do something.
 *
 * Local by default, because that is where most questions are asked and
 * because pointing at production by accident is the wrong default. `--cloud`
 * reads `.cloud.vars` instead.
 *
 *   npm run who
 *   npm run who -- --cloud
 *   npm run who -- --cloud irpd_student1
 *
 * A trailing word filters on email or name, for when the roster is long and
 * the question is about one person.
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';

const cloud = process.argv.includes('--cloud');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? null;

/* `.cloud.vars` overrides, `.dev.vars` fills gaps. The two files name
   different databases on purpose and `loadDevVars` only writes a variable
   that is unset, so loading the cloud one first is what keeps a local URL
   out of a cloud run. */
if (cloud) loadCloudVars();
loadDevVars();

const URL_ = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

if (!URL_ || !KEY) {
  console.error(
    `\n  No database named${cloud ? ' in .cloud.vars' : ' in .dev.vars'}.\n` +
      '  PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are both needed.\n'
  );
  process.exit(1);
}

/* The service key, which bypasses row level security. Deliberate: the whole
   question is what is in every school, and a policy-scoped read would answer
   only for whichever school the key happened to belong to. */
const db = createClient(URL_, KEY, { auth: { persistSession: false } });

console.log(`\n  ${cloud ? 'Cloud' : 'Local'}  ${URL_}\n`);

const { data: orgs, error: orgError } = await db
  .from('organizations')
  /* `lockup_name`, not `name`. The first version asked for a column this
     table does not have, which PostgREST answers with an error and no rows —
     reading as an empty database rather than as a typo, on the one script
     whose entire job is to say who is in which school.
     `tests/schema-drift.mjs` caught it. */
  .select('id, slug, lockup_name')
  .order('slug');

if (orgError) {
  console.error(`  Could not read organizations: ${orgError.message}\n`);
  process.exit(1);
}

const { data: people, error: peopleError } = await db
  .from('users')
  .select('id, org_id, display_name, population, status, identities(email, is_primary, revoked_at)')
  .order('display_name');

if (peopleError) {
  console.error(`  Could not read accounts: ${peopleError.message}\n`);
  process.exit(1);
}

/* An account can have more than one identity and one of them is primary.
   Taking the first row would print whichever the database returned. */
const addressOf = (person) => {
  const live = (person.identities ?? []).filter((i) => !i.revoked_at);
  const primary = live.find((i) => i.is_primary) ?? live[0];
  return primary?.email ?? '(no address)';
};

const matches = (person) => {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return (
    addressOf(person).toLowerCase().includes(needle) ||
    String(person.display_name ?? '').toLowerCase().includes(needle)
  );
};

let shown = 0;

for (const org of orgs ?? []) {
  const roster = (people ?? []).filter((p) => p.org_id === org.id && matches(p));

  /* A school with nobody is worth printing when nothing is being filtered:
     three empty schools is the expected state after a reset, and seeing them
     empty is the confirmation. Under a filter it is noise. */
  if (roster.length === 0 && filter) continue;

  console.log(`  ${org.slug}  ${roster.length === 0 ? '(nobody)' : `${roster.length}`}`);

  for (const person of roster) {
    console.log(
      `      ${addressOf(person).padEnd(38)} ` +
        `${String(person.display_name ?? '').padEnd(22)} ` +
        `${String(person.population ?? '').padEnd(10)} ${person.status ?? ''}`
    );
    shown += 1;
  }

  console.log('');
}

if (filter && shown === 0) {
  console.log(`  Nothing matching "${filter}".\n`);
}
