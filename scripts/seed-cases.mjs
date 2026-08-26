/**
 * THE FOURTEEN CASES THE MODEL WAS WALKED AGAINST.
 *
 * Brief 22.14, seeded. They are the shapes students actually took last year,
 * and two of them broke the model as first drafted: a partner from another
 * school defeated inferring a project's cohort from its authors, and a club
 * member who is never selected defeated resolving a cohort's anchors through
 * an entry.
 *
 * **A second pass rather than an edit.** `seed-scenarios.mjs` builds the
 * thirteen situations the workbench has been tested against for months, and
 * replacing them to make room for these would trade tests that are known to
 * work for tests that are new. This runs after it and adds.
 *
 * What it exercises that the older pass cannot:
 *
 *   - a membership with no project, which the old model could not express
 *   - a project in two cohorts, with two different words for its supervisor
 *   - a co-author from another school, in no cohort at all
 *   - a club member who works all year and is never selected
 *   - advancement as a second entry rather than a field
 *   - a project with no cohort, which is the solo case
 *
 * Run: npm run seed:cases
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars } from './dev-vars.mjs';
import { fixtureTarget, fixtureName } from './fixture-target.mjs';
import { loadOrgs } from './orgs-library.mjs';
import { originFor } from '../src/lib/deployment.ts';

loadDevVars();

const orgs = loadOrgs();

const URL_ = process.env.PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SECRET_KEY ?? '';

/**
 * WHICH SCHOOLS GET CASES.
 *
 * Both used to be written out as literal arguments to `seedSchool`, which was
 * fine while the only target was a laptop with every school on it. The demonstration tenant is a school in the
 * deployed project now, and it is the only one that may receive invented
 * people there, so the list has to be something a run can state.
 *
 * The first is the school the cases belong to. Any after it exist so that a
 * case needing somebody from *another* school has one; where they are absent,
 * those cases are skipped and say so.
 */
/* The demonstration tenant. See seed-demo.mjs: the fourteen cases are
   invented students and they belong where every other invented person is. */
const ORG_SLUGS = (process.env.DEMO_ORGS ?? 'demo')
  .split(',')
  .map((slug) => slug.trim())
  .filter(Boolean);

if (!URL_ || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed. They live in .dev.vars.');
  process.exit(1);
}

const allowRemote = process.argv
  .find((a) => a.startsWith('--allow-remote='))
  ?.split('=')[1];

const target = fixtureTarget({ url: URL_, slugs: ORG_SLUGS, allowRemote });

if (target.refuse) {
  console.error(`\n${target.refuse}\n`);
  process.exit(1);
}

if (target.note) console.log(target.note);

const db = createClient(URL_, KEY, { auth: { persistSession: false } });

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

async function must(builder, what) {
  const { data, error } = await builder;
  if (error) fail(`${what}: ${error.message}`);
  return data;
}

const days = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

/* ── Who and what ─────────────────────────────────────────────────────────
 *
 * Students 1 to 10 from 22.14, plus the person in all three cohorts, plus a
 * partner at another school and a solo student. Handles rather than names,
 * because `seed-demo` owns the names.
 */

const CASES = [
  // ── IRPD ────────────────────────────────────────────────────────────────
  {
    n: 1,
    who: 'student.i',
    what: 'Rethinking the school lunch queue',
    cohorts: ['irpd'],
    entries: [],
    note: 'The ordinary IRPD path: the class, its process, its own showcase milestone, and nothing entered anywhere.',
  },
  {
    n: 2,
    who: 'student.j',
    with: { school: 'svslc', handle: 'student.a' },
    what: 'Water reuse in a school greenhouse',
    cohorts: ['irpd'],
    entries: [{ program: 'fair', result: 'competed' }],
    note: 'A partner from another school, in no cohort. The case that forced participations.',
  },
  {
    n: 3,
    who: 'student.k',
    what: 'Shade mapping the walk to school',
    cohorts: ['irpd'],
    entries: [{ program: 'grant' }],
    note: 'A grant applied for alongside the class.',
  },
  {
    n: 4,
    who: 'student.l',
    what: 'A cheaper turbidity probe',
    cohorts: ['irpd'],
    entries: [{ program: 'fair' }],
    note: 'The class, and a competition the class does not run.',
  },

  // ── The club ────────────────────────────────────────────────────────────
  {
    n: 8,
    who: 'student.m',
    what: 'Mycelium as packing foam',
    cohorts: ['club'],
    entries: [],
    note: 'Worked all year, never selected. **A full calendar and no entry** (22.6).',
  },
  {
    n: 9,
    who: 'student.n',
    what: 'Nitrate in four catchments',
    cohorts: ['club'],
    entries: [{ program: 'fair', result: 'competed' }],
  },
  {
    n: 10,
    who: 'student.o',
    what: 'Acoustic detection of bearing wear',
    cohorts: ['club'],
    entries: [
      { program: 'fair', result: 'advanced' },
      /* Advancement is a second entry with its own judging, not a field on
         the first (22.8). `second` sends this to whatever the regional
         advances to, which is the state fair. */
      { program: 'fair', second: true, result: 'competed' },
    ],
    note: 'Advanced. Two entries, two records.',
  },

  // ── Across cohorts, and outside them ────────────────────────────────────
  {
    n: 11,
    who: 'student.p',
    what: 'OsmoFlux',
    cohorts: ['irpd', 'club'],
    entries: [{ program: 'fair', result: 'competed' }],
    note: 'One project, two cohorts, two words for its supervisor. 22.9.',
  },
  {
    n: 12,
    who: 'student.i',
    what: 'A pocket spectrophotometer',
    cohorts: [],
    entries: [{ program: 'fair' }],
    note: 'No cohort. Nobody is looking after it, and the page says so (22.10).',
  },
];

