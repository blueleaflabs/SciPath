/**
 * WHERE A PROJECT STANDS.
 *
 * One computation behind the entry page, the overview and the digest, so
 * that a student cannot be told two different things about one project
 * (20.1). It is pure, which is what makes this file possible: real
 * templates, a fixed date, and an exact answer.
 *
 * Run: npm run test:status
 */

import assert from 'node:assert/strict';
import { loadLibrary } from '../scripts/template-library.mjs';
import { resolveProgram, datesFor } from '../src/lib/template-resolve.ts';
import { projectStatus, urgencyOf, whenText } from '../src/lib/status.ts';

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

const library = loadLibrary();
const fair = resolveProgram('mvhs-scvsefa-2027', library);
const dueBy = new Map(datesFor(fair).map((d) => [d.step.id, d.date]));

const statusOn = (isoDay, recorded = [], facts = { vertebrates: true }) =>
  projectStatus({
    entryId: 'e1',
    projectId: 'p1',
    title: 'Snails',
    programName: 'Research Club',
    template: fair,
    facts,
    recorded: new Set(recorded),
    dueBy,
    today: new Date(`${isoDay}T09:00:00`),
  });

/* ── The window comes from the step ──────────────────────────────────────── */

test('a step is quiet outside its window and loud inside it', () => {
  const step = { id: 'x', name: 'x', phase: 'p', order: 1, notify: { from: 21, urgent: 3 } };
  assert.equal(urgencyOf(step, 40), null, 'a month out is not worth saying');
  assert.equal(urgencyOf(step, 21), 'soon');
  assert.equal(urgencyOf(step, 4), 'soon');
  assert.equal(urgencyOf(step, 3), 'urgent');
  assert.equal(urgencyOf(step, 0), 'urgent');
  assert.equal(urgencyOf(step, -1), 'late');
});

test('a step with no window is never mentioned', () => {
  /* `notify: none` in a template, which a check refuses for anything
     blocking. */
  const silenced = { id: 'x', name: 'x', phase: 'p', order: 1, notify: null };
  assert.equal(urgencyOf(silenced, 1), null);
});

test('a step with no date is work to do rather than a deadline', () => {
  const step = { id: 'x', name: 'x', phase: 'p', order: 1, notify: { from: 21, urgent: 3 } };
  assert.equal(urgencyOf(step, null), 'later');
});

/* ── Against the real fair template ──────────────────────────────────────── */

test('the reminder window is inherited rather than written per step', () => {
  /* Nobody writes a window on thirty steps: it comes from the step's
     consequence, through the platform floor and whatever a template
     overrides.
   
     Asserted on the shape rather than the numbers. The numbers are a
     school's judgement — the fair widened its own to twenty eight days
     because a form needing a signature and a post has to be raised while
     there is still somebody to chase — and a test that pins them turns
     every such judgement into a failing build. What must hold is that a
     step which blocks something is warned about earlier than one that does
     not. */
  const blocking = fair.steps.find((s) => s.consequence === 'blocks_experimentation');
  const quiet = fair.steps.find((s) => (s.consequence ?? 'none') === 'none' && s.notify);

  assert.ok(blocking.notify.from > 0, 'a blocking step has no window');
  assert.ok(quiet.notify.from > 0, 'an ordinary step has no window');
  assert.ok(
    blocking.notify.from > quiet.notify.from,
    `blocking ${blocking.notify.from} is not longer than ordinary ${quiet.notify.from}`
  );
  assert.ok(blocking.notify.urgent <= blocking.notify.from);
});

test('an unknown consequence is loud, not quiet', () => {
  /* A template author adding `blocks_the_new_thing` should get a loud
     default, because the quiet one is what nobody would notice was wrong. */
  const other = fair.steps.find(
    (s) => s.consequence && !['none', 'blocks_experimentation'].includes(s.consequence)
  );
  assert.ok(other, 'the fair template no longer exercises this');
  assert.ok(other.notify.from >= 14, `${other.consequence} resolved to ${JSON.stringify(other.notify)}`);
});

test('recording what a step wants takes it off the list', () => {
  const before = statusOn('2026-10-01');
  const named = before.outstanding.find((i) => i.stepId === 'club_topic');
  assert.ok(named, 'the question step is not outstanding to begin with');

  /* The same derivation the deadline row uses. Recording the shared
     deliverable satisfies every step that wanted it, not just the first. */
  const after = statusOn('2026-10-01', ['question']);
  assert.equal(after.outstanding.find((i) => i.stepId === 'club_topic'), undefined);
  assert.ok(after.remaining < before.remaining);
});

