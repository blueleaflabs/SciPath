/**
 * Every template validates, and the validator is strict about the right
 * things.
 *
 * The line it draws: an authoring mistake is an error, because nobody can fix
 * it from inside the application. Anything about how the work actually goes
 * is at most a warning, because high school runs on cramming and software
 * that refuses to record what happened gets lied to.
 *
 * Run: npm run test:templates
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { validate } from '../src/lib/validate-template.ts';
import { resolveProgram, datesFor } from '../src/lib/template-resolve.ts';
import { loadLibrary } from '../scripts/template-library.mjs';

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

const read = (dir, id) => yaml.load(fs.readFileSync(`src/config/${dir}/${id}.yaml`, 'utf8'));

const libraries = ['common', 'isef-forms', 'scvsefa-forms'].map((f) => read('deliverables', f));
const shapes = fs.readdirSync('src/config/shapes').filter((f) => f.endsWith('.yaml'))
  .map((f) => yaml.load(fs.readFileSync(`src/config/shapes/${f}`, 'utf8')));

const allDeliverables = new Set(libraries.flatMap((l) => l.deliverables.map((d) => d.id)));
const allFacts = new Set(libraries.flatMap((l) => (l.facts ?? []).map((f) => f.id)));
const allShapes = new Set(shapes.map((s) => s.id));

const programs = ['process-standard', 'isef', 'scvsefa-2027', 'mvhs-scvsefa-2027',
                  'irpd-mvhs-2027', 'journal-mvrj-2027'].map((id) => read('programs', id));

/**
 * A template is validated resolved, not file by file.
 *
 * `requires: [literature]` in the club's file points at a step from the
 * standard process, which is correct and invisible to anything looking at one
 * file. The validator found that on its first run.
 *
 * The resolution is the real one. This file kept its own copy until that copy
 * stopped normalizing dates and every program failed to validate — the third
 * time a second copy of this logic has caused a problem.
 */
const CHAINS = {
  'process-standard': 'process-standard',
  isef: 'isef',
  'scvsefa-2027': 'scvsefa-2027',
  'mvhs-scvsefa-2027': 'mvhs-scvsefa-2027',
  'irpd-mvhs-2027': 'irpd-mvhs-2027',
  'journal-mvrj-2027': 'mvrj-2027',
};

const library = loadLibrary();
const resolve = (id) => resolveProgram(id, library);

/* Every program a school actually runs, which is what the notification
   checks below walk. The process templates are layers rather than programs
   and resolve to nothing on their own. */
const programIds = ['mvhs-scvsefa-2027', 'irpd-mvhs-2027', 'grant-mvhs-micro-2027',
                    'mvrj-2027', 'independent-research', 'scvsefa-2027'];

/* A resolved program carries its deliverables as a Map, keyed by id: the
   libraries it uses, merged with anything it declares itself. */
const bundleFor = (program) => ({
  program,
  deliverables: new Set([...allDeliverables, ...program.deliverables.keys()]),
  shapes: allShapes,
  facts: new Set([...allFacts, ...(program.facts ?? []).map((f) => f.id)]),
});

/* ── Every file validates ────────────────────────────────────────────────── */

for (const [name, id] of Object.entries(CHAINS)) {
  test(`${name} has no authoring errors when resolved`, () => {
    const resolved = resolve(id);
    const errors = validate(bundleFor(resolved)).filter((p) => p.level === 'error');
    assert.deepEqual(errors, [], errors.map((e) => `${e.where}: ${e.message}`).join('\n'));
  });

  test(`${name} has no warnings either`, () => {
    /* A warning is an authoring mistake that does not stop the file loading:
       a date that contradicts the sequence, a shape nobody declares. The
       templates in this repository should have none. */
    const warnings = validate(bundleFor(resolve(id))).filter((p) => p.level === 'warning');
    assert.deepEqual(warnings.map((w) => `${w.where}: ${w.message}`), []);
  });
}

/* ── The validator catches what it should ────────────────────────────────── */

const base = { id: 'test', phases: [{ id: 'p' }], anchors: {} };
const empty = { deliverables: new Set(), shapes: new Set(), facts: new Set() };

test('a deliverable nobody declared is an error', () => {
  const out = validate({ ...empty, program: {
    ...base, steps: [{ id: 's', name: 'S', phase: 'p', deliverables: [{ ref: 'ghost' }] }],
  }});
  assert.ok(out.some((p) => p.level === 'error' && /ghost/.test(p.message)));
});

