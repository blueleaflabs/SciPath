/**
 * The fixtures exercise what the templates can express.
 *
 * A demo where every project declares nothing is a demo where the conditional
 * paperwork never appears, and the whole apparatus for working out which
 * forms a project needs goes untested by the thing people actually look at.
 *
 * Run: npm run test:fixtures
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { loadLibrary } from '../scripts/template-library.mjs';
import { resolveProgram, evaluate } from '../src/lib/template-resolve.ts';
import * as templateResolve from '../src/lib/template-resolve.ts';
import { migrationSql } from './migrations.mjs';
import { FIXTURE_DOMAIN } from '../src/config/demo-accounts.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

const seed = fs.readFileSync('scripts/seed-scenarios.mjs', 'utf8');
const library = loadLibrary();

/* The scenario definitions, read out of the script rather than duplicated. */
const scenarios = [...seed.matchAll(/key: '([\w-]+)',([\s\S]*?)(?=\n  \{|\n\s*\];)/g)].map(
  ([, key, body]) => {
    const facts = body.match(/facts: \{([^}]*)\}/)?.[1] ?? '';
    const authors = body.match(/authors: \[([^\]]*)\]/)?.[1] ?? '';

    /* **Three fields added, and the reason is worth recording.**

       This parsed `key`, `program` and `facts` and nothing else. A test
       written later asserted on `s.officer` — a field the parser never
       produced — so every scenario read as having no officer and the
       assertion was measuring `undefined` across the board. It failed
       loudly only because it used a strict count; `>= 1` would have passed
       forever while checking nothing.

       A parser that silently yields `undefined` for a field somebody will
       reasonably reach for is a trap, so the fields the advisor screen turns
       on are extracted rather than left to be discovered one at a time. */
    return {
      key,
      program: body.match(/program: '(\w+)'/)?.[1] ?? 'competition',
      facts: Object.fromEntries(
        [...facts.matchAll(/(\w+):\s*true/g)].map((m) => [m[1], true])
      ),
      officer: body.match(/officer: '([\w.]+)'/)?.[1] ?? null,
      authors: authors.split(',').map((a) => a.trim()).filter(Boolean),
      complete: Number(body.match(/complete: (\d+)/)?.[1] ?? 0),
      overdue: Number(body.match(/overdue: (\d+)/)?.[1] ?? 0),
    };
  }
);

test('every scenario declares its facts', () => {
  const silent = scenarios.filter((s) => !/facts/.test(seed.slice(seed.indexOf(`key: '${s.key}'`), seed.indexOf(`key: '${s.key}'`) + 600)));
  assert.deepEqual(silent.map((s) => s.key), [], 'a project that declares nothing gets no conditional forms');
});

test('the fixtures between them trigger every conditional ISEF form', () => {
  /* If no fixture involves vertebrates, Form 5A is never seen by anybody
     looking at the demo, and a bug in it survives indefinitely. */
  const isef = library.deliverables.get('deliverables-isef');
  const conditional = isef.deliverables.filter((d) => d.requirement === 'conditional');

  const untriggered = conditional.filter(
    (form) => !scenarios.some((s) => evaluate(form.applies_when, s.facts))
  );

  assert.deepEqual(
    untriggered.map((f) => f.id),
    ['continuation_7'],
    'every conditional form should be reachable from some fixture'
  );
});

test('at least one fixture is the human participants case', () => {
  /* SCVSEFA refuses a human participants project received after the November
     date outright. It is the hardest edge in the calendar and the demo should
     contain one. */
  const humans = scenarios.filter((s) => s.facts.humans);
  assert.ok(humans.length >= 1, 'no fixture involves human participants');
});

test('at least one fixture declares nothing at all', () => {
  /* Most projects are like this, and a demo where every project is regulated
     misrepresents what the paperwork usually looks like. */
  const plain = scenarios.filter((s) => Object.keys(s.facts).length === 0);
  assert.ok(plain.length >= 1);
});

test('the course has projects in it', () => {
  /* A program with nothing in it is visible and untestable, and the course is
     the second instance the whole template model was built for. */
  const inCourse = scenarios.filter((s) => s.program === 'course');
  assert.ok(inCourse.length >= 2, `only ${inCourse.length} projects in the course`);
});

