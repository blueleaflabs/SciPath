/**
 * DEMO FIXTURES.
 *
 * The demonstration has to show the advisor's view, and an advisor cannot be
 * asked to sign in to an unfinished system so that the system can then be
 * shown to her. So the demo uses nobody's real account.
 *
 * A migration cannot create an account for someone who has never
 * authenticated, because users.id is auth.users.id. The admin API can, and
 * that is what this script is. It is deliberately not how the real advisors
 * are created: those are pending grants that fire at their first real login,
 * because a privileged role over minors' work should not depend on Supabase's
 * automatic email linking to attach a pre-made account to the right person.
 *
 * Three guards, because a file holding the secret key is the most dangerous
 * thing in this repository:
 *
 *   1. Refuses to run unless the Supabase URL is loopback, or an explicit
 *      non-production project ref is passed with --allow-remote=<ref>.
 *   2. Every address is on demo.invalid, reserved by RFC 2606, so it can
 *      never resolve and can never collide with a real person.
 *   3. No fixture domain is ever added to org_domains. Fixtures bypass the
 *      classifier; they do not weaken it.
 *
 * Usage:  node scripts/seed-demo.mjs
 */

import { createClient } from '@supabase/supabase-js';

const URL = process.env.PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SECRET_KEY ?? '';
/* Every tenant gets fixtures, so switching schools in the UI actually has
   something to show on the other side. */
const ORG_SLUGS = (process.env.DEMO_ORGS ?? 'montavista,lynbrook,blueleaflabs')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PRODUCTION_REF = 'mejibvorrfjiadnsvkyu';
const FIXTURE_DOMAIN = 'demo.invalid';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'scipath';

/* ── Guard 1 ─────────────────────────────────────────────────────────────── */

const allowRemote = process.argv
  .find((a) => a.startsWith('--allow-remote='))
  ?.split('=')[1];

const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL);

if (!URL || !KEY) {
  fail(
    'PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set.\n' +
      'They live in .dev.vars, which is a file and not an environment:\n' +
      '  set -a; source .dev.vars; set +a'
  );
}

/* Caught here rather than three queries later. With the publishable key,
   row level security hides every row, and an empty result is indis-
   tinguishable from missing data unless something says so. */
if (!KEY.startsWith('sb_secret_') && !KEY.startsWith('eyJ')) {
  fail(
    `SUPABASE_SECRET_KEY does not look like a secret key (starts "${KEY.slice(0, 15)}").\n` +
      'Fixtures need the key that bypasses row level security.'
  );
}