test('a phase nobody declared is an error', () => {
  const out = validate({ ...empty, program: {
    ...base, steps: [{ id: 's', name: 'S', phase: 'nowhere' }],
  }});
  assert.ok(out.some((p) => p.level === 'error' && /nowhere/.test(p.message)));
});

test('requiring a step that is not there is an error', () => {
  const out = validate({ ...empty, program: {
    ...base, steps: [{ id: 's', name: 'S', phase: 'p', requires: ['absent'] }],
  }});
  assert.ok(out.some((p) => p.level === 'error' && /absent/.test(p.message)));
});

test('a fact nobody declared is an error', () => {
  const out = validate({ ...empty, program: {
    ...base, steps: [{ id: 's', name: 'S', phase: 'p', applies_when: 'unicorns' }],
  }});
  assert.ok(out.some((p) => p.level === 'error' && /unicorns/.test(p.message)));
});

test('a cycle in requires is an error, because no order exists at all', () => {
  const out = validate({ ...empty, program: {
    ...base, steps: [
      { id: 'a', name: 'A', phase: 'p', requires: ['b'] },
      { id: 'b', name: 'B', phase: 'p', requires: ['a'] },
    ],
  }});
  assert.ok(out.some((p) => p.level === 'error' && /cycle/.test(p.message)));
});

/* ── And is forgiving about what it should be ────────────────────────────── */

test('a step dated before what it requires is a warning, not an error', () => {
  /* This is exactly the literature-review-before-topic case. The author
     should see it. The student should never be stopped by it. */
  const out = validate({ ...empty, program: {
    ...base,
    anchors: { fair: '2027-03-04' },
    steps: [
      { id: 'first', name: 'First', phase: 'p', due: { anchor: 'fair', days: -10 } },
      { id: 'second', name: 'Second', phase: 'p', due: { anchor: 'fair', days: -20 }, requires: ['first'] },
    ],
  }});
  assert.ok(out.some((p) => p.level === 'warning' && /not due until/.test(p.message)));
  assert.equal(out.filter((p) => p.level === 'error').length, 0);
});

test('nothing about a student is checked at all', () => {
  /* The validator takes a template. It has no access to a project, which is
     the structural guarantee that it cannot block anybody. */
  const out = validate({ ...empty, program: { ...base, steps: [] } });
  assert.deepEqual(out.filter((p) => p.level === 'error'), []);
});

/* ── What the templates say about themselves ─────────────────────────────── */

/* The phases where the research actually happens, as opposed to the ones
   where paperwork does. */
const RESEARCH = ['experiment', 'analysis'];

test('a fair asks nothing while the research happens', () => {
  /* Not a fault. It is what a fair is, and it is the argument for a club. */
  const fair = programs.find((p) => p.id === 'scvsefa-2027');
  const phases = (fair.steps.add ?? []).map((s) => s.phase);
  for (const phase of RESEARCH) {
    assert.ok(!phases.includes(phase), `the fair should ask nothing during ${phase}`);
  }
});

test('and the club fills exactly that gap', () => {
  const club = programs.find((p) => p.id === 'mvhs-scvsefa-2027');
  const phases = (club.steps.add ?? []).map((s) => s.phase);
  assert.ok(
    RESEARCH.some((phase) => phases.includes(phase)),
    'the club should be present while the research happens'
  );
});

test('every deliverable states whether it is required', () => {
  for (const library of libraries) {
    for (const d of library.deliverables) {
      assert.ok(
        ['required', 'optional', 'conditional'].includes(d.requirement),
        `${library.id}/${d.id} has requirement "${d.requirement}"`
      );
    }
  }
});

test('a conditional deliverable says what makes it apply', () => {
  for (const library of libraries) {
    for (const d of library.deliverables) {
      if (d.requirement === 'conditional') {
        assert.ok(d.applies_when, `${d.id} is conditional on nothing`);
      }
    }
  }
});

test('a form that must precede the work says so', () => {
  const isef = libraries.find((l) => l.id === 'deliverables-isef');
  const before = isef.deliverables.filter((d) => d.before_work);
  assert.ok(before.length >= 8, `only ${before.length} forms are marked before_work`);
});