/* Memberships with no project at all, which the old model could not express
   because joining required inventing one. */
const JOINERS = [
  { who: 'student.j', cohort: 'club', note: 'In the club, nothing started.' },
  { who: 'student.k', cohort: 'club' },
];

async function seedSchool(slug) {
  const org = await must(
    db.from('organizations').select('id, slug, lockup_name').eq('slug', slug).maybeSingle(),
    `reading ${slug}`
  );

  if (!org) fail(`No organization "${slug}". Run npm run reset first.`);

  const { data: people } = await db
    .from('users')
    .select('id, display_name')
    .eq('org_id', org.id);

  /* Fixture handles map to names by position, the way seed-demo builds them:
     `mv_student1` is `student.a`. Reading the name is more robust than
     assuming an order. */
  const byName = new Map((people ?? []).map((u) => [u.display_name, u.id]));

  /* `fixtureName` is `seed-demo`'s own naming, imported rather than restated.
     This file carried a copy with three schools in it while `seed-demo` had
     four, so a case seeded against the fourth looked up `undefined_student9`
     and got nobody — no error, just a project with no author. */
  const handleTo = (handle) => byName.get(fixtureName(slug, handle));

  const { data: programs } = await db
    .from('programs')
    .select('id, name, kind, program_role, template_id')
    /* Shared programs have a null `org_id` and belong to every school that
       enters them, so an equality test hides the regional fair. */
    .or(`org_id.eq.${org.id},org_id.is.null`);

  const find = (test) => (programs ?? []).find(test);

  const named = {
    irpd: find((p) => p.template_id === 'irpd-mvhs-2027'),
    club: find((p) => p.program_role === 'cohort' && p.template_id?.includes('scvsefa')),
    /* Named by template rather than by shape. There are two competitions a
       project can be entered in now -- the regional and the state fair it
       advances to -- so "the first opportunity of kind competition" would
       pick whichever the query returned first and case 10's two entries
       could land on the same one. */
    fair: find((p) => p.template_id === 'scvsefa-2027'),
    csef: find((p) => p.template_id === 'csef-2027'),
    grant: find((p) => p.kind === 'grant'),
  };

  return { org, handleTo, named };
}