if (!isLoopback) {
  if (!allowRemote) {
    fail(
      `Refusing to seed fixtures into ${URL}.\n` +
        'Fixtures belong on the local stack. If a second project is genuinely\n' +
        'the target, pass --allow-remote=<project-ref> explicitly.'
    );
  }
  if (allowRemote === PRODUCTION_REF || URL.includes(PRODUCTION_REF)) {
    fail(
      'That is the production project. Fixtures never go there.\n' +
        'See brief 12.11a.'
    );
  }
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

/**
 * Fictional, including the advisors. An account carrying a teacher's real
 * name, which she did not create and cannot see inside of, is a worse thing
 * to put in front of her than an obviously invented one. 12.11.
 */
const YEAR = new Date().getFullYear();

/* Four roles now. The officer is a student, usually the club president, and
   holds real administrative authority; the advisor is the teacher. Editor is
   the fourth, restored in the review build, and it is deliberately not the
   same set of people as officer: running the queue and chasing deadlines are
   different jobs, and a club may hand them to different students. The
   advisor is always an editor because the advisor decides. */
const PEOPLE = [
  { handle: 'advisor',   name: 'S. Halvorsen', role: 'advisor', population: 'staff',   grad: null,     age: '18_plus' },
  { handle: 'officer.a', name: 'T. Marchetti', role: 'officer', population: 'student', grad: YEAR + 1, age: '13_17', alsoEditor: true },
  { handle: 'officer.b', name: 'R. Calloway',  role: 'officer', population: 'student', grad: YEAR + 1, age: '13_17' },
  { handle: 'officer.c', name: 'P. Osei',      role: 'officer', population: 'student', grad: YEAR + 1, age: '13_17' },
  { handle: 'student.a', name: 'B. Adeyemi',  role: 'student', population: 'student', grad: YEAR + 2, age: '13_17' },
  { handle: 'student.b', name: 'K. Solheim',  role: 'student', population: 'student', grad: YEAR + 2, age: '13_17' },
  { handle: 'student.c', name: 'M. Ferreira', role: 'student', population: 'student', grad: YEAR + 1, age: '13_17' },
  { handle: 'student.d', name: 'D. Ainsworth',role: 'student', population: 'student', grad: YEAR + 3, age: '13_17' },
  { handle: 'student.e', name: 'V. Rasmussen',role: 'student', population: 'student', grad: YEAR,     age: '18_plus' },
  { handle: 'student.f', name: 'N. Petrossian',role:'student', population: 'student', grad: YEAR,     age: '18_plus' },
  { handle: 'student.g', name: 'L. Nakamura', role: 'student', population: 'student', grad: YEAR + 2, age: '13_17' },
  { handle: 'student.h', name: 'C. Duarte',   role: 'student', population: 'student', grad: YEAR + 1, age: '13_17' },
];

const db = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function seedOrg(slug) {
  const { data: org, error: orgError } = await db
    .from('organizations')
    .select('id, slug, lockup_name, hostname, requires_mentor')
    .eq('slug', slug)
    .single();

  if (orgError) {
    /* Two failures look alike here and the message should tell them apart.
       "permission denied" is a missing GRANT; "column ... does not exist" is
       this script drifting from the migration, which is what happens when a
       column is renamed and only one of the two files hears about it. */
    const hint = /permission denied/i.test(orgError.message)
      ? 'The migration did not grant table privileges to service_role. Row\n' +
        'level security and table grants are two separate layers, and both\n' +
        'are required.'
      : /does not exist/i.test(orgError.message)
        ? 'This script and the migration disagree about the schema. Check\n' +
          'that the column it names still exists in 0001.'
        : 'Unexpected. The raw error is above.';

    fail(`Could not read organization "${slug}": ${orgError.message}\n\n${hint}`);
  }

  if (!org) {
    fail(
      `No organization with slug "${slug}".\n` +
        'Confirm the migration actually contains its provisioning call:\n' +
        '  grep -c provision_org supabase/migrations/0001_identity_and_tenancy.sql\n' +
        '  (4 is correct: one definition plus three calls)'
    );
  }

  console.log(`\n${org.lockup_name}  ->  http://${org.hostname}:4321/app/`);

  for (const person of PEOPLE) {
    /* Namespaced per tenant, so the same fixture cast exists at every school
       and an account can never be reused across two of them. */
    const email = `${slug}.${person.handle}@${FIXTURE_DOMAIN}`;

    /* Guard 2, asserted rather than assumed. */
    if (!email.endsWith(`@${FIXTURE_DOMAIN}`)) {
      fail(`Fixture address ${email} is not on ${FIXTURE_DOMAIN}.`);
    }

    const { data: created, error: createError } = await db.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: person.name, fixture: true },
    });

    let id = created?.user?.id;

    if (createError) {
      if (!/already/i.test(createError.message)) {
        fail(`${email}: ${createError.message}`);
      }
      const { data: list } = await db.auth.admin.listUsers({ perPage: 200 });
      id = list?.users.find((u) => u.email === email)?.id;
      if (!id) fail(`${email} exists but could not be read back.`);
    }

    /* Written directly, bypassing the login classifier. That bypass is the
       entire point of a fixture and is why the guards above exist. */
    const { error: rowError } = await db.from('users').upsert(
      {
        id,
        org_id: org.id,
        display_name: person.name,
        grad_year: person.grad,
        population: person.population,
        status: 'active',
        affiliation_state: 'domain_verified',
        affiliation_verified_at: new Date().toISOString(),
        consent_state: person.age === '18_plus' ? 'not_required' : 'active',
        age_band: person.age,
        age_attested_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
    if (rowError) fail(`${email}: ${rowError.message}`);

    /* An officer is a student who also runs the club, so they hold both.
       Only the advisor, who is a teacher, holds one. */
    const roles =
      person.role === 'officer' ? ['student', 'officer'] : [person.role];

    /* One officer also runs the queue, so there is somebody to sign in as
       who is an editor and not the advisor. Testing the whole flow as the
       advisor would hide every place the two are wrongly conflated. */
    if (person.alsoEditor) roles.push('editor');

    for (const role of roles) {
      /* Not an upsert. The uniqueness on user_roles comes from two partial
         indexes, and ON CONFLICT cannot infer a target from those. */
      const { data: held } = await db
        .from('user_roles')
        .select('id')
        .eq('user_id', id)
        .eq('role', role)
        .is('revoked_at', null)
        .maybeSingle();

      if (!held) {
        const { error: roleError } = await db
          .from('user_roles')
          .insert({ org_id: org.id, user_id: id, role });
        if (roleError) fail(`${email}: ${roleError.message}`);
      }
    }

    console.log(`  ${person.role.padEnd(8)} ${person.name.padEnd(14)} ${email}`);
  }
}

async function main() {
  for (const slug of ORG_SLUGS) await seedOrg(slug);

  console.log(
    `\n${PEOPLE.length * ORG_SLUGS.length} fixtures across ${ORG_SLUGS.length} tenants.` +
      `\nPassword for all of them: ${PASSWORD}` +
      '\nSign in with email and password. Google sign-in is for real accounts.' +
      '\n\nEvery name here is invented. No real advisor appears in any fixture.'
  );
}

main().catch((e) => fail(e.message));
