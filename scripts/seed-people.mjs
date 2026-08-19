/**
 * THE FIRST ADVISOR, THE TEACHERS, AND ONE ACCOUNT TO DEMONSTRATE WITH.
 *
 * Three things `seed-orgs.mjs` cannot do, because they are about people rather
 * than about the shape of a school.
 *
 * **Reservations.** `/app/roles/` grants roles and requires an advisor to
 * reach, so the first advisor at a school has nobody to grant it. This writes
 * `role_reservations` rows directly: an address, a role, and a trigger that
 * fires when that address first signs in. Nothing is mailed and no password is
 * shared. After the first one claims, every later teacher should be added
 * through the interface instead, because that records who invited them.
 *
 * **A demo account.** One address and password, so the product can be shown
 * without borrowing a real person's sign-in.
 *
 * **Where the addresses live.** `local-data/people.yaml`, which is gitignored
 * and exists for this — its rule in `.gitignore` already reads "any working
 * file with real names in it". Not `src/config/`, where everything else is
 * committed and read by the build: a single invisible file among visible ones
 * is a trap for the next reader.
 *
 * The discriminator is two questions that happen to agree. Does the build read
 * it? `orgs/` and `programs/` are globbed at build and cannot be ignored
 * without breaking CI. Is it a real private person? These are a student's
 * address and teachers' names against accounts they have not agreed to.
 * Nothing else in this project answers yes to the second.
 *
 * 12.11a keeps real advisors out of fixtures; this is that rule one step up.
 * The mechanism is version controlled and the people are not, which is the
 * arrangement `.dev.vars` already has.
 *
 * Safe to run repeatedly. A claimed reservation is left alone rather than
 * re-offered, and an existing demo account is updated rather than duplicated.
 *
 * Run:
 *   PUBLIC_SUPABASE_URL=... SUPABASE_SECRET_KEY=... node scripts/seed-people.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
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
  fail('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed. See .dev.vars.example.');
}

const FILE = 'local-data/people.yaml';

/**
 * `--optional` is how `npm run reset` calls this.
 *
 * The file is gitignored and therefore absent on a fresh clone, in CI, and on
 * anybody's machine but the one that wrote it. In the reset chain that has to
 * be a skip: a seed that halts the whole rebuild because an optional file is
 * missing makes the repository unusable to everyone except its author.
 *
 * Called directly it still fails, because then somebody asked for this
 * specifically and a silent success would be a lie. Same fault, two answers,
 * and the flag is which question was being asked.
 */
const optional = process.argv.includes('--optional');

if (!fs.existsSync(FILE)) {
  if (optional) {
    console.log(`\nNo ${FILE}, so no advisor accounts. This is fine.`);
    console.log(`Copy src/config/people.example.yaml to it to seed them.\n`);
    process.exit(0);
  }

  fail(
    `${FILE} does not exist.\n\n` +
      `Copy src/config/people.example.yaml to it and fill in the addresses.\n\n` +
      `local-data/ is gitignored and exists for exactly this: a working file\n` +
      `with real names in it. This repository is public.`
  );
}

const doc = yaml.load(fs.readFileSync(FILE, 'utf8')) ?? {};

/**
 * The file is checked before anything is opened.
 *
 * A misspelled role or a demo address on the wrong domain is a fault in the
 * file, and saying so should not require a reachable database — otherwise the
 * first thing somebody sees after a typo is a connection error, which sends
 * them to look in entirely the wrong place.
 */
for (const row of doc.reservations ?? []) {
  const what = `reservations entry for ${row.email ?? '(no email)'}`;

  if (!row.email || !row.role) fail(`A ${what} needs an email and a role.`);
  if (!row.org) fail(`${what} needs an org.`);

  if (!['advisor', 'officer', 'editor'].includes(row.role)) {
    fail(`${what}: role is "${row.role}", and must be advisor, officer or editor.`);
  }

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(row.email).trim())) {
    fail(`${what}: "${row.email}" is not an address.`);
  }
}

/**
 * A record that says something untrue about a person is worse than no record.
 *
 * Every account used to inherit a teacher's shape — `staff`, `18_plus`,
 * `not_required` — which is true of a teacher and three lies about a student.
 * The last is the one that matters: `not_required` is precisely the state
 * meaning nobody has to ask a parent, and consent state is what gates
 * publication. A seeded student would have published without a guardian ever
 * being asked, which is the single thing this product is built not to do.
 *
 * So a student has to say what it is, and the combinations that cannot be
 * true are refused here rather than written.
 */
const AGE_BANDS = ['13_17', '18_plus'];
const CONSENT = ['pending', 'active', 'paused', 'closed', 'not_required'];