test('a course project declares nothing a course cannot ask', () => {
  /* IRPD's template declares two facts. A fixture claiming vertebrates in a
     design research course would be describing paperwork that program has no
     way to require. */
  const irpd = library.programs.get('irpd-mvhs-2027');
  const asks = new Set((irpd.facts ?? []).map((f) => f.id));

  for (const scene of scenarios.filter((s) => s.program === 'course')) {
    for (const fact of Object.keys(scene.facts)) {
      assert.ok(asks.has(fact), `${scene.key} declares "${fact}", which the course never asks`);
    }
  }
});

test('the course shows an advisor more than one kind of trouble', () => {
  /* **A queue where everything is on fire is a queue nobody opens twice.**

     The course had two projects, which is enough to prove a course fits the
     template model and not enough to test the screen an advisor actually
     uses. `src/lib/attention.ts` sorts a program into disqualifying, needs
     attention, and in order — and with two rows there is nothing to sort.

     So the fixtures have to span the verdicts rather than merely be numerous.
     Asserted on the shapes that produce them, because `assess()` reads live
     rows and this file reads the seed:

       - one that began work before its approval, which is disqualifying
       - one with nobody attached, which needs attention for a reason no
         competition produces
       - one overdue
       - one with two authors, so the roster has something to act on
       - one that is simply fine

     The last is the one worth defending. Without a project in order, every
     row on the screen is a problem, and an advisor learns that the screen is
     noise. */
  const course = scenarios.filter((s) => s.program === 'course');

  assert.ok(course.length >= 8, `the course has ${course.length} projects, expected at least 8`);

  const unattended = course.filter((s) => !s.officer);
  assert.equal(unattended.length, 1, 'exactly one course project should have no officer');

  assert.ok(
    course.some((s) => s.overdue > 0),
    'no course project is overdue, so the overdue count is untestable'
  );

  assert.ok(
    course.some((s) => s.authors.length > 1),
    'no course project has co-authors, so the roster has nothing to act on'
  );

  /* In order: attached, nothing overdue, and well past the start. */
  assert.ok(
    course.some(
      (s) => s.officer && s.overdue === 0 && s.complete >= 6
    ),
    'no course project is in good order, so every row on the advisor screen is a problem'
  );
});

test('the fair fixtures reach a program that exists', () => {
  const competition = resolveProgram('mvhs-scvsefa-2027', library);
  assert.equal(competition.kind, 'competition');

  const course = resolveProgram('irpd-mvhs-2027', library);
  assert.equal(course.kind, 'course');
});

test('a course carries none of the competition machinery', () => {
  const course = library.programs.get('irpd-mvhs-2027');
  for (const flag of ['entries', 'categories', 'awards', 'advancement']) {
    assert.equal(course.has[flag], false, flag);
  }
});

/* ── Names that say what they are ────────────────────────────────────────── */

/* The map moved. It was in `seed-demo`, and `seed-cases` had a second copy
   of it that had already drifted a school behind — so it now lives once, in
   the module all three inventing scripts read. This test follows it there
   rather than keeping a third copy of where to look. */
const demo = fs.readFileSync('scripts/fixture-target.mjs', 'utf8');

const prefixes = Object.fromEntries(
  [...demo.matchAll(/^  (\w+): '(\w+)',$/gm)].map(([, slug, prefix]) => [slug, prefix])
);

test('every tenant has a name prefix', () => {
  /* A fixture is named for what it is — `mv_officer1` — rather than for an
     invented person. Reading a screen then costs nothing: the tenant, the
     role and which one are all in the name, where before it meant holding a
     cast list of fourteen in your head.
  
     **Counted against the schools, not against itself.** This used to assert
     that the map had at least three entries in it, and said in its own
     comment that a school added without a prefix would fail here — which it
     would not have: three was already true, and a fourth school with no
     prefix left it true. The failure came at seed time instead, as a name
     that read `undefined_student1`.
  
     The organizations are the list. Anything provisioned needs a prefix,
     because anything provisioned can hold people. */
  const dir = 'src/config/orgs';
  const provisioned = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => yaml.load(fs.readFileSync(`${dir}/${f}`, 'utf8')))
    .filter((doc) => doc.provisioned !== false);

  const missing = provisioned.filter((doc) => !prefixes[doc.slug]).map((doc) => doc.slug);

  assert.deepEqual(missing, [], 'add one in scripts/fixture-target.mjs');
});