test('every shape names its parts', () => {
  for (const shape of shapes) {
    if (shape.id === 'abstract') continue;   // questions rather than parts
    assert.ok(shape.parts?.length > 0, `${shape.id} has no parts`);
    for (const part of shape.parts) assert.ok(part.id && part.name, shape.id);
  }
});

test('no program carries a document shape of its own', () => {
  /* A shape belongs to a deliverable: a program could want two write-ups of
     different shapes at two different steps. */
  for (const program of programs) {
    assert.ok(!program.structure, `${program.id} carries a structure`);
    assert.ok(!program.sections, `${program.id} carries sections`);
  }
});

test('no template estimates effort', () => {
  const raw = fs.readdirSync('src/config/programs')
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => fs.readFileSync(`src/config/programs/${f}`, 'utf8'))
    .join('\n');
  assert.doesNotMatch(raw, /^\s*effort:/m, 'effort is back');
});

test('every program is versioned', () => {
  for (const program of programs) {
    if (program.kind === 'process') continue;
    assert.ok(program.version, `${program.id} has no version`);
  }
});


/* ── Every program can say something ────────────────────────────────────── */

test('every dated step has a reminder window', () => {
  /* IRPD brought its own steps and chained through no research process, so
     it inherited the reminder defaults from nowhere: eight dated milestones,
     none of them ever mentioned, and a student two weeks from a real
     deadline owing five things and told about none.
   
     Nothing failed. A program that says nothing looks exactly like a program
     with nothing to say, which is why this is a check rather than something
     somebody would notice.
   
     `notify: none` is a deliberate silence and is allowed here; 21.4 refuses
     it for anything whose lateness blocks something. */
  const problems = [];

  for (const id of programIds) {
    const program = resolveProgram(id, library);
    const dated = datesFor(program).filter((d) => d.date);

    for (const { step } of dated) {
      if (step.notify === null) continue;
      if (step.notify && (step.notify.from ?? 0) > 0) continue;
      problems.push(`${id}/${step.id}`);
    }
  }

  assert.deepEqual(problems, [], 'a dated step nobody is ever told about');
});

test('a step that blocks something may not be silenced', () => {
  /* A school may not turn off the deadline that ends its own season. */
  const problems = [];

  for (const id of programIds) {
    for (const step of resolveProgram(id, library).steps) {
      const blocks = step.consequence && step.consequence !== 'none';
      if (blocks && step.notify === null) problems.push(`${id}/${step.id}`);
    }
  }

  assert.deepEqual(problems, []);
});

test('urgent is never further out than from', () => {
  /* A window that goes urgent before it appears is a window nobody can
     read, and it would silently never reach the top of a digest. */
  const problems = [];

  for (const id of programIds) {
    for (const step of resolveProgram(id, library).steps) {
      const w = step.notify;
      if (!w) continue;
      if ((w.urgent ?? 0) > (w.from ?? 0)) {
        problems.push(`${id}/${step.id}: urgent ${w.urgent} > from ${w.from}`);
      }
    }
  }

  assert.deepEqual(problems, []);
});


/* ── Cohorts and opportunities ──────────────────────────────────────────── */

const everyTemplate = fs
  .readdirSync('src/config/programs')
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => ({ file: f, doc: read('programs', f.replace(/\.yaml$/, '')) }));

test('every template says which of the two things it is', () => {
  /* `program` was two different things wearing one name: a group you belong
     to, and a thing a project enters. A class, a club and a regional fair
     cannot sit at one level, and the way that error stayed invisible was
     that nothing ever had to say which it was (22.1).
   
     A process template is neither: it is a layer other templates inherit,
     and it is never joined or entered. */
  const problems = [];

  for (const { file, doc } of everyTemplate) {
    if (doc.kind === 'process') continue;
    if (doc.role === 'cohort' || doc.role === 'opportunity') continue;

    /* `role: none` is a template that is neither, which today means exactly
       one: `independent-research`, scheduled for removal in 22.10 and
       waiting on `projects.process_id`. Saying so is the point — a template
       that cannot be classified is either a mistake or a thing being
       retired, and both deserve to be visible rather than absent. */
    if (doc.role === 'none') continue;

    problems.push(`${file}: role is ${doc.role ?? 'missing'}`);
  }

  assert.deepEqual(problems, [], 'add role: cohort or role: opportunity');
});

