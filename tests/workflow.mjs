/**
 * Tests for the submission state machine.
 *
 * Two jobs. The first is the ordinary one: assert that each state offers the
 * right actions to the right person.
 *
 * The second matters more. The transitions exist twice, here and in SQL, and
 * two copies of a state machine is two answers to the same question. The last
 * test in this file parses the migration and asserts that every action in the
 * table has a function behind it, so an action can never be offered on a
 * screen that the database will refuse.
 *
 * Run: npm run test:workflow
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ACTIONS,
  actionDone,
  doneLabel,
  authorMayEdit,
  QUEUE_ORDER,
  TERMINAL,
  actionsFor,
  can,
  isTerminal,
  publicLabel,
  authorGuidance,
  editorLabel,
  REVIEW_QUESTIONS,
} from '../src/lib/workflow.ts';

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

const ids = (list) => list.map((a) => a.id).sort();

/* ── The editor's path ──────────────────────────────────────────────────── */

test('a new submission offers exactly one editor action', () => {
  assert.deepEqual(ids(actionsFor('submitted', 'editor')), ['claim_submission']);
});

test('screening offers the three outcomes, assignment, and a send back', () => {
  assert.deepEqual(ids(actionsFor('screening', 'editor')), [
    'assign_reviewer',
    'request_revisions',
    'screen_advance',
    'screen_decline',
    'screen_return',
  ]);
});

test('an editor holding a submission can always send it back', () => {
  /* Every state where the editor has it in their hands. There should be no
     point at which they can see the work, want to send a one line
     correction, and have no way to do it. */
  for (const state of ['screening', 'in_review', 'editorial_review']) {
    assert.equal(can(state, 'request_revisions', 'editor'), true, state);
  }
});

test('the editor can move out of review without waiting for a quorum', () => {
  assert.equal(can('in_review', 'to_editorial_review', 'editor'), true);
});

test('a decision is only available from the editorial read', () => {
  assert.equal(can('editorial_review', 'decide_accepted', 'editor'), true);
  assert.equal(can('in_review', 'decide_accepted', 'editor'), false);
  assert.equal(can('screening', 'decide_accepted', 'editor'), false);
});

test('a submission can go back with a note and no list', () => {
  /* The gate is in SQL, where one of the two must be present. The screen
     offers the action either way, because an editor with a one line
     correction should not have to itemize it to send it. */
  assert.equal(can('in_review', 'request_revisions', 'editor', { findingCount: 0 }), true);
  assert.equal(can('in_review', 'request_revisions', 'editor', { findingCount: 3 }), true);
});

test('an editor is offered nothing on a terminal submission', () => {
  for (const state of TERMINAL) {
    assert.deepEqual(actionsFor(state, 'editor'), [], state);
  }
});

/* ── The author's path ──────────────────────────────────────────────────── */

test('an author withdraws freely before anybody has read it', () => {
  for (const state of ['draft', 'submitted', 'screening']) {
    assert.equal(can(state, 'withdraw_submission', 'author'), true, state);
    assert.equal(can(state, 'request_withdrawal', 'author'), false, state);
  }
});

test('once reviewers are working it becomes a request', () => {
  for (const state of ['in_review', 'revisions_requested', 'editorial_review', 'accepted']) {
    assert.equal(can(state, 'withdraw_submission', 'author'), false, state);
    assert.equal(can(state, 'request_withdrawal', 'author'), true, state);
  }
});

test('withdrawal is never offered on a published record', () => {
  assert.deepEqual(actionsFor('published', 'author'), []);
});

test('asking twice is not offered', () => {
  assert.equal(
    can('in_review', 'request_withdrawal', 'author', { withdrawalRequested: true }),
    false
  );
  assert.equal(
    can('submitted', 'withdraw_submission', 'author', { withdrawalRequested: true }),
    false
  );
});

test('an editor confirms a withdrawal only once it has been asked for', () => {
  assert.equal(can('in_review', 'confirm_withdrawal', 'editor', {}), false);
  assert.equal(
    can('in_review', 'confirm_withdrawal', 'editor', { withdrawalRequested: true }),
    true
  );
});

test('resubmission is offered only when it is with the authors', () => {
  assert.equal(can('revisions_requested', 'resubmit', 'author'), true);
  assert.equal(can('in_review', 'resubmit', 'author'), false);
});

test('an author is never offered an editor action', () => {
  const authorActions = ACTIONS.filter((a) => a.by === 'author').map((a) => a.id);
  for (const state of QUEUE_ORDER) {
    for (const action of actionsFor(state, 'author')) {
      assert.ok(authorActions.includes(action.id), action.id);
    }
  }
});

/* ── Rounds ─────────────────────────────────────────────────────────────── */

test('rounds are not capped, and the way out is a decision', () => {
  /* Whatever the round, an editor can still decide and an author can still
     be sent back to. A cap would have been the wrong lever. */
  for (const round of [1, 2, 3, 9]) {
    assert.equal(can('in_review', 'to_editorial_review', 'editor', { round }), true);
    assert.equal(can('in_review', 'request_revisions', 'editor', { round }), true);
  }
});

/* ── Labels ─────────────────────────────────────────────────────────────── */