for (const row of doc.accounts ?? []) {
  const what = `accounts entry for ${row.email ?? '(no email)'}`;

  if (!row.email) fail(`An ${what} needs an email.`);
  if (!row.org) fail(`${what} needs an org.`);
  if (!row.password || row.password === 'change-this') {
    fail(`${what} needs a password of its own in ${FILE}.`);
  }

  for (const grant of row.roles ?? []) {
    if (!['student', 'officer', 'advisor', 'editor'].includes(grant.role)) {
      fail(`${what}: role is "${grant.role}", and must be student, officer, advisor or editor.`);
    }
  }

  const population = row.population ?? 'staff';

  if (!['student', 'staff'].includes(population)) {
    fail(`${what}: population is "${population}", and must be student or staff.`);
  }

  if (row.age_band && !AGE_BANDS.includes(row.age_band)) {
    fail(
      `${what}: age_band is "${row.age_band}", and must be 13_17 or 18_plus.\n` +
        `There is no account below 13, so under_13 cannot be seeded.`
    );
  }

  if (row.consent_state && !CONSENT.includes(row.consent_state)) {
    fail(`${what}: consent_state must be one of ${CONSENT.join(', ')}.`);
  }

  if (row.grad_year && (row.grad_year < 2000 || row.grad_year > 2100)) {
    fail(`${what}: grad_year is outside the range the schema allows.`);
  }

  if (population === 'student') {
    if (!row.age_band) {
      fail(
        `${what}: a student must state an age_band.\n\n` +
          `Defaulting it would write 18_plus onto a high schooler, and the\n` +
          `consent that follows from it is what gates publication.`
      );
    }

    if (!row.consent_state) {
      fail(`${what}: a student must state a consent_state. See ${FILE} for what each means.`);
    }

    if (row.age_band === '13_17' && row.consent_state === 'not_required') {
      fail(
        `${what}: a minor's guardian consent is not optional.\n\n` +
          `\`not_required\` means nobody has to ask a parent, which is true of an\n` +
          `adult and false of a thirteen year old. Use pending, active, paused\n` +
          `or closed.`
      );
    }
  }
}

const db = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: orgs, error: orgError } = await db
  .from('organizations')
  .select('id, slug, lockup_name');

if (orgError) fail(`Could not read the organizations: ${orgError.message}`);

const orgBySlug = new Map((orgs ?? []).map((o) => [o.slug, o]));

if (orgBySlug.size === 0) {
  fail('No organizations. Run scripts/seed-orgs.mjs first.');
}

function orgFor(slug, what) {
  const org = orgBySlug.get(slug);
  if (!org) {
    fail(
      `${what} names org "${slug}", which is not in the database.\n` +
        `Known: ${[...orgBySlug.keys()].join(', ')}`
    );
  }
  return org;
}

/* ------------------------------------------------------------------ */
/* Reservations                                                        */
/* ------------------------------------------------------------------ */

const reservations = doc.reservations ?? [];

if (reservations.length > 0) console.log('\nReservations');

for (const row of reservations) {
  const what = `reservations entry for ${row.email}`;
  const org = orgFor(row.org, what);
  const email = String(row.email).trim().toLowerCase();

  /* Read before writing, so the output can say whether somebody has arrived.
     The unique index is on (org, lower(email), role), so a second run would
     collide rather than duplicate — but a collision message tells the reader
     nothing about whether the invitation was taken up, which is the one thing
     worth knowing here. */
  const { data: already, error: readError } = await db
    .from('role_reservations')
    .select('id, claimed_at')
    .eq('org_id', org.id)
    .eq('role', row.role)
    .ilike('email', email)
    .maybeSingle();

  if (readError) fail(`${what}: ${readError.message}`);

  if (already?.claimed_at) {
    console.log(`  ${email.padEnd(38)} ${row.role} · claimed, left alone`);
    continue;
  }

  if (already) {
    console.log(`  ${email.padEnd(38)} ${row.role} · waiting to be claimed`);
    continue;
  }

  const { error: writeError } = await db.from('role_reservations').insert({
    org_id: org.id,
    email,
    display_name: row.name ?? null,
    role: row.role,
  });

  if (writeError) fail(`${what}: ${writeError.message}`);

  console.log(`  ${email.padEnd(38)} ${row.role} · reserved`);
}

/* ------------------------------------------------------------------ */
/* The demo account                                                    */
/* ------------------------------------------------------------------ */

const accounts = doc.accounts ?? [];

/* Programs, so a role can name the one it is held in. Read once. */
const { data: programRows, error: programError } = await db
  .from('programs')
  .select('id, template_id, org_id, name');

if (programError) fail(`Could not read the programs: ${programError.message}`);

/**
 * A template id to the program row for this school.
 *
 * A shared program has a null `org_id` and one row serves every school, so a
 * school's own row is preferred and the shared one is the fallback. Same
 * resolution `seed-programs.mjs` uses.
 */
