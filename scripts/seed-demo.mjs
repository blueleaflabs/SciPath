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
import { loadDevVars } from './dev-vars.mjs';
import { loadOrgs } from './orgs-library.mjs';
import { originFor } from '../src/lib/deployment.ts';

/* Read the file before reading the environment. A script that needs a file
   should read the file rather than print instructions for loading it. */
loadDevVars();

const URL = process.env.PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SECRET_KEY ?? '';
/* Every tenant gets fixtures, so switching schools in the UI actually has
   something to show on the other side. */
const ORG_SLUGS = (process.env.DEMO_ORGS ?? 'montavista,svslc,scipath,demo')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const PRODUCTION_REF = 'uctbxilvfzaoroffzgen';
const FIXTURE_DOMAIN = 'demo.invalid';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'scipath';

/* ── Guard 1 ─────────────────────────────────────────────────────────────── */

const allowRemote = process.argv
  .find((a) => a.startsWith('--allow-remote='))
  ?.split('=')[1];

const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL);

if (!URL || !KEY) {
  fail(
    'PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are missing.\n' +
      'They normally come from .dev.vars in the project root, which this\n' +
      'script reads on its own. If that file is absent, run:\n' +
      '  npx supabase start\n' +
      'and copy the URL and the secret key it prints into .dev.vars.'
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

/**
 * WHICH SCHOOLS MAY HOLD FIXTURES, WHICH IS A FACT ABOUT THE SCHOOL.
 *
 * `demo: true` in `src/config/orgs/*.yaml` marks an organization whose people
 * are invented and whose credentials are published. There is one, and it is
 * the tenant on demo.scipath.org.
 *
 * The flag lives on the school rather than in this file because this file is
 * the thing that would be wrong. A list of permitted slugs here is a list
 * somebody edits while pointed at production; a school that says of itself
 * that it holds nothing real is checked against whatever `DEMO_ORGS` happens
 * to say on the day.
 */
const demoOnly = new Set(
  Object.values(loadOrgs())
    .filter((org) => org.demo === true)
    .map((org) => org.id)
);

const notDemo = ORG_SLUGS.filter((slug) => !demoOnly.has(slug));

if (!isLoopback) {
  if (!allowRemote) {
    fail(
      `Refusing to seed fixtures into ${URL}.\n` +
        'Fixtures belong on the local stack. If a second project is genuinely\n' +
        'the target, pass --allow-remote=<project-ref> explicitly.'
    );
  }

  /**
   * The production project, and the one case where it is allowed.
   *
   * The demonstration tenant lives in the same project as the schools, because
   * a tenant is a file and not a deployment, and its rows are separated from
   * theirs by `org_id` and by the policies `npm run test:probes` proves. So
   * "fixtures never go to production" is too broad by exactly one school, and
   * the narrow rule is: to production, only into schools that hold nothing
   * real.
   *
   * Stated as a refusal of everything else rather than a permission, so a slug
   * added to `DEMO_ORGS` in a hurry is refused rather than admitted.
   */
  if (allowRemote === PRODUCTION_REF || URL.includes(PRODUCTION_REF)) {
    if (notDemo.length > 0) {
      fail(
        'That is the production project, and these are real schools:\n' +
          `  ${notDemo.join(', ')}\n\n` +
          'Only an organization whose file carries `demo: true` may be seeded\n' +
          'there. Set DEMO_ORGS to those, or point at the local stack.\n' +
          'See brief 12.11a.'
      );
    }

    console.log(
      `\nSeeding ${ORG_SLUGS.join(', ')} in the production project.\n` +
        'Every one of them is marked `demo: true` and holds nothing real.'
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
const ROLES = [
  /* Three teachers, so the scoping can actually be seen.
  
     `advisor` holds an unscoped role and sees every queue. `advisor.b`
     advises the class and `advisor.c` advises the club, and neither sees the
     other's, because a role scoped to a cohort means that cohort.
  
     The unscoped one exists to demonstrate the fallback and is **not what a
     real school looks like**: every advisor there advises something. It is
     kept because a school with one teacher should not have to scope a role
     they would never unscope. */
  { handle: 'advisor',   role: 'advisor', population: 'staff',   grad: null,     age: '18_plus' },
  { handle: 'advisor.b', role: null,      population: 'staff',   grad: null,     age: '18_plus' },
  { handle: 'advisor.c', role: null,      population: 'staff',   grad: null,     age: '18_plus' },
  { handle: 'officer.a', role: 'officer', population: 'student', grad: YEAR + 1, age: '13_17', alsoEditor: true },
  { handle: 'officer.b', role: 'officer', population: 'student', grad: YEAR + 1, age: '13_17' },
  { handle: 'officer.c', role: 'officer', population: 'student', grad: YEAR + 1, age: '13_17' },
  { handle: 'officer.d', role: 'officer', population: 'student', grad: YEAR + 1, age: '13_17' },
  { handle: 'student.a', role: 'student', population: 'student', grad: YEAR + 2, age: '13_17' },
  { handle: 'student.b', role: 'student', population: 'student', grad: YEAR + 2, age: '13_17' },
  { handle: 'student.c', role: 'student', population: 'student', grad: YEAR + 1, age: '13_17' },
  { handle: 'student.d', role: 'student', population: 'student', grad: YEAR + 3, age: '13_17' },
  { handle: 'student.e', role: 'student', population: 'student', grad: YEAR,     age: '18_plus' },
  { handle: 'student.f', role: 'student', population: 'student', grad: YEAR,     age: '18_plus' },
  { handle: 'student.g', role: 'student', population: 'student', grad: YEAR + 2, age: '13_17' },
  { handle: 'student.h', role: 'student', population: 'student', grad: YEAR + 1, age: '13_17' },

  /* ── A second block, for the cases ──────────────────────────────────────
   *
   * `seed-scenarios` and `seed-cases` both used `student.a` to `student.h`,
   * which was harmless while the scenarios entered the club: a class and a
   * fair are different programs, so one student could hold a project in
   * each.
   *
   * They now both enter the shared regional fair, and one student may not
   * enter one fair with two projects -- they would compete against
   * themselves for a place. Every case with a fair entry collided with the
   * scenario belonging to the same student.
   *
   * A wider pool rather than a relaxed rule: the rule is correct, and the
   * fixtures were quietly relying on two fairs existing where the model says
   * there is one.
   */
  { handle: 'student.i', role: 'student', population: 'student', grad: YEAR + 2, age: '13_17' },
  { handle: 'student.j', role: 'student', population: 'student', grad: YEAR + 1, age: '13_17' },
  { handle: 'student.k', role: 'student', population: 'student', grad: YEAR,     age: '18_plus' },
  { handle: 'student.l', role: 'student', population: 'student', grad: YEAR + 3, age: '13_17' },
  { handle: 'student.m', role: 'student', population: 'student', grad: YEAR + 2, age: '13_17' },
  { handle: 'student.n', role: 'student', population: 'student', grad: YEAR,     age: '18_plus' },
  { handle: 'student.o', role: 'student', population: 'student', grad: YEAR + 1, age: '13_17' },
  { handle: 'student.p', role: 'student', population: 'student', grad: YEAR + 2, age: '13_17' },
];

/**
 * Names are built from the handle, not chosen.
 *
 * They used to be invented people — S. Halvorsen, T. Marchetti — a different
 * fourteen at each school, so that a name on a page told you which tenant it
 * belonged to. That solved a leak-spotting problem and created a worse
 * testing one: reading a screen meant holding a cast list in your head and
 * remembering that T. Marchetti is the officer who is also an editor while
 * R. Calloway runs the class.
 *
 * So a fixture is now named for what it is. `mv_officer1` on a page tells
 * you the tenant, the role and which one, without looking anything up, and
 * the leak test is stronger than it ever was with invented names: a `svs_`
 * anywhere on a Monta Vista page is wrong on sight.
 *
 * Every name is still obviously fictional, which is what 12.11 asks for, and
 * more obviously so than a plausible invented person was.
 */
const PREFIX = {
  montavista: 'mv',
  svslc: 'svs',
  scipath: 'sp',
  demo: 'dm',
};

/* `advisor` is bare and the rest carry a letter. Both become a number, so
   the handles keep their shape and the names read in order. */
function numberOf(handle) {
  const [, suffix] = handle.split('.');
  if (!suffix) return 1;
  return suffix.charCodeAt(0) - 96;
}

/** The fourteen for one school, named from their handles. */
function castFor(slug) {
  const prefix = PREFIX[slug];
  if (!prefix) fail(`No prefix for "${slug}". Add one to PREFIX in this file.`);

  return ROLES.map((role) => {
    const kind = role.handle.split('.')[0];
    return { ...role, name: `${prefix}_${kind}${numberOf(role.handle)}` };
  });
}

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
    .select('id, slug, lockup_name, subdomain, requires_mentor')
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

  /* Where to sign in, in this environment. Fixtures never reach a deployed
     project (12.11a), so in practice this is always the local one. */
  console.log(`\n${org.lockup_name}  ->  ${originFor(org.subdomain)}/app/`);

  for (const person of castFor(slug)) {
    /* Namespaced per tenant. The handle is the same at every school and the
       person behind it is not, so an account can never be reused across two
       of them and a name on a page says which school it belongs to. */
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
      const { data: list, error: listError } = await db.auth.admin.listUsers({ perPage: 200 });

  if (listError) {
    fail(`Could not read the accounts: ${listError.message}`);
  }
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
      person.role === 'officer'
        ? ['student', 'officer']
        /* A null role is granted elsewhere: the second teacher advises one
           program, and programs do not exist when this runs. */
        : person.role
          ? [person.role]
          : [];

    /* One officer also runs the queue, so there is somebody to sign in as
       who is an editor and not the advisor. Testing the whole flow as the
       advisor would hide every place the two are wrongly conflated. */
    if (person.alsoEditor) roles.push('editor');

    /* An officer's role belongs to a program, and programs are created after
       this script runs. `seed-programs.mjs` grants those, which is also the
       only place that knows which officer runs which. */
    const here = roles.filter((r) => r !== 'officer');

    for (const role of here) {
      /* Not an upsert. The uniqueness on user_roles comes from two partial
         indexes, and ON CONFLICT cannot infer a target from those. */
      const { data: held, error: heldError } = await db
        .from('user_roles')
        .select('id')
        .eq('user_id', id)
        .eq('role', role)
        .is('revoked_at', null)
        .maybeSingle();

      /* Without this, a failed read looks like "no role held" and the grant
         is attempted again every reset. */
      if (heldError) fail(`Could not read the roles: ${heldError.message}`);

      if (!held) {
        const { error: roleError } = await db
          .from('user_roles')
          .insert({ org_id: org.id, user_id: id, role });
        if (roleError) fail(`${email}: ${roleError.message}`);
      }
    }

    console.log(`  ${(person.role ?? 'advisor').padEnd(8)} ${person.name.padEnd(14)} ${email}`);
  }
}

async function main() {
  for (const slug of ORG_SLUGS) await seedOrg(slug);

  console.log(
    `\n${ROLES.length * ORG_SLUGS.length} fixtures across ${ORG_SLUGS.length} tenants, no name shared.` +
      `\nPassword for all of them: ${PASSWORD}` +
      '\nSign in with email and password. Google sign-in is for real accounts.' +
      '\n\nEvery name here is invented. No real advisor appears in any fixture.'
  );
}

main().catch((e) => fail(e.message));