test('every state has both a public and an editor label', () => {
  const states = new Set(ACTIONS.flatMap((a) => [...a.from, a.to]).filter(Boolean));
  for (const state of states) {
    assert.ok(publicLabel[state], `no public label for ${state}`);
    assert.ok(editorLabel[state], `no editor label for ${state}`);
  }
});

test('no public label is a machine name', () => {
  /* "Accepted" legitimately matches its state; "in_review" would not be a
     sentence. The test is that nothing with an underscore in it reaches an
     author, which is the way a raw state actually leaks. */
  for (const [state, label] of Object.entries(publicLabel)) {
    assert.ok(!label.includes('_'), `${state} shows a machine name`);
    assert.match(label, /^[A-Z]/, state);
  }
  assert.notEqual(publicLabel.in_review, 'in_review');
  assert.notEqual(publicLabel.editorial_review, 'editorial_review');
});

test('terminal states are terminal', () => {
  assert.equal(isTerminal('published'), true);
  assert.equal(isTerminal('in_review'), false);
});

/* ── The reviewer form ──────────────────────────────────────────────────── */

test('the review form asks six questions and every key is unique', () => {
  assert.equal(REVIEW_QUESTIONS.length, 6);
  assert.equal(new Set(REVIEW_QUESTIONS.map((q) => q.key)).size, 6);
});

/* ── The two copies agree ───────────────────────────────────────────────── */

test('every action has a function behind it in the migration', () => {
  const sql = fs.readFileSync(
    'supabase/migrations/0001_identity_and_tenancy.sql',
    'utf8'
  );

  /* Three actions are outcomes of one function rather than functions of
     their own, and one is a decision argument. Named here so that adding an
     action without a function still fails. */
  const viaArgument = {
    screen_advance: 'screen_submission',
    screen_return: 'screen_submission',
    screen_decline: 'screen_submission',
    decide_accepted: 'decide_submission',
    decide_declined: 'decide_submission',
  };

  for (const action of ACTIONS) {
    const fn = viaArgument[action.id] ?? action.id;
    assert.ok(
      sql.includes(`create or replace function public.${fn}(`),
      `no SQL function for action ${action.id} (looked for public.${fn})`
    );
  }
});

test('no SQL transition writes a public label the table does not know', () => {
  const sql = fs.readFileSync(
    'supabase/migrations/0001_identity_and_tenancy.sql',
    'utf8'
  );
  const known = new Set(Object.values(publicLabel));
  /* Labels the SQL adds for events that are not state changes. */
  known.add('Withdrawal requested by the authors');
  known.add('Withdrawn by the authors');
  known.add("Withdrawn at the authors' request");

  /* Doubled quotes are how SQL escapes an apostrophe, so a naive [^']+ stops
     in the middle of "the authors'' request" and reports a label nobody
     wrote. */
  const calls = sql.matchAll(
    /app\.move_submission\(\s*[^,]+,\s*'([a-z_]+)',\s*'((?:[^']|'')+)'/g
  );
  let seen = 0;
  for (const [, , label] of calls) {
    seen += 1;
    const written = label.replace(/''/g, "'");
    assert.ok(
      known.has(written),
      `SQL writes public label "${written}" which workflow.ts does not know`
    );
  }
  assert.ok(seen >= 8, `expected the migration to move submissions, saw ${seen} calls`);
});

test('every action has a past tense confirmation', () => {
  for (const action of ACTIONS) {
    assert.ok(actionDone[action.id], `no confirmation phrase for ${action.id}`);
  }
});

test('a confirmation never reads as a generic acknowledgement', () => {
  for (const action of ACTIONS) {
    assert.notEqual(doneLabel(action.id), 'Saved', action.id);
    assert.notEqual(doneLabel(action.id).toLowerCase(), 'done', action.id);
  }
});

test('the manuscript reopens when it comes back to the authors', () => {
  assert.equal(authorMayEdit('revisions_requested'), true);
  assert.equal(authorMayEdit(null), true);
  assert.equal(authorMayEdit('draft'), true);
});

test('and is locked while somebody else is reading it', () => {
  for (const state of ['submitted', 'screening', 'in_review', 'editorial_review']) {
    assert.equal(authorMayEdit(state), false, state);
  }
});

test('and stays locked once it is decided', () => {
  for (const state of ['accepted', 'scheduled', 'exported', 'published', 'declined']) {
    assert.equal(authorMayEdit(state), false, state);
  }
});

test('every state answers the edit question', () => {
  for (const state of Object.keys(publicLabel)) {
    assert.equal(typeof authorMayEdit(state), 'boolean', state);
  }
});

test('every state tells the authors something true about it', () => {
  for (const state of Object.keys(publicLabel)) {
    const line = authorGuidance[state];
    assert.ok(line, `no guidance for ${state}`);
    assert.match(line, /^[A-Z]/, state);
  }
});

test('an accepted submission is not described as under review', () => {
  for (const state of ['accepted', 'scheduled', 'exported', 'published']) {
    assert.doesNotMatch(authorGuidance[state], /review/i, state);
  }
});

console.log(`${passed} workflow assertions passed.`);