function programFor(templateId, orgId, what) {
  const own = (programRows ?? []).find(
    (r) => r.template_id === templateId && r.org_id === orgId
  );
  const shared = (programRows ?? []).find(
    (r) => r.template_id === templateId && r.org_id === null
  );
  const row = own ?? shared;

  if (!row) {
    fail(
      `${what} scopes a role to "${templateId}", which is not a seeded program.\n` +
        `Run scripts/seed-programs.mjs first. Known: ` +
        `${[...new Set((programRows ?? []).map((r) => r.template_id))].join(', ')}`
    );
  }

  return row;
}

if (accounts.length > 0) console.log('\nAccounts');

for (const person of accounts) {
  const email = String(person.email).trim().toLowerCase();
  const org = orgFor(person.org, `accounts entry for ${email}`);

  /**
   * Created through the admin API, then written into `users` directly.
   *
   * That bypasses the login classifier, which is the point: a school's signup
   * is restricted to its own domains and these addresses are deliberately on
   * none of them.
   *
   * `demo: true` in the metadata is the marker `wipe-demo.mjs` reads.
   * **Not the domain.** These sit on the organization's own domain so they
   * read properly during a demonstration, and that is exactly the namespace a
   * real member of staff will one day have — using it as the "safe to delete"
   * flag would make the cleanup tool destroy real accounts. An explicit flag
   * says what a namespace cannot.
   */
  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password: person.password,
    email_confirm: true,
    user_metadata: { full_name: person.name ?? email, fixture: true, demo: true },
  });

  let id = created?.user?.id;

  if (createError) {
    if (!/already/i.test(createError.message)) fail(`${email}: ${createError.message}`);

    const { data: list, error: listError } = await db.auth.admin.listUsers({ perPage: 200 });
    if (listError) fail(`Could not read the accounts: ${listError.message}`);

    id = list?.users.find((u) => u.email === email)?.id;
    if (!id) fail(`${email} exists but could not be read back.`);

    /* The file is the source of truth for the password, so a changed file
       changes the account rather than silently disagreeing with it. The
       marker is re-stamped for an account made before it existed. */
    const { error: updateError } = await db.auth.admin.updateUserById(id, {
      password: person.password,
      user_metadata: { full_name: person.name ?? email, fixture: true, demo: true },
    });
    if (updateError) fail(`${email}: ${updateError.message}`);
  }

  const { error: rowError } = await db.from('users').upsert(
    {
      id,
      org_id: org.id,
      display_name: person.name ?? email,
      population: person.population ?? 'staff',
      status: 'active',
      affiliation_state: 'domain_verified',
      affiliation_verified_at: new Date().toISOString(),
      /* Stated for a student and defaulted for a teacher, which is the one
         case where the adult shape is the true one. */
      consent_state: person.consent_state ?? 'not_required',
      consent_requested_at:
        person.consent_state === 'pending' ? new Date().toISOString() : null,
      age_band: person.age_band ?? '18_plus',
      age_attested_at: new Date().toISOString(),
      grad_year: person.grad_year ?? null,
    },
    { onConflict: 'id' }
  );

  if (rowError) fail(`${email}: ${rowError.message}`);

  console.log(`  ${email}`);

  for (const grant of person.roles ?? []) {
    /**
     * `scope_id` names the program a role is held in; null is the school.
     *
     * Two teachers each responsible for their own program is what this column
     * exists for, and until now nothing had ever set it. A scoped advisor
     * sees their own program's projects and not the other's, which is the
     * whole reason to scope rather than a nicety.
     */
    const scoped = grant.program
      ? programFor(grant.program, org.id, `accounts entry for ${email}`)
      : null;

    /* Not an upsert: uniqueness comes from two partial indexes and ON
       CONFLICT cannot infer a target from those. */
    let query = db
      .from('user_roles')
      .select('id')
      .eq('user_id', id)
      .eq('role', grant.role)
      .is('revoked_at', null);

    query = scoped ? query.eq('scope_id', scoped.id) : query.is('scope_id', null);

    const { data: held, error: heldError } = await query.maybeSingle();
    if (heldError) fail(`${email}: ${heldError.message}`);

    const where = scoped ? scoped.name : 'the whole school';

    if (held) {
      console.log(`    ${grant.role.padEnd(8)} ${where} · already held`);
      continue;
    }

    const { error: grantError } = await db.from('user_roles').insert({
      org_id: org.id,
      user_id: id,
      role: grant.role,
      scope_id: scoped?.id ?? null,
    });

    if (grantError) fail(`${email}: ${grantError.message}`);

    console.log(`    ${grant.role.padEnd(8)} ${where} · granted`);
  }
}

console.log(
  `\n${reservations.length} reservation${reservations.length === 1 ? '' : 's'} and ` +
    `${accounts.length} account${accounts.length === 1 ? '' : 's'} read from ${FILE}, ` +
    `which is not in git.\n`
);
