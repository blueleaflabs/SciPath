/**
 * THE VERDICT IS THE ORDER, NOT A COLUMN.
 *
 * `assess()` always knew which projects were lost, which needed somebody and
 * which were fine. The advisor screen computed that and rendered it as the
 * eighth column, so the most important fact about a row arrived after six
 * columns of bookkeeping.
 *
 * `queueRank` is that verdict turned into a sort. This is the ordering it
 * has to produce, written down apart from the page so it can be wrong in one
 * place rather than argued about in markup.
 *
 * Run: npm run test:queue
 */

import assert from 'node:assert/strict';
import { queueRank, daysUntil } from '../src/lib/attention.ts';

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

const lost = { level: 'disqualifying', reason: 'Work began before approval', reasons: ['x'] };
const needs = { level: 'attention', reason: 'No teacher sponsor', reasons: ['x'] };
const fine = { level: 'ok', reason: null, reasons: [] };

const row = (verdict, daysToNext) => ({ verdict, daysToNext });

test('a disqualification sorts above everything', () => {
  /* It cannot be undone, so nothing anybody does today outranks knowing
     about it. */
  assert.ok(queueRank(row(lost, 400)) < queueRank(row(needs, -99)));
  assert.ok(queueRank(row(lost, null)) < queueRank(row(needs, 0)));
});

test('in order sorts below everything that needs somebody', () => {
  assert.ok(queueRank(row(fine, -50)) > queueRank(row(needs, 898)));
  assert.ok(queueRank(row(fine, null)) > queueRank(row(needs, null)));
});

test('overdue sorts above due soon, which sorts above due later', () => {
  /* The fact the old table never showed. `Next: Form 1` read identically
     whether it was sixty days out or six days late. */
  const order = [
    row(needs, -6),
    row(needs, 0),
    row(needs, 3),
    row(needs, 60),
  ].map(queueRank);

  assert.deepEqual([...order].sort((a, b) => a - b), order, 'not in ascending order');
});

test('an undated obligation sorts last within its band', () => {
  /* A step nobody has scheduled is not the next thing to worry about.
     Treating null as urgent fills the top of the screen with things that are
     not due at all — which is the failure that makes somebody stop reading
     the top of the screen. */
  assert.ok(queueRank(row(needs, null)) > queueRank(row(needs, 500)));
  assert.ok(queueRank(row(needs, null)) < queueRank(row(fine, 0)));
});

test('an absurd date cannot reorder the screen', () => {
  /* Clamped, because a rank that depends on a date being sensible is a rank
     that reshuffles the first time somebody types 2207 instead of 2027. A
     far-future deadline must not fall through into the in-order band, and a
     decade-overdue fixture must not outrank a disqualification. */
  assert.ok(queueRank(row(needs, 99999)) < queueRank(row(fine, 0)));
  assert.ok(queueRank(row(needs, -99999)) > queueRank(row(lost, 0)));
});

test('days until counts whole days from a date, not from a moment', () => {
  /* Both sides truncated to a day. Comparing a date column against a
     timestamp makes "due today" read as overdue for most of the day, which
     shows up as a teacher chasing somebody who has until midnight. */
  assert.equal(daysUntil('2026-11-13', '2026-11-13'), 0);
  assert.equal(daysUntil('2026-11-14', '2026-11-13'), 1);
  assert.equal(daysUntil('2026-11-06', '2026-11-13'), -7);
  assert.equal(daysUntil(null, '2026-11-13'), null);
  assert.equal(daysUntil('not a date', '2026-11-13'), null);
});

test('a month boundary is still whole days', () => {
  /* Arithmetic on month numbers is where this kind of helper usually
     breaks. */
  assert.equal(daysUntil('2026-12-01', '2026-11-30'), 1);
  assert.equal(daysUntil('2027-01-01', '2026-12-31'), 1);
  assert.equal(daysUntil('2027-03-01', '2027-02-28'), 1);
});

console.log(`\n${passed} queue assertions passed.`);
