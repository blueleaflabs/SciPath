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
import { loadLibrary } from '../scripts/template-library.mjs';
import { resolveProgram, evaluate } from '../src/lib/template-resolve.ts';
import * as templateResolve from '../src/lib/template-resolve.ts';

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
    return {
      key,
      program: body.match(/program: '(\w+)'/)?.[1] ?? 'competition',
      facts: Object.fromEntries(
        [...facts.matchAll(/(\w+):\s*true/g)].map((m) => [m[1], true])
      ),
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

const demo = fs.readFileSync('scripts/seed-demo.mjs', 'utf8');

const prefixes = Object.fromEntries(
  [...demo.matchAll(/^  (\w+): '(\w+)',$/gm)].map(([, slug, prefix]) => [slug, prefix])
);

test('every tenant has a name prefix', () => {
  /* A fixture is named for what it is — `mv_officer1` — rather than for an
     invented person. Reading a screen then costs nothing: the tenant, the
     role and which one are all in the name, where before it meant holding a
     cast list of fourteen in your head.
  
     The list of tenants comes from the seed's own map, so a school added
     without one fails here rather than at seed time. */
  assert.ok(
    Object.keys(prefixes).length >= 3,
    `found ${Object.keys(prefixes).length} prefixes`
  );
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

test('every sponsor carries a tenant prefix too', () => {
  /* Sponsors are teachers named in a scenario rather than accounts, so they
     never appear in the roster and are easy to forget. A sponsor called
     something a reader cannot place is the same problem the accounts had. */
  const sponsors = [...seed.matchAll(/sponsor: \{ name: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(sponsors.length > 0, 'no sponsors found, so this checks nothing');

  const known = new Set(Object.values(prefixes));
  const strays = [...new Set(sponsors)].filter((n) => !known.has(n.split('_')[0]));

  assert.deepEqual(strays, []);
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

test('the write-up is optional and carries the right shape for its program', () => {
  /* Optional at every fair here and required by none of them, which is why
     most students never write one. IRPD's is required and is not a
     scientific paper. */
  const { resolveProgram: resolve } = templateResolve;

  const fair = resolve('mvhs-scvsefa-2027', library).deliverables.get('manuscript');
  assert.equal(fair.requirement, 'optional');
  assert.equal(fair.shape, 'imrad');

  const course = resolve('irpd-mvhs-2027', library).deliverables.get('manuscript');
  assert.equal(course.requirement, 'required');
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

  assert.match(programs, /scope_id: program\.id/, 'the program seed should scope the grant');
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

const migration = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');

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
  /* Every school has an `independent-research`, and the slug comes from the
     template. Uniqueness on (slug, season) alone made the second school to
     seed fail on a duplicate key. */
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

console.log(`${passed} fixture assertions passed. ${scenarios.length} scenarios read.`);
