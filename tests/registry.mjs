/**
 * The template registry: files in, questions answered.
 *
 * These run against the real templates rather than fixtures, so a change to
 * SCVSEFA's calendar that breaks an assumption shows up here.
 *
 * Run: npm run test:registry
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { resolveProgram, datesFor, windowEnd } from '../src/lib/template-resolve.ts';
import { loadLibrary } from '../scripts/template-library.mjs';
import { migrationSql } from './migrations.mjs';

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

/* The registry uses import.meta.glob, which is Vite's. Outside a build we
   read the same files the same way, so the tests exercise the real content
   through the real resolution rules. */
/* Indexed by both filename and id, the way the registry does it, because
   `uses:` names the id inside the file rather than the file. */
const readDir = (dir) => {
  const out = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
    out[f.replace(/\.yaml$/, '')] = doc;
    if (doc?.id) out[doc.id] = doc;
  }
  return out;
};

const programs = readDir('src/config/programs');
const libraries = readDir('src/config/deliverables');
const shapes = readDir('src/config/shapes');

/**
 * The real resolver, not a copy of it.
 *
 * This file used to mirror the resolution logic so it could run outside Vite.
 * Two copies is how a fair's calendar comes to mean one thing in the database
 * and another on the page, so the logic moved to `template-resolve.ts`, which
 * has no I/O in it, and the application, the seed, and these tests all call
 * the same function.
 */
/* The same loader the seed uses, so these tests exercise the path that
   actually writes the database rather than a second reading of the files. */
const library = loadLibrary();
/**
 * How a program resolves for an ordinary project.
 *
 * A program no longer names a research process — the project does (22.4) —
 * so a bare resolution has no process at all, and a template that tightens a
 * step of the scientific method has nothing to tighten. Every caller in the
 * application supplies the project's process, and these have to resolve the
 * same way or they are testing something nobody runs.
 */
const DEFAULT_PROCESS = 'process-science';

/* Each program with the process it declares. IRPD says `own`, meaning its
   framework is its own steps, and forcing the science default on it prepends
   eleven steps the class does not teach. */
const programDocs = readDir('src/config/programs');

const declaredProcess = (id) => {
  const doc = programDocs[id];
  if (doc?.process === 'own') return id;
  return doc?.process ? `process-${doc.process}` : DEFAULT_PROCESS;
};

const resolve = (id) => resolveProgram(id, library, declaredProcess(id));

/** What the seed and the pages both use, keyed by step id. */
const dated = (program) => new Map(datesFor(program).map((d) => [d.step.id, d.date]));
const dateOf = (step, program) => dated(program).get(step.id) ?? null;

const mv = resolve('mvhs-scvsefa-2027');
const irpdResolved = resolve('irpd-mvhs-2027');
const irpd = irpdResolved;

test('a four-deep chain resolves', () => {
  /* process → isef → scvsefa → mvhs. */
  assert.ok(mv.steps.length > 20, `only ${mv.steps.length} steps`);
  assert.ok(mv.steps.some((s) => s.id === 'topic'), 'from the standard process');
  assert.ok(mv.steps.some((s) => s.id === 'approvals_before_work'), 'from ISEF');
  assert.ok(mv.steps.some((s) => s.id === 'src_submit'), 'from the fair');
  assert.ok(mv.steps.some((s) => s.id === 'club_practice'), 'from the club');
});

test('a program that brings its own process gets no standard steps', () => {
  /* `process: own` means exactly that: none of the research process's steps
     appear, however many the class itself declares.
   
     The count is a floor rather than an equality. A teacher adding or
     removing a milestone is the ordinary business of a template and should
     not fail a build; what must hold is that nothing arrived from a layer
     this program does not use. */
  assert.ok(!irpd.steps.some((s) => s.id === 'topic'), 'a standard step leaked in');
  assert.ok(!irpd.steps.some((s) => s.id === 'approvals_before_work'), 'an ISEF step leaked in');
  assert.ok(irpd.steps.length >= 5, `only ${irpd.steps.length} steps`);
});