test('a cohort prepares for something that exists', () => {
  /* `prepares_for` supplies the anchors a derived calendar resolves against,
     so a name that matches nothing is a cohort whose every deadline silently
     has no date (22.6). */
  const ids = new Set(everyTemplate.map(({ doc }) => doc.id));
  const problems = [];

  for (const { file, doc } of everyTemplate) {
    if (!doc.prepares_for) continue;
    if (doc.role !== 'cohort') problems.push(`${file}: only a cohort prepares for something`);
    if (!ids.has(doc.prepares_for)) problems.push(`${file}: no such template ${doc.prepares_for}`);
  }

  assert.deepEqual(problems, []);
});

test('what a cohort prepares for is an opportunity', () => {
  /* A cohort pointing at another cohort would be a club preparing its
     members for a club, which is not a thing that happens and would resolve
     anchors from a calendar that has none of its own. */
  const roleOf = new Map(everyTemplate.map(({ doc }) => [doc.id, doc.role]));
  const problems = [];

  for (const { file, doc } of everyTemplate) {
    if (!doc.prepares_for) continue;
    if (roleOf.get(doc.prepares_for) !== 'opportunity') {
      problems.push(`${file}: ${doc.prepares_for} is a ${roleOf.get(doc.prepares_for)}`);
    }
  }

  assert.deepEqual(problems, []);
});

test('an opportunity a cohort points at carries the anchors it needs', () => {
  /* The club's internal deadlines are offsets from the fair's dates. If the
     opportunity declares no anchors, every derived milestone resolves to no
     date and the cohort's calendar is empty without anything failing. */
  const byId = new Map(everyTemplate.map(({ doc }) => [doc.id, doc]));
  const problems = [];

  for (const { file, doc } of everyTemplate) {
    if (!doc.prepares_for) continue;
    const target = byId.get(doc.prepares_for);
    const anchors = Object.keys(target?.anchors ?? {});
    if (anchors.length === 0) problems.push(`${file}: ${doc.prepares_for} declares no anchors`);
  }

  assert.deepEqual(problems, []);
});


test('an opportunity does not prescribe a research process', () => {
  /* Three parties want to claim the process and only one may have it.
   
     A cohort may prescribe it, because a class teaches a way of working. An
     opportunity may not: Synopsys's science and engineering tracks are
     *categories*, the fair's view of what you did so it can be judged
     against like work, and they live on `has.categories`. Letting a fair set
     the process would mean entering two fairs asks a student to have done
     the work two ways (22.4). */
  /**
   * Three do today, and they are named rather than tolerated.
   *
   * `scvsefa-2027` and `isef` declare `process: science` because that is
   * currently how the fair's steps get merged with the scientific method,
   * and `grant-mvhs-micro-2027` declares `process: grant` for steps that are
   * really the grant's own requirements rather than a way of doing research.
   *
   * They stay until the resolver reads the process from the project instead.
   * Removing the declaration first would take the science steps away before
   * anything else supplies them — the destructive half of a two part change,
   * which is the same trap `independent-research` is waiting on.
   *
   * Named individually so the list can only shrink: a fourth opportunity
   * doing this fails, and each of these disappearing is a line deleted here.
   */
  const pending = new Set([
    'scvsefa-2027.yaml',
    'isef.yaml',
    'grant-mvhs-micro-2027.yaml',
  ]);

  const problems = [];
  const fixed = [];

  for (const { file, doc } of everyTemplate) {
    if (doc.role !== 'opportunity') continue;

    if (!doc.process) {
      if (pending.has(file)) fixed.push(file);
      continue;
    }

    if (!pending.has(file)) problems.push(`${file}: prescribes ${doc.process}`);
  }

  assert.deepEqual(problems, [], 'a category is not a process');

  /* And the list is not allowed to go stale: a template that has been fixed
     must be taken off it, or the exemption outlives the reason for it. */
  assert.deepEqual(fixed, [], 'these no longer prescribe a process: remove them from `pending`');
});

test('every project can be given a process', () => {
  /* The column is not null with a default, because a fourteen year old's
     first screen must not be "scientific method or engineering design?" and
     a project with no process has an empty calendar and a digest that never
     speaks. So whatever the default names has to exist. */
  const migration = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');
  const fallback = migration.match(/process_id\s+text not null default '([\w-]+)'/);

  assert.ok(fallback, 'projects.process_id has no default');
  assert.ok(
    everyTemplate.some(({ doc }) => doc.id === fallback[1]),
    `the default process ${fallback[1]} is not a template`
  );
});

console.log(`${passed} template assertions passed.`);