test('no two tenants share a prefix', () => {
  /* This is what used to be "no name appears at two schools", and it is a
     stronger version of it: with a prefix per tenant, no name *can* appear
     at two schools, and a `lyn_` on a Monta Vista page is wrong on sight
     rather than requiring somebody to know whose roster it came from. */
  const used = Object.values(prefixes);
  assert.equal(new Set(used).size, used.length, `prefixes collide: ${used.join(', ')}`);
});

test('nothing invents a person', () => {
  /* An invented name that looks like a real one is the thing 12.11 asks the
     fixtures not to carry in front of a teacher, and the shape it takes
     here is an initial and a surname. */
  const looksLikeAPerson = /'[A-Z]\. [A-Z][a-z]+'/g;

  const offenders = [];
  for (const file of ['scripts/seed-demo.mjs', 'scripts/seed-scenarios.mjs']) {
    const text = fs
      .readFileSync(file, 'utf8')
      /* Comments explain the change by quoting the names it removed. */
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\*.*$/gm, '');

    for (const m of text.matchAll(looksLikeAPerson)) {
      offenders.push(`${file}: ${m[0]}`);
    }
  }

  assert.deepEqual(offenders, [], 'name it for what it is, like mv_student1');
});

test('no scenario names its sponsor', () => {
  /* Sponsors are teachers named in a scenario rather than accounts, so they
     never appear in the roster and are easy to forget. They used to be
     written out — `mv_sponsor1`, at an address on a real school's mail
     domain — and this test checked the prefix was *a* known tenant's rather
     than the one being seeded, so it passed happily while the demonstration
     tenant showed six projects supervised by `mv_sponsor1@fuhsd.org`.
  
     A name that cannot be wrong is better than a test that says it is not.
     A scenario states a number; the prefix and the domain come from the
     school this run is seeding, the same way every other fixture name does. */
  const named = [...seed.matchAll(/sponsor: \{ name:/g)];
  assert.deepEqual(named, [], 'a sponsor is a number, resolved against the tenant');

  const numbered = [...seed.matchAll(/sponsor: \{ n: (\d)/g)].map((m) => Number(m[1]));
  assert.ok(numbered.length > 0, 'no sponsors found, so this checks nothing');

  /* Within the letters `sponsorName` can index. A seventh sponsor would
     otherwise resolve to `undefined` and reach the page as `dm_sponsorNaN`. */
  assert.deepEqual(
    numbered.filter((n) => n < 1 || n > 8),
    [],
    'sponsors run from 1 to 8'
  );

  /* And nothing anywhere in the seeds carries a deliverable mail domain. A
     fixture address that could reach a real inbox is the thing 12.11 asks
     these not to have. */
  /* Comments explain the change by quoting the address it removed, the way
     the roster test above already has to. A test that cannot tell prose from
     code deletes the prose that explains it. */
  const code = seed.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '');

  /* Both spellings allowed: the current fixture domain, read from the module
     that owns it, and `.invalid`, which is where fixtures used to live and
     which nothing can register. Naming only one meant this passed for the
     wrong reason after the move — the literal addresses had gone from the
     seed entirely, so it was checking a file with nothing left in it to
     check. */
  const real = [
    ...code.matchAll(/@([a-z0-9.-]+\.(?:org|com|net|edu|gov|invalid))/g),
  ].filter((m) => m[1] !== FIXTURE_DOMAIN && !m[1].endsWith('.invalid'));

  assert.deepEqual(
    [...new Set(real.map((m) => m[1]))],
    [],
    `fixtures live on ${FIXTURE_DOMAIN}`
  );
});

/* ── Every program asks for something ────────────────────────────────────── */

test('every program has deliverables attached', () => {
  /* A program whose steps ask for nothing is a calendar, and the point of a
     template is to say what is actually owed. */
  const { resolveProgram: resolve, deliverablesFor: forStep, stepApplies: applies } =
    templateResolve;

  for (const id of ['mvhs-scvsefa-2027', 'irpd-mvhs-2027']) {
    const program = resolve(id, library);
    const all = program.steps.flatMap((s) => forStep(program, s, {}));
    assert.ok(all.length >= 8, `${id} asks for only ${all.length} deliverables`);
  }
});

test('every deliverable says whether it is required', () => {
  const { resolveProgram: resolve, deliverablesFor: forStep } = templateResolve;

  for (const id of ['mvhs-scvsefa-2027', 'irpd-mvhs-2027']) {
    const program = resolve(id, library);
    for (const step of program.steps) {
      for (const d of forStep(program, step, { humans: true, vertebrates: true })) {
        assert.ok(
          ['required', 'optional', 'conditional'].includes(d.requirement),
          `${id}/${d.id} has requirement "${d.requirement}"`
        );
      }
    }
  }
});

test('the write-up is optional everywhere, and carries the shape its program reads in', () => {
  /* Optional at every fair here and required by none of them, which is why
     most students never write one.

     IRPD's was written as required, from a guess made before the class
     published anything. Its roadmap and its calendar ask for a prototype, a
     journey map, a presentation, a researcher profile and a showcase, and
     for no paper at all — the class is design work, and the write-up exists
     here only as the road to the journal, which is a separate thing a
     student may choose. The shape stays `design-research`, because the one
     somebody does write is not a scientific paper. */
  const { resolveProgram: resolve } = templateResolve;

  const fair = resolve('mvhs-scvsefa-2027', library).deliverables.get('manuscript');
  assert.equal(fair.requirement, 'optional');
  assert.equal(fair.shape, 'imrad');

  const course = resolve('irpd-mvhs-2027', library).deliverables.get('manuscript');
  assert.equal(course.requirement, 'optional');
  assert.equal(course.shape, 'design-research');
});

test('the abstract is required, with its shape', () => {
  const { resolveProgram: resolve } = templateResolve;
  for (const id of ['mvhs-scvsefa-2027', 'irpd-mvhs-2027']) {
    const abstract = resolve(id, library).deliverables.get('abstract');
    assert.equal(abstract.requirement, 'required', id);
    assert.equal(abstract.shape, 'abstract', id);
  }
});

test('a quad chart is not claimed to be required by a fair that does not ask', () => {
  /* It is in the library because other fairs want one. Marking it mandatory
     here would make the template say something false about SCVSEFA, which is
     the one thing these files must never do. */
  const { resolveProgram: resolve } = templateResolve;
  const quad = resolve('mvhs-scvsefa-2027', library).deliverables.get('quad_chart');
  assert.equal(quad.requirement, 'conditional');
  assert.ok(quad.applies_when, 'and it says what would make it apply');
});

/* ── Officers belong to programs ─────────────────────────────────────────── */

test('officers are granted per program, not school-wide', () => {
  /* An officer's role is held in a program (6.4), so the fair's officers and
     the class's elders are different lists. Granting school-wide would make
     every dropdown offer everybody and the separation would exist only in
     the brief. */
  const programs = fs.readFileSync('scripts/seed-programs.mjs', 'utf8');
  const demo = fs.readFileSync('scripts/seed-demo.mjs', 'utf8');

  /* Matched on the grant being scoped to *a* program rather than on one
     spelling of the variable: a shared fair is seeded once and staffed by
     each school that enters it, so the grant moved into a helper taking the
     program id as an argument. The rule is that `scope_id` is set, not what
     the identifier beside it is called. */
  assert.match(programs, /scope_id: programId\b|scope_id: program\.id/,
    'the program seed should scope the grant to a program');
  assert.doesNotMatch(programs, /scope_id: null/, 'a school-wide officer is not a thing');
  assert.match(demo, /roles\.filter\(\(r\) => r !== 'officer'\)/, 'the demo seed should not grant it');
});

test('some officers run one program and some run two', () => {
  /* Two in one program only, so a dropdown populating from the wrong place
     is visible rather than merely possible. */
  const programs = fs.readFileSync('scripts/seed-programs.mjs', 'utf8');
  const block = programs.slice(programs.indexOf('const STAFF'), programs.indexOf('const SEASONS'));

  const lists = [...block.matchAll(/'([\w-]+)': \{ officer: \[([^\]]*)\]/g)].map(([, id, body]) => ({
    id,
    who: [...body.matchAll(/'([\w.]+)'/g)].map((m) => m[1]),
  }));

  const fair = lists.find((l) => l.id === 'mvhs-scvsefa-2027')?.who ?? [];
  const course = lists.find((l) => l.id === 'irpd-mvhs-2027')?.who ?? [];

  const both = fair.filter((h) => course.includes(h));
  const fairOnly = fair.filter((h) => !course.includes(h));
  const courseOnly = course.filter((h) => !fair.includes(h));

  assert.ok(both.length >= 2, `only ${both.length} run both`);
  assert.ok(fairOnly.length >= 1, 'nobody runs only the fair');
  assert.ok(courseOnly.length >= 1, 'nobody runs only the class');
});

test('the dropdowns populate from the project\u2019s own programs', () => {
  for (const file of ['src/pages/app/project/[id]/team.astro', 'src/pages/app/assign.astro']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /scope_id/, `${file} ignores which program an officer runs`);
  }
});