async function main() {
  /* The first is whose cases these are. The rest are only ever the other end
     of a cross-school case. */
  const [home, ...others] = ORG_SLUGS;

  const mv = await seedSchool(home);
  const elsewhere = new Map();

  for (const slug of others) elsewhere.set(slug, await seedSchool(slug));

  let skipped = 0;

  let projects = 0;
  let memberships = 0;
  let entries = 0;

  /* Memberships with no project. */
  for (const joiner of JOINERS) {
    const cohort = mv.named[joiner.cohort];
    if (!cohort) continue;

    await must(
      db.from('memberships').upsert(
        {
          org_id: mv.org.id,
          user_id: mv.handleTo(joiner.who),
          cohort_id: cohort.id,
          state: 'member',
        },
        { onConflict: 'user_id,cohort_id' }
      ),
      `putting ${joiner.who} in ${joiner.cohort}`
    );

    memberships += 1;
  }

  for (const c of CASES) {
    /* A case whose second author is at a school this run did not seed.
    
       Seeding it anyway would produce a project with one author and the
       words "two authors, one at each school" beside it in the summary — a
       case that describes something it is not, which is worse than an
       absent case because somebody would test against it and believe the
       result. Counted and named at the end rather than passed over in
       silence. */
    if (c.with && !elsewhere.has(c.with.school)) {
      console.log(`  case ${c.n} skipped: needs a fixture at ${c.with.school}`);
      skipped += 1;
      continue;
    }

    const author = mv.handleTo(c.who);
    if (!author) fail(`No fixture for ${c.who}`);

    /* The project first, because everything else hangs off it. */
    const project = await must(
      db
        .from('projects')
        .insert({
          org_id: mv.org.id,
          title: `${c.what} [case ${c.n}]`,
          started_on: days(-40),
          created_by: author,
          /* A cohort may prescribe the process; otherwise the default, which
             is what makes a solo project's calendar exist at all (22.4). */
          process_id: c.cohorts.includes('irpd') ? 'irpd-mvhs-2027' : 'process-science',
        })
        .select('id')
        .single(),
      `creating case ${c.n}`
    );

    projects += 1;

    await must(
      db.from('project_authors').insert({
        org_id: mv.org.id,
        project_id: project.id,
        user_id: author,
        role: 'author',
        accepted_at: new Date().toISOString(),
      }),
      `author of case ${c.n}`
    );

    /* A co-author from another school, who is in no cohort here and whose
       school this project does not belong to. */
    if (c.with) {
      const partner = elsewhere.get(c.with.school).handleTo(c.with.handle);

      if (partner) {
        await must(
          db.from('project_authors').insert({
            org_id: mv.org.id,
            project_id: project.id,
            user_id: partner,
            role: 'author',
            accepted_at: new Date().toISOString(),
          }),
          `partner on case ${c.n}`
        );
      }
    }

    for (const key of c.cohorts) {
      const cohort = mv.named[key];
      if (!cohort) continue;

      await must(
        db.from('memberships').upsert(
          { org_id: mv.org.id, user_id: author, cohort_id: cohort.id, state: 'member' },
          { onConflict: 'user_id,cohort_id' }
        ),
        `membership for case ${c.n}`
      );

      await must(
        db.from('participations').upsert(
          { org_id: mv.org.id, project_id: project.id, program_id: cohort.id, added_by: author },
          { onConflict: 'project_id,program_id' }
        ),
        `cohort of case ${c.n}`
      );

      memberships += 1;
    }

    for (const e of c.entries) {
      /**
       * **Advancement is a second entry, to the next opportunity. 22.14.**
       *
       * `second: true` was never read. Both of case 10's entries resolved to
       * the same program, which is one row twice and what
       * `participations_project_id_program_id_key` refused.
       *
       * The next opportunity is what `advances_to` names, and
       * `scvsefa-2027.yaml` names `csef`. **No CSEF template exists**, so
       * there is no program to enter and the case cannot be represented in
       * full. Writing one would mean inventing a real fair's dates and
       * deadlines, which is the one thing the templates are not allowed to
       * do.
       *
       * So it is skipped, out loud. The first entry still records
       * `advanced_to`, so the outcome is visible; what is missing is the
       * second entry's own calendar and its own record.
       */
      const program = e.second ? mv.named[e.advancesTo ?? 'csef'] : mv.named[e.program];

      if (!program) {
        if (e.second) {
          console.log(
            `  case ${c.n}: advancement not seeded, because no program for ` +
              "the fair SCVSEFA advances to exists yet. The placement and " +
              '"advanced to" are recorded on the first entry.'
          );
        }
        continue;
      }

      await must(
        db.from('participations').insert({
          org_id: mv.org.id,
          project_id: project.id,
          program_id: program.id,
          status: e.result ? 'competed' : 'entered',
          result_recorded_at: e.result ? new Date().toISOString() : null,
          placement: e.result === 'advanced' ? 'First Award' : null,
          advanced_to: e.result === 'advanced' ? 'California Science and Engineering Fair' : null,
        }),
        `entry of case ${c.n}`
      );

      entries += 1;
    }
  }

  console.log(
    `\n${projects} cases, ${memberships} memberships, ${entries} entries` +
      `${skipped ? `, ${skipped} skipped for want of a second school` : ''}.`
  );

  /* Printed at the end of every reset, because a seeded database nobody can
     navigate is a seeded database nobody uses. Each line is a thing to try
     and the thing it is meant to show. */
  /* The names and the addresses of whichever school this run seeded.
  
     This block was written out — `mv_student9`, `montavista.localhost:4321` —
     which was true of every run until there was more than one school to seed
     into, and then it told somebody to sign in as an account that does not
     exist, at a host that is not the one they are testing. The same fault
     `seed-scenarios` had, in the file next to it, fixed there and not here.
  
     `originFor` rather than a literal host, so a run against the deployed
     project names the deployed addresses. */
  const who = (kind, n) => fixtureName(home, `${kind}.${'abcdefghijklmnop'[n - 1]}`);
  const elseWho = (kind, n) =>
    others.length ? fixtureName(others[0], `${kind}.${'abcdefghijklmnop'[n - 1]}`) : '(not seeded)';

  const home_ = originFor(orgs[home]?.subdomain ?? home);
  const away_ = others.length ? originFor(orgs[others[0]]?.subdomain ?? others[0]) : '(not seeded)';

  console.log(`
════════════════════════════════════════════════════════════════════════
 WHAT TO TEST                             password for everybody: scipath
════════════════════════════════════════════════════════════════════════

 Every project below is titled "… [case N]". Sign in at
 ${home_}/app/ unless a case says otherwise.

────────────────────────────────────────────────────────────────────────
 CASE 1 · the ordinary class path
   sign in as   ${who('student', 9)}
   what it is   IRPD, following the class's own framework, presenting at
                the class showcase, entered in no competition at all.
   try this     Open the project. The deadlines are the class's seven
                milestones, not the scientific method's eleven — the
                calendar comes from the work, and IRPD teaches its own.

 CASE 2 · a partner from another school
   sign in as   ${who('student', 10)}, then ${elseWho('student', 10)} at ${away_}
   what it is   Two authors, one at each school. The project is Monta
                Vista's and belongs to IRPD; the partner is in no cohort
                here at all.
   try this     Both see the project. Only ${who('student', 10)} sees IRPD's
                deadlines on it. **This is the case that proved a
                project's cohort cannot be read off its authors.**

 CASE 3 · a grant alongside the class
   sign in as   ${who('student', 11)}
   what it is   An IRPD project that also applied for money.
   try this     The grant entry has its own deadlines and its outcome is
                an amount rather than a placement.

 CASE 4 · a competition the class does not run
   sign in as   ${who('student', 12)}
   what it is   IRPD, plus an entry at the fair.
   try this     Two calendars on one project: the class's milestones and
                the fair's forms, merged and in date order.

────────────────────────────────────────────────────────────────────────
 CASE 8 · worked all year, never selected
   sign in as   ${who('student', 13)}
   what it is   A club member with a project and **no entry anywhere**.
   try this     Open it and confirm the club's deadlines are all there.
                Resolving a cohort's dates through an entry would have
                left this student with an empty calendar in the year
                they most needed one.

 CASE 9 · the ordinary club path
   sign in as   ${who('student', 14)}
   what it is   Club member, project, entered at the fair, competed.

 CASE 10 · advanced
   sign in as   ${who('student', 15)}
   what it is   **Two entries for one piece of work**: the regional, with
                a placement and somewhere it advanced to, and the state
                fair it advanced to.
   try this     One project, two sets of deadlines, and it publishes as
                two records rather than one. The state fair's dates are
                invented -- see the header of csef-2027.yaml -- but the
                shape is the real one.

────────────────────────────────────────────────────────────────────────
 CASE 11 · one project, two cohorts
   sign in as   ${who('student', 16)}
   what it is   OsmoFlux, in **both IRPD and the research club**.
   try this     Open the project. "Where this belongs" lists both, and
                the supervisor is an **Elder** in one row and an
                **Officer** in the other. One person, two words, because
                the word belongs to the cohort rather than to the
                person.

 CASE 12 · nobody is looking after it
   sign in as   ${who('student', 9)}  (their second project)
   what it is   A project in no cohort, entered at the fair.
   try this     The hub says plainly that nobody at the school is
                looking after it. That absence used to be hidden behind
                a placeholder program.

────────────────────────────────────────────────────────────────────────
 MEMBERS WITH NO PROJECT
   sign in as   ${who('student', 10)} or ${who('student', 11)}
   what it is   In the club, nothing started.
   try this     The old model could not express this: joining required
                inventing a project to hang the membership on.

────────────────────────────────────────────────────────────────────────
 WHO DECIDES WHAT                          /app/assign/

   ${who('advisor', 1)}   every queue     unscoped, which a real school would not
                                 have
   ${who('advisor', 2)}   IRPD only       scoped to the class
   ${who('advisor', 3)}   the club only   scoped to the club

   try this      As a student, ask to join both IRPD and the club. Then
                 look at all three advisors: each should see only what
                 is theirs.

────────────────────────────────────────────────────────────────────────
 JOINING IS NOT ENTERING                   /app/

   A cohort offers Join and asks for nothing. An opportunity asks for a
   project, because it needs one. Joining creates no project — start one
   from the overview, and it appears there whether or not it has been
   entered anywhere.

 THE PUBLISHED ARCHIVE                     /showcase/

   One record is published and indexed on a fresh reset, so the archive
   and search are not empty.

 DIGEST                                    npm run digest

   Prints what would be sent and sends nothing. Add -- --send to hand it
   to the transport, which is the console unless configured otherwise.

════════════════════════════════════════════════════════════════════════
`);
}

main();
