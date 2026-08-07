/**
 * Tests for the fair templates.
 *
 * The files are the specification of a season, so what matters is that
 * inheritance composes the way somebody editing a school file expects, that a
 * date is either read off a page or derived from one that was, and that an
 * unpublished date stays unpublished rather than being invented.
 *
 * Run: npm run test:programs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { resolveTemplate, resolveDates, gatingForms } from '../src/lib/programs.ts';

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

const load = (id) => yaml.load(fs.readFileSync(`src/config/programs/${id}.yaml`, 'utf8'));

const isef = load('isef');
const scvsefa = load('scvsefa');
const mvhs = load('mvhs-2027');

const regional = resolveTemplate([isef, scvsefa]);
const school = resolveTemplate([isef, scvsefa, mvhs]);

/* ── Inheritance ─────────────────────────────────────────────────────────── */

test('a child inherits the parent forms', () => {
  assert.ok(regional.forms.some((f) => f.id === 'approval_1b'), 'ISEF form missing');
});

test('and adds its own', () => {
  assert.ok(regional.forms.some((f) => f.id === 'scvsefa_entry'));
});

test('a removed category is gone', () => {
  assert.ok(isef.categories.some((c) => c.id === 'TMED'));
  assert.ok(!regional.categories.some((c) => c.id === 'TMED'));
});

test('an override changes the parent rather than duplicating it', () => {
  const register = regional.milestones.filter((m) => m.id === 'register');
  assert.equal(register.length, 1, 'the milestone was duplicated');
  assert.equal(register[0].relative.anchor, 'registration_closes');
  /* The parent's name survives an override that does not restate it. */
  assert.equal(register[0].name, 'Register the entry');
});

test('an override for something no parent defines is refused', () => {
  assert.throws(
    () => resolveTemplate([isef, { id: 'x', milestones: { override: [{ id: 'nonexistent' }] } }]),
    /nonexistent/,
    'a typo in an override should not be a silent no-op'
  );
});

test('three levels compose', () => {
  assert.ok(school.forms.some((f) => f.id === 'approval_1b'), 'from ISEF');
  assert.ok(school.forms.some((f) => f.id === 'scvsefa_entry'), 'from the regional fair');
  assert.ok(school.milestones.some((m) => m.id === 'club_practice'), 'from the school');
});

test('a school can pull a fair deadline earlier for itself', () => {
  const fair = regional.milestones.find((m) => m.id === 'src_packet');
  const club = school.milestones.find((m) => m.id === 'src_packet');
  assert.equal(fair.relative.days, -14);
  assert.equal(club.relative.days, -21);
});

/* ── Dates ───────────────────────────────────────────────────────────────── */

test('a relative date resolves against its anchor', () => {
  const dates = resolveDates(regional);
  const setup = dates.find((d) => d.id === 'setup');
  assert.equal(regional.anchors.fair, '2027-03-10');
  assert.equal(setup.date, '2027-03-09');
  assert.equal(setup.source, 'relative');
});

test('an offset crossing a month boundary is still right', () => {
  const dates = resolveDates(regional);
  assert.equal(dates.find((d) => d.id === 'src_packet').date, '2027-01-06');
});

test('an absolute date is taken as written', () => {
  const [date] = resolveDates(
    resolveTemplate([{ id: 'x', name: 'x', milestones: [{ id: 'm', name: 'm', on: '2027-04-01' }] }])
  );
  assert.equal(date.date, '2027-04-01');
  assert.equal(date.source, 'absolute');
});

test('a date the fair has not published stays unknown rather than invented', () => {
  const partial = resolveTemplate([
    isef,
    { id: 'y', name: 'y', anchors: {}, milestones: { add: [{ id: 'z', name: 'z', relative: { anchor: 'fair', days: -7 } }] } },
  ]);
  const z = resolveDates(partial).find((d) => d.id === 'z');
  assert.equal(z.date, null);
  assert.equal(z.source, 'unknown');
  assert.equal(z.anchor, 'fair');
});

test('every date says where it came from', () => {
  for (const date of resolveDates(school)) {
    assert.ok(['absolute', 'relative', 'unknown'].includes(date.source), date.id);
  }
});

test('moving the fair moves everything hung off it', () => {
  const moved = resolveTemplate([isef, scvsefa, { id: 'm', anchors: { fair: '2027-03-24' } }]);
  const dates = resolveDates(moved);
  assert.equal(dates.find((d) => d.id === 'setup').date, '2027-03-23');
  assert.equal(dates.find((d) => d.id === 'results').date, '2027-03-25');
  /* And nothing hung off a different anchor moved with it. */
  assert.equal(
    resolveDates(regional).find((d) => d.id === 'src_packet').date,
    dates.find((d) => d.id === 'src_packet').date
  );
});

/* ── Gates ───────────────────────────────────────────────────────────────── */

test('the forms that block experimentation are identifiable', () => {
  const gating = gatingForms(regional).map((f) => f.id);
  assert.ok(gating.includes('approval_1b'));
  assert.ok(gating.includes('research_plan'));
  /* An abstract is late-stage paperwork and blocks nothing about the work. */
  assert.ok(!gating.includes('abstract'));
});

test('every form declares what it blocks and who signs it', () => {
  for (const form of school.forms) {
    assert.ok(['experimentation', 'registration', 'competition'].includes(form.blocks), form.id);
    assert.ok(form.signed_by?.length, `${form.id} has no signatories`);
  }
});

test('a school deadline is marked as the club\u2019s own', () => {
  const practice = school.milestones.find((m) => m.id === 'club_practice');
  assert.equal(practice.internal, true);
  /* A student who confuses a club deadline with a fair rule will treat a real
     deadline as advisory. */
  const register = school.milestones.find((m) => m.id === 'register');
  assert.notEqual(register.internal, true);
});

test('the limits a fair tightens are the ones that apply', () => {
  assert.equal(isef.limits.abstract_words, 250);
  assert.equal(school.limits.abstract_words, 250);
  assert.equal(school.limits.board.width_cm, 122, 'the parent board limit should survive');
});

/* ── Families and venues ─────────────────────────────────────────────────── */

test('a school file inherits the fair\u2019s family', () => {
  assert.equal(regional.family, 'scvsefa');
  assert.equal(school.family, 'scvsefa');
});

test('the journal is its own family and its own kind', () => {
  const journal = yaml.load(fs.readFileSync('src/config/programs/journal.yaml', 'utf8'));
  assert.equal(journal.family, 'mvrj');
  assert.equal(journal.kind, 'publication');
  /* A submission is a state machine, not a checkpoint. */
  assert.equal(journal.has.milestones, false);
  assert.ok(!journal.milestones, 'a publication should declare no milestones');
});

test('the journal derives its editors rather than granting them twice', () => {
  const journal = yaml.load(fs.readFileSync('src/config/programs/journal.yaml', 'utf8'));
  assert.ok(Array.isArray(journal.staff_from) && journal.staff_from.length > 0);
  /* Naming two families would dissolve the boundary between them. That is
     allowed and must be deliberate, so the fixture names one. */
  assert.equal(journal.staff_from.length, 1);
});

test('a competition points at the venue it publishes to', () => {
  assert.equal(scvsefa.publishes_to, 'mvrj');
});

console.log(`${passed} program template assertions passed.`);