/* ── A grant is a program ────────────────────────────────────────────────── */

test('the grant resolves like anything else', () => {
  const { resolveProgram: resolve } = templateResolve;
  const grant = resolve('grant-mvhs-micro-2027', library);

  assert.equal(grant.kind, 'grant');
  assert.ok(grant.steps.length >= 8, `only ${grant.steps.length} steps`);
  assert.ok(grant.limits.amount_max > 0, 'a grant with no ceiling is not a grant');
});

test('it says what it will not pay for', () => {
  /* Most refusals are for something a student could have known was
     excluded, and travel and entry fees are the two that catch people. */
  const file = library.programs.get('grant-mvhs-micro-2027');
  assert.ok(file.limits.does_not_pay_for?.length >= 3);
});

test('it does not end at the decision', () => {
  /* A fair ends at judging. A grant has a report months later, and a school
     that misses it is a school that does not get the next one. */
  const { resolveProgram: resolve } = templateResolve;
  const grant = resolve('grant-mvhs-micro-2027', library);

  const after = grant.steps.filter((s) => s.phase === 'after');
  assert.ok(after.length >= 2, 'nothing happens after the money arrives');
  assert.ok(
    after.every((s) => s.applies_when === 'awarded'),
    'the post-award steps should apply only when it was awarded'
  );
});