test('steps come back in order', () => {
  const orders = mv.steps.map((s) => s.order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test('the fair replaces ISEF categories rather than inheriting them', () => {
  assert.equal(mv.categories.length, 4);
  assert.ok(!mv.categories.some((c) => c.id === 'TMED'));
});

test('deliverables come from every library the chain names', () => {
  assert.ok(mv.deliverables.has('abstract'), 'common');
  assert.ok(mv.deliverables.has('approval_1b'), 'ISEF forms');
  assert.ok(mv.deliverables.has('ethics_statement'), 'SCVSEFA forms');
});

/* ── Dates ───────────────────────────────────────────────────────────────── */

test('the real SCVSEFA dates resolve', () => {
  const by = (id) => dateOf(mv.steps.find((s) => s.id === id), mv);
  assert.equal(by('judging'), '2027-03-04');
  assert.equal(by('check_in'), '2027-03-03');
  assert.equal(by('src_submit'), '2026-11-13');
  assert.equal(by('register'), '2027-01-08');
});

test('the club sits before the fair, everywhere it should', () => {
  const by = (id) => dateOf(mv.steps.find((s) => s.id === id), mv);
  assert.ok(by('club_packet_check') < by('src_submit'));
  assert.ok(by('club_abstract_draft') < by('upload_abstract'));
  assert.ok(by('club_board_check') < by('check_in'));
  assert.ok(by('club_practice') < by('judging'));
});

test('a step with no anchor has no date rather than a wrong one', () => {
  const topic = mv.steps.find((s) => s.id === 'topic');
  assert.equal(dateOf(topic, mv), null);
});

test('every step in a course gets a date, from its phase where it has none', () => {
  /* A course runs on phase windows rather than deadlines, and an earlier
     version dropped anything without an explicit date — which cost IRPD six
     of its eight milestones, most of a year's work.
     
     A window is a teacher saying when the class does this. Resolving it to
     the last day of the month they named is reading what they said, not
     inventing a deadline. */
  const dates = datesFor(irpd);
  assert.equal(dates.filter((d) => d.date).length, dates.length);

  /* **Most of these are published days now**, which is a change. The class
     was carried here as six milestones against month windows, because that
     was all we had; it has since published a semester calendar naming the
     day each worksheet is due. So the ordinary case is `absolute`, the
     windows carry what the calendar leaves open, and `relative` is reserved
     for the two dates the class sets as a whole and can move as a unit. */
  const named = dates.filter((d) => d.source === 'absolute');
  assert.ok(named.length > 10, `only ${named.length} steps have a published day`);

  const fixed = dates.filter((d) => d.source === 'relative');
  for (const d of fixed) assert.match(d.step.name, /showcase|feedback session/i, d.step.name);

  assert.ok(irpd.phases.every((p) => p.window), 'every phase says when');
});

test('a phase window resolves to the end of the month it names', () => {
  /* The interviews have no day of their own: the calendar teaches how to run
     one and leaves when to the student, which is exactly what a window is
     for. */
  const dates = datesFor(irpd);
  const interviews = dates.find((d) => d.step.id === 'interviews');
  assert.equal(interviews.source, 'window');
  assert.equal(interviews.date, '2026-09-30', 'August to September ends in September');
});

test('and rolls into the next year when the school year does', () => {
  /* The course starts in August. April is not four months earlier; it is
     eight months later. */
  const notebook = datesFor(irpd).find((d) => d.step.id === 'notebook');
  const scaling = irpd.phases.find((p) => p.id === 'irpd_scaling');
  assert.equal(scaling.window.to, 'april');
  assert.equal(
    windowEnd(irpd, scaling.window),
    '2027-04-30',
    'November to April ends in the April after the course began'
  );
  assert.ok(notebook.date, 'the weekly journal step still resolves');
});

test('a step with neither a date nor a phase window stays undated', () => {
  /* The fair has thirteen of those: real work that no institution has put a
     day against. Inventing one would be worse than the gap. */
  const fair = datesFor(mv);
  const undated = fair.filter((d) => !d.date);
  assert.ok(undated.length > 0);
  for (const d of undated) assert.equal(d.source, 'unknown');
});

/* ── What the model claims about itself ──────────────────────────────────── */

test('five steps can end a season, and every one names its consequence', () => {
  const hard = mv.steps.filter((s) => s.consequence && s.consequence !== 'none');
  assert.ok(hard.length >= 4, `only ${hard.length}`);
  for (const s of hard) {
    assert.match(s.consequence, /^blocks_/, `${s.id}: ${s.consequence}`);
  }
});

test('every step knows whose deadline it is', () => {
  /* A student who cannot tell a club deadline from a fair rule starts
     treating real deadlines as advisory. */
  for (const s of mv.steps) {
    assert.ok(['process', 'program', 'school'].includes(s.source), `${s.id}: ${s.source}`);
  }
});

/* Where the research happens, as opposed to where paperwork does. The
   process names these; `work` was one bucket for both until the science and
   engineering processes replaced it. */
const RESEARCH = ['experiment', 'analysis'];

test('the fair asks nothing while the research happens', () => {
  const fromTheFair = mv.steps.filter(
    (s) => s.source === 'program' && RESEARCH.includes(s.phase)
  );
  assert.equal(fromTheFair.length, 0, 'the fair should be absent while the work happens');
});

test('and the club is present there', () => {
  const fromTheClub = mv.steps.filter(
    (s) => s.source === 'school' && RESEARCH.includes(s.phase)
  );
  assert.ok(fromTheClub.length >= 2, 'the club should fill the gap');
});

test('every step belongs to a declared phase', () => {
  const declared = new Set(mv.phases.map((p) => p.id));
  for (const s of mv.steps) assert.ok(declared.has(s.phase), `${s.id} in "${s.phase}"`);
});

test('every deliverable a step names exists', () => {
  for (const s of mv.steps) {
    for (const d of s.deliverables ?? []) {
      const id = d.ref ?? d.id;
      assert.ok(mv.deliverables.has(id), `${s.id} names "${id}"`);
    }
  }
});

/* ── Conditions ──────────────────────────────────────────────────────────── */

function evaluate(expression, facts) {
  const tokens = expression.trim().split(/\s+/);
  let result = null, operator = 'or', negate = false;
  for (const token of tokens) {
    if (token === 'or' || token === 'and') { operator = token; continue; }
    if (token === 'not') { negate = true; continue; }
    let value = Boolean(facts[token]);
    if (negate) { value = !value; negate = false; }
    result = result === null ? value : operator === 'and' ? result && value : result || value;
  }
  return result ?? true;
}

test('a project with no hazards needs no conditional forms', () => {
  const isef = libraries['isef-forms'];
  const needed = isef.deliverables.filter(
    (d) => d.requirement !== 'conditional' || evaluate(d.applies_when, {})
  );
  assert.equal(needed.length, 3, 'only the three unconditional forms');
});

test('a survey pulls in Form 4', () => {
  const isef = libraries['isef-forms'];
  const needed = isef.deliverables.filter(
    (d) => d.requirement !== 'conditional' || evaluate(d.applies_when, { humans: true })
  );
  assert.ok(needed.some((d) => d.id === 'humans_4'));
  assert.ok(!needed.some((d) => d.id === 'vertebrate_5a'));
});

test('the expression language handles or, and, and not', () => {
  assert.equal(evaluate('humans or vertebrates', { vertebrates: true }), true);
  assert.equal(evaluate('humans and vertebrates', { humans: true }), false);
  assert.equal(evaluate('not humans', {}), true);
  assert.equal(evaluate('not humans', { humans: true }), false);
});

/* ── Shapes ──────────────────────────────────────────────────────────────── */

test('a shape supplies what the structural check needs', () => {
  const imrad = shapes['imrad'];
  assert.ok(imrad.parts.length >= 7);
  for (const part of imrad.parts) {
    assert.ok(part.id && part.name, 'every part needs an id and a name');
    assert.ok(typeof part.min_words === 'number', `${part.id} has no word floor`);
  }
});

test('design research is a different shape, not a variant of the paper', () => {
  const ids = shapes['design-research'].parts.map((p) => p.id);
  assert.ok(ids.includes('empathy'));
  for (const scientific of ['methods', 'results', 'discussion']) {
    assert.ok(!ids.includes(scientific), scientific);
  }
});

/* ── The seed and the templates are one thing ────────────────────────────── */

test('the seed reads every program a school runs from a template', () => {
  /* The fair and its twelve deadlines were written into the migration by
     hand. That is why the interface still showed the old SCVSEFA after all
     the template work: the files resolved, were tested, and nothing read them
     into the database. */
  const seed = fs.readFileSync('scripts/seed-programs.mjs', 'utf8');

  for (const id of ['mvhs-scvsefa-2027', 'irpd-mvhs-2027', 'mvrj-2027']) {
    assert.ok(seed.includes(id), `${id} is not seeded`);
  }

  assert.match(seed, /resolveProgram/, 'it must resolve rather than restate');
  assert.match(seed, /datesFor/, 'and take its dates from the resolution');
});

test('no program or deadline is written by the migration', () => {
  const sql = migrationSql();

  assert.doesNotMatch(
    sql,
    /insert into public\.programs\s*\n?\s*\(/,
    'a program in the migration cannot be changed without a migration'
  );
  assert.doesNotMatch(
    sql,
    /insert into public\.program_milestones/,
    'a fair calendar is data a person reads off a page once a year'
  );
});

test('a program row keeps the template it came from', () => {
  /* `template_id` marks a row as derived, which is what lets a reset delete
     and regenerate it without touching anything a person entered. */
  const seed = fs.readFileSync('scripts/seed-programs.mjs', 'utf8');
  assert.match(seed, /template_id/);
  assert.match(seed, /not\('template_id', 'is', null\)/, 'and what it deletes');
});

console.log(`${passed} registry assertions passed.`);