test('an inapplicable step never counts against a project', () => {
  /* A project with no vertebrates does not owe the vertebrate forms, and a
     score that counted them would tell somebody they are behind on work
     they will never do. */
  const withAnimals = statusOn('2026-10-01', [], { vertebrates: true });
  const without = statusOn('2026-10-01', [], {});
  assert.ok(without.applicable < withAnimals.applicable);
});

test('the worst thing is first', () => {
  const st = statusOn('2027-03-01');
  const order = ['late', 'urgent', 'soon', 'later'];
  const seen = st.outstanding.map((i) => order.indexOf(i.urgency));
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'the list is out of order');
});

test('every outstanding item links to the section, not to a fragment', () => {
  /* A fragment never reaches a server, so a link that has to survive a sign
     in carries the anchor as a query parameter (20.10). */
  for (const item of statusOn('2026-10-01').outstanding) {
    assert.match(item.href, /^\/app\/entry\/e1\/\?at=[a-z]+$/, item.name);
    assert.doesNotMatch(item.href, /#/);
  }
});

/* ── How a moment is said ────────────────────────────────────────────────── */

test('the interval wording is the escalation', () => {
  /* One row of state described differently as the date moves. Nothing is
     created and nothing cancelled, so it cannot contradict itself. */
  assert.equal(whenText(7), 'due in 7 days');
  assert.equal(whenText(1), 'due tomorrow');
  assert.equal(whenText(0), 'due today');
  assert.equal(whenText(-1), '1 day late');
  assert.equal(whenText(-3), '3 days late');
  assert.equal(whenText(null), 'no date set');
});


/* ── The digest, which is that status rendered ───────────────────────────── */

import { renderDigest, cadenceNeeded, isEmpty } from '../src/lib/notify/digest.ts';

const digestOf = (isoDay, recorded = []) =>
  renderDigest({
    mine: [statusOn(isoDay, recorded)],
    watched: [],
    origin: 'https://montavista.scipath.org',
    schoolName: 'Monta Vista Research Club',
    settingsPath: '/app/profile/?at=notifications',
  });

test('nothing outstanding sends nothing at all', () => {
  /* A weekly message saying there is nothing to do is how somebody learns to
     filter the one that matters (20.3). */
  const quiet = { mine: [], watched: [], origin: '', schoolName: '' };
  assert.equal(isEmpty(quiet), true);
  assert.equal(renderDigest(quiet), null);
  assert.equal(cadenceNeeded(quiet), 'none');
});

test('the cadence is decided by the contents, not by a setting', () => {
  /* Nobody configures this, because the right answer is derivable: a student
     in a quiet October hears nothing, and the same student the week before a
     deadline hears daily. */
  const early = { mine: [statusOn('2026-09-01')], watched: [], origin: '', schoolName: '' };
  const late = { mine: [statusOn('2027-03-01')], watched: [], origin: '', schoolName: '' };
  assert.equal(cadenceNeeded(late), 'daily', 'something late has to be daily');
  assert.ok(['weekly', 'none'].includes(cadenceNeeded(early)));
});

test('the subject names the school and never the person', () => {
  /* A student's name in a subject line sits in a shared family inbox where
     anybody can read it (20.8). */
  const d = digestOf('2027-01-05');
  assert.match(d.subject, /^Monta Vista Research Club: /);
  assert.doesNotMatch(d.subject, /mv_student|Thermal tolerance/);
});

test('every link is absolute, tenant correct, and has no fragment', () => {
  const d = digestOf('2027-01-05');
  const links = d.text.match(/https?:\/\/\S+/g) ?? [];
  assert.ok(links.length > 0, 'a digest with no link is not a notification');

  for (const link of links) {
    assert.ok(link.startsWith('https://montavista.scipath.org/'), link);
    assert.doesNotMatch(link, /#/, 'a fragment never reaches a server');
  }
});

test('it says what is missing, which is the useful part', () => {
  const d = digestOf('2027-01-05');
  assert.match(d.text, /Missing: /);
  assert.match(d.text, /\d+ of \d+ remaining/);
});

test('it carries no notebook, manuscript or other person', () => {
  /* A pointer, never a copy. Read over a shoulder it has said almost
     nothing (20.8). */
  const d = digestOf('2027-01-05');
  for (const forbidden of ['notebook entry', 'abstract', 'reviewer', 'comment']) {
    assert.doesNotMatch(d.text.toLowerCase(), new RegExp(forbidden), forbidden);
  }
});

test('recording something takes its line out of the digest', () => {
  /* Nothing was queued, so nothing has to be cancelled: the line simply
     stops appearing (20.2). */
  const before = digestOf('2027-01-05');
  const after = digestOf('2027-01-05', ['question', 'literature_review']);
  assert.ok(after === null || after.text.length < before.text.length);
  assert.doesNotMatch(after?.text ?? '', /Missing: Literature review\./);
});

console.log(`\n${passed} status assertions passed.`);