test('the sample is marked as invented', () => {
  /* Every date and amount in it is made up. A template that reads like a
     transcription of a real funder, and is not, is the one thing these
     files must never be. */
  const raw = fs.readFileSync('src/config/programs/grant-mvhs-micro-2027.yaml', 'utf8');
  assert.match(raw, /\[FIXTURE\]/);
  assert.match(raw, /not a real program/i);
});

test('two fixtures apply for it, one of them awarded less than asked', () => {
  const applications = scenarios.filter((s) => s.program === 'grant');
  assert.ok(applications.length >= 2, `only ${applications.length} applications`);

  const seedText = fs.readFileSync('scripts/seed-scenarios.mjs', 'utf8');
  assert.match(seedText, /awarded: 250/, 'a partial award is the ordinary outcome');
});

/* ── The schema accepts what the templates say ───────────────────────────── */

const migration = migrationSql();

test('every kind a template declares is a kind the schema allows', () => {
  /* `kind: grant` resolved, validated, and was refused by a check constraint
     at seed time. The templates and the column had drifted and nothing
     compared them, because the tests read the templates and the tests read
     the schema and neither read both. */
  const allowed = new Set(
    (migration.match(/check \(kind in\s*\n?\s*\(([^)]*)\)/)?.[1] ?? '')
      .split(',')
      .map((k) => k.trim().replace(/'/g, ''))
      .filter(Boolean)
  );

  assert.ok(allowed.size >= 4, `only parsed ${allowed.size} kinds from the migration`);

  const declared = [...library.programs.values()]
    .map((p) => p.kind)
    .filter((k) => k && k !== 'process');

  const rejected = [...new Set(declared)].filter((k) => !allowed.has(k));
  assert.deepEqual(rejected, [], 'the schema would refuse these at seed time');
});

test('two schools can run the same template', () => {
  /* Two schools run SCVSEFA, and the slug comes from the template.
     Uniqueness on (slug, season) alone made the second school to seed fail
     on a duplicate key. */
  assert.match(
    migration,
    /unique \(org_id, slug, season_year\)/,
    'programs must be unique within an organization, not across all of them'
  );
});

test('every joining value a template declares is one the schema allows', () => {
  const allowed = new Set(
    (migration.match(/check \(joining in \(([^)]*)\)/)?.[1] ?? '')
      .split(',')
      .map((k) => k.trim().replace(/'/g, ''))
      .filter(Boolean)
  );

  const declared = [...library.programs.values()]
    .map((p) => p.joining)
    .filter(Boolean);

  const rejected = [...new Set(declared)].filter((k) => !allowed.has(k));
  assert.deepEqual(rejected, []);
});

test('the officer grant looks people up where their accounts are', () => {
  /* It queried `identities`, which holds Google sign-ins and is empty for
     every fixture. The lookup found nobody, granted nothing, and reported
     nothing — so every officer dropdown came up empty, and the approval
     queue was invisible to the people who run it.
   
     The demo seed creates fixtures through `auth.admin`, so that is where
     their addresses are. */
  const programs = fs.readFileSync('scripts/seed-programs.mjs', 'utf8');
  const demo = fs.readFileSync('scripts/seed-demo.mjs', 'utf8');

  assert.doesNotMatch(programs, /from\('identities'\)/, 'identities is empty for fixtures');
  assert.match(programs, /auth\.admin\.listUsers/, 'look them up in the auth directory');

  /* And confirm the premise: nothing writes an identity row. */
  assert.doesNotMatch(demo, /from\('identities'\)\s*\.insert/, 'if this changes, so can the lookup');
});

test('a failed officer grant is reported', () => {
  /* It skipped silently on a missing account. A seed that quietly grants
     nothing looks exactly like a seed that worked. */
  const programs = fs.readFileSync('scripts/seed-programs.mjs', 'utf8');
  assert.match(programs, /no account for \$\{handle\}/);
});

test('a program can have its own advisor', () => {
  /* A school with two teachers gives each a role scoped to their program,
     and neither sees the other's queue. A school with one leaves the role
     unscoped, which is what `advisor` is. */
  const programs = fs.readFileSync('scripts/seed-programs.mjs', 'utf8');
  const block = programs.slice(programs.indexOf('const STAFF'), programs.indexOf('const SEASONS'));

  assert.match(block, /advisor: \[/, 'no program has its own advisor to test with');

  const demo = fs.readFileSync('scripts/seed-demo.mjs', 'utf8');
  assert.match(demo, /handle: 'advisor\.b'/, 'there is only one teacher in the cast');
  assert.match(demo, /handle: 'advisor',\s+role: 'advisor'/, 'the school-wide one should stay unscoped');
});


/* ── The fourteen cases ──────────────────────────────────────────────────── */

const cases = fs.readFileSync('scripts/seed-cases.mjs', 'utf8');

test('the cases still cover what the model was walked against', () => {
  /* Brief 22.14 is a list of shapes students actually took, and two of them
     broke the model as first drafted. A seed that quietly stopped producing
     one of those shapes would leave the model untested in exactly the place
     it was hardest to get right.
   
     Asserted by the property each case exists to exercise, not by counting:
     a count goes stale the moment somebody adds a fifteenth. */
  const required = [
    ['a co-author at another school', /with: \{ school: 'svslc'/],
    ['a club member with no entry', /entries: \[\],/],
    ['advancement as a second entry', /second: true/],
    ['one project in two cohorts', /cohorts: \['irpd', 'club'\]/],
    ['a project in no cohort', /cohorts: \[\],/],
    ['a membership with no project', /^const JOINERS/m],
  ];

  const missing = required.filter(([, pattern]) => !pattern.test(cases)).map(([what]) => what);

  assert.deepEqual(missing, [], 'the seed no longer produces these');
});

test('the cases add rather than replace', () => {
  /* The thirteen scenarios have been tested against for months. Replacing
     them to make room for these would trade tests known to work for tests
     that are new, so this runs after and adds. */
  assert.ok(fs.existsSync('scripts/seed-scenarios.mjs'), 'the original scenarios are gone');

  const chain = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts.reset;
  assert.ok(
    chain.indexOf('seed-scenarios') < chain.indexOf('seed-cases'),
    'the cases have to run after the scenarios they build on'
  );
});

test('a case that claims a cohort gives its author a membership', () => {
  /* A project belongs to a cohort somebody is in, and `set_project_cohort`
     refuses otherwise. A seed writing `project_cohorts` without the matching
     membership would produce data the interface could not have made. */
  assert.match(cases, /from\('memberships'\)\.upsert/);
  assert.match(cases, /from\('participations'\)\.upsert/);

  const membershipAt = cases.indexOf("from('memberships').upsert", cases.indexOf('for (const key of c.cohorts)'));
  const cohortAt = cases.indexOf("from('participations').upsert", cases.indexOf('for (const key of c.cohorts)'));

  assert.ok(membershipAt > 0 && membershipAt < cohortAt, 'the membership has to come first');
});

test('one scene writes one participation row', () => {
  /* `participations` is unique on `(project_id, program_id)`, and a scene has
     one program. Before the merge, attaching a project to a cohort and
     entering it were two tables, so a course scene wrote to both; afterwards
     that is the same row twice and the reset dies on
     `participations_project_id_program_id_key` -- which is exactly how it
     died, after every local test passed.

     Counted rather than reasoned about, because the two writes sat two
     hundred lines apart in different branches and neither looked wrong on
     its own. */
  const writes = [...seed.matchAll(/from\('participations'\)\s*\.\s*(insert|upsert)/g)];

  /* Two, and they must be for *different* programs: the cohort the entry
     went through, and the entry itself. What this is guarding against is two
     writes naming the same `program_id`, which is one row written twice and
     is how the reset died. */
  assert.equal(
    writes.length,
    2,
    `seed-scenarios writes participations ${writes.length} times per scene; ` +
      'expected two, the via-cohort and the entry'
  );

  assert.ok(
    seed.includes('program_id: viaCohort.id'),
    'the first participation write is the cohort the entry goes through'
  );
  assert.ok(
    seed.includes('program_id: scenePrograms.id'),
    "the second is the scene's own program"
  );

  /* Upserts rather than inserts, since a scene may be re-run over a database
     that already has it. */
  assert.ok(
    writes.every((w) => w[1] === 'upsert'),
    'every participation write has to tolerate a re-run'
  );
});

test('a seeded sponsor names a participation, not a project', () => {
  /* The sponsor moved off the project (bug 1). A seed still writing
     `project_id` would insert nothing and every scene would look sponsorless
     in a way no page could explain. */
  const sponsorAt = seed.indexOf("from('project_sponsors').insert");
  assert.ok(sponsorAt > 0, 'the scenarios still have to seed a sponsor');

  const block = seed.slice(sponsorAt, sponsorAt + 400);
  assert.match(block, /participation_id:/);
  assert.doesNotMatch(block, /^\s*project_id:/m);

  /* And after the participation exists, or there is no id to name. */
  const participationAt = seed.search(/from\('participations'\)\s*\.\s*upsert/);
  assert.ok(
    participationAt > 0 && participationAt < sponsorAt,
    'the participation has to be written before the sponsor that hangs off it'
  );
});

test('an advancement entry names a different program from the first', () => {
  /* `second: true` sat in the case data and nothing read it, so both of case
     10's entries resolved to the same program: one row written twice, which
     the unique key on `(project_id, program_id)` refuses. It survived that
     long only because the school had no fair to enter at all. */
  assert.match(cases, /second:\s*true/, 'case 10 still declares an advancement');
  assert.ok(
    cases.includes('e.second ?'),
    'seed-cases has to read `second` and resolve a different program for it'
  );
});

test('the state fair says its dates are invented', () => {
  /* CSEF has not published a 2027 calendar. The dates in the template are
     guesses, and a guess that stops saying so becomes a fact the next person
     plans a season around. One anchor is derived from the regional and is
     allowed to be; the rest have to stay marked.

     Checked here rather than trusted to review, because the marker is a
     comment and comments are what get tidied. */
  const csef = fs.readFileSync('src/config/programs/csef-2027.yaml', 'utf8');

  assert.match(csef, /\[FIXTURE\]/, 'the file has to say the dates are invented');
  assert.match(
    csef,
    /signup: 2027-03-18/,
    'signup is two weeks after the regional judges, and moves with it'
  );

  /* Every anchor except `signup` is invented, and the block that holds them
     has to carry the marker. */
  const anchors = csef.slice(csef.indexOf('anchors:'), csef.indexOf('unscheduled:'));
  assert.match(anchors, /\[FIXTURE\]/, 'the anchor block has to be marked');
});

test('a project can hold a sponsor per place, and the pages say so', () => {
  /* Three teachers, three roles: the one who runs the class, the one who
     approves entry to the club, and the one a student asks to sponsor their
     own work at the fair. They are not interchangeable and a project has all
     three at once.

     The failure this guards against is not the model but the reporting: a
     page that reads one sponsor and renders "None named" tells a student to
     go and ask somebody they have already asked. */
  const team = fs.readFileSync('src/pages/app/project/[id]/team.astro', 'utf8');
  const page = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');

  /* The team page lists every place, not one. */
  assert.match(team, /sponsorRows/, 'the team page has to show a row per place');
  assert.doesNotMatch(
    team,
    /\.limit\(1\)\s*\n\s*\.maybeSingle\(\)/,
    'reading one sponsor for a project is what hid the other two'
  );

  /* The participation page reads its own, and names the others. */
  assert.match(page, /\.eq\('participation_id', id\)/, 'its own sponsor');
  /* Matched on the query rather than on a variable name: renaming
     `elsewhere` to `elsewhereX` left a substring that still matched, so the
     check passed with the feature removed. `neq` on the participation is the
     part that actually means "the other places". */
  assert.match(
    page,
    /\.neq\('participation_id', id\)/,
    'and whoever sponsors this project in its other places'
  );
});

test('the assign queue counts a class as a place', () => {
  /* An advisor accepts a student into IRPD, the student adds their project
     to it, and the advisor goes to assign an Elder. If "in a program" means
     "has an entry", there is no row and the school appears to be looking
     after nothing.

     That definition was right while a class and a fair were different
     tables. It is 22.5's cost in the one page that decides what a school is
     responsible for. */
  const assign = fs.readFileSync('src/pages/app/assign.astro', 'utf8');

  assert.match(
    assign,
    /for \(const c of cohortRows \?\? \[\]\) participating\.add\(c\.project_id\)/,
    'a cohort participation has to count as a place'
  );

  /* And the officer list has to include the cohort's, since an Elder is a
     role in the class and nowhere else. */
  assert.match(
    assign,
    /for \(const e of \[\.\.\.\(entries \?\? \[\]\), \.\.\.\(cohortRows \?\? \[\]\)\]\)/,
    'the people offered have to come from the cohort too'
  );
});

/* ── Where a template came from ──────────────────────────────────────────── */

test('every program template records who read what, and when', () => {
  /* A template is somebody's reading of a rulebook on a particular day, and
     a rulebook changes annually. Without this a file written for last
     season looks exactly like one checked this morning, and the only way to
     tell is to go and read the fair's site yourself.
  
     Process files are exempt: a research process is not read off anybody's
     rulebook, and demanding a source for one produces a filled-in field that
     means nothing. */
  const dir = 'src/config/programs';
  const missing = [];

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const doc = yaml.load(fs.readFileSync(`${dir}/${file}`, 'utf8'));
    if (!doc || doc.kind === 'process' || doc.role === 'none') continue;
    if (!doc.name) continue;

    const p = doc.provenance;
    if (!p?.owner || !p?.source_url || !p?.verified_on) missing.push(file);
  }

  assert.deepEqual(missing, [], 'add a provenance block naming an owner, a source and a date');
});

test('a named owner is a person', () => {
  /* "The club" cannot be asked what it read, and a template whose owner is a
     committee is a template nobody checks. */
  const dir = 'src/config/programs';

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const doc = yaml.load(fs.readFileSync(`${dir}/${file}`, 'utf8'));
    const owner = doc?.provenance?.owner;
    if (!owner) continue;

    assert.match(owner, /\s/, `${file} names "${owner}", which is not a person`);
  }
});

test('the stale warning goes to somebody who can act on it', () => {
  /* A student reading "these dates may be out of date" the night before a
     deadline has nowhere to go with it. The program's advisor can read the
     source again and change the file. */
  const page = fs.readFileSync('src/pages/app/program/[id].astro', 'utf8');

  assert.match(page, /stale && advisesThis/, 'the warning is gated on advising this program');
  assert.match(page, /me\.runsTheClub && \(me\.scopes \?\? \[\]\)\.includes\(program\.id\)/,
    'and scoped, so an advisor of the class is warned about the class');
  assert.match(page, /STALE_AFTER_DAYS = 365/, 'one year from the day it was last verified');
});

console.log(`${passed} fixture assertions passed. ${scenarios.length} scenarios read.`);
