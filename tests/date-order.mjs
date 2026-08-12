/**
 * Tests for the date ordering check.
 *
 * Written before the interface around it, because this is the piece the whole
 * system is justified by: a good project disqualified on a date comparison
 * that software could have caught in September.
 *
 * Run: npm run test:dates
 */

import assert from 'node:assert/strict';
import { checkDateOrder, worstFinding } from '../src/lib/dateOrder.ts';
import { arrivedAt } from '../src/lib/dates.ts';

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

const approval = (over) => ({
  id: 'sponsor',
  name: 'Teacher sponsor confirmed',
  dueOn: '2026-10-16',
  completedOn: null,
  blocksExperimentation: true,
  required: true,
  ...over,
});

test('work started before the approval is disqualifying', () => {
  const f = checkDateOrder({
    startedOn: '2026-09-01',
    obligations: [approval({ completedOn: '2026-10-14' })],
    today: '2026-10-20',
  });
  assert.equal(f[0].severity, 'disqualifying');
  assert.match(f[0].message, /43 days before/);
});

test('work started after the approval is fine', () => {
  const f = checkDateOrder({
    startedOn: '2026-10-20',
    obligations: [approval({ completedOn: '2026-10-14' })],
    today: '2026-10-25',
  });
  assert.equal(f.length, 0);
});

test('same day counts as in order', () => {
  const f = checkDateOrder({
    startedOn: '2026-10-14',
    obligations: [approval({ completedOn: '2026-10-14' })],
    today: '2026-10-20',
  });
  assert.equal(f.length, 0);
});

test('work started with no approval at all is disqualifying', () => {
  const f = checkDateOrder({
    startedOn: '2026-09-01',
    obligations: [approval()],
    today: '2026-09-20',
  });
  assert.equal(f[0].severity, 'disqualifying');
});

test('a start date in the future is a plan, not a disqualification', () => {
  const f = checkDateOrder({
    startedOn: '2026-08-30',
    obligations: [approval()],
    today: '2026-08-03',
  });
  assert.equal(f[0].severity, 'planned');
  assert.match(f[0].message, /27 days/);
  assert.ok(!f.some((x) => x.severity === 'disqualifying'));
});

test('starting today counts as started', () => {
  const f = checkDateOrder({
    startedOn: '2026-08-03',
    obligations: [approval()],
    today: '2026-08-03',
  });
  assert.equal(f[0].severity, 'disqualifying');
});

test('a plan that starts before a signature already given is flagged', () => {
  const f = checkDateOrder({
    startedOn: '2026-09-01',
    obligations: [approval({ completedOn: '2026-09-10' })],
    today: '2026-08-03',
  });
  assert.equal(f[0].severity, 'planned');
  assert.match(f[0].message, /2026-09-10/);
});

test('a plan that starts after the signature is clean', () => {
  const f = checkDateOrder({
    startedOn: '2026-09-20',
    obligations: [approval({ completedOn: '2026-09-10' })],
    today: '2026-08-03',
  });
  assert.equal(f.length, 0);
});

test('no start date means no ordering problem yet', () => {
  const f = checkDateOrder({
    startedOn: null,
    obligations: [approval()],
    today: '2026-09-20',
  });
  assert.ok(f.every((x) => x.severity !== 'disqualifying'));
});

test('an overdue obligation is urgent', () => {
  const f = checkDateOrder({
    startedOn: null,
    obligations: [
      { id: 'a', name: 'Proposal deadline', dueOn: '2026-10-23',
        completedOn: null, blocksExperimentation: false, required: true },
    ],
    today: '2026-10-30',
  });
  assert.equal(f[0].severity, 'urgent');
  assert.match(f[0].message, /7 days ago/);
});

test('within a fortnight is due, beyond it is silent', () => {
  const near = checkDateOrder({
    startedOn: null,
    obligations: [
      { id: 'a', name: 'Proposal deadline', dueOn: '2026-10-23',
        completedOn: null, blocksExperimentation: false, required: true },
    ],
    today: '2026-10-15',
  });
  assert.equal(near[0].severity, 'due');

  const far = checkDateOrder({
    startedOn: null,
    obligations: [
      { id: 'a', name: 'Proposal deadline', dueOn: '2026-10-23',
        completedOn: null, blocksExperimentation: false, required: true },
    ],
    today: '2026-09-01',
  });
  assert.equal(far.length, 0);
});

test('a completed obligation is never reported', () => {
  const f = checkDateOrder({
    startedOn: null,
    obligations: [
      { id: 'a', name: 'Proposal deadline', dueOn: '2026-10-23',
        completedOn: '2026-10-20', blocksExperimentation: false, required: true },
    ],
    today: '2026-11-30',
  });
  assert.equal(f.length, 0);
});

test('optional obligations are ignored', () => {
  const f = checkDateOrder({
    startedOn: null,
    obligations: [
      { id: 'a', name: 'Optional survey', dueOn: '2026-10-01',
        completedOn: null, blocksExperimentation: false, required: false },
    ],
    today: '2026-11-30',
  });
  assert.equal(f.length, 0);
});

test('a signature date overrides a tick', () => {
  /* The obligation was ticked complete on a date that would be fine, but the
     form itself was signed after work began. The form is what counts. */
  const f = checkDateOrder({
    startedOn: '2026-09-01',
    obligations: [approval({ completedOn: '2026-08-01', signedOn: '2026-10-14' })],
    today: '2026-10-20',
  });
  assert.equal(f[0].severity, 'disqualifying');
  assert.match(f[0].message, /43 days/);
});

test('a signature earlier than the tick also wins', () => {
  const f = checkDateOrder({
    startedOn: '2026-09-01',
    obligations: [approval({ completedOn: '2026-10-14', signedOn: '2026-08-20' })],
    today: '2026-10-20',
  });
  assert.equal(f.length, 0);
});

test('the worst finding sorts to the front', () => {
  const f = checkDateOrder({
    startedOn: '2026-09-01',
    obligations: [
      { id: 'a', name: 'Proposal deadline', dueOn: '2026-10-23',
        completedOn: null, blocksExperimentation: false, required: true },
      approval({ completedOn: '2026-10-14' }),
    ],
    today: '2026-10-30',
  });
  assert.equal(worstFinding(f).severity, 'disqualifying');
});

test('no obligations means nothing to say', () => {
  assert.equal(
    checkDateOrder({ startedOn: '2026-09-01', obligations: [], today: '2026-10-30' }).length,
    0
  );
});

/* ── When something arrived ─────────────────────────────────────────────── */

/** A time on a day relative to today, in the machine's own zone. */
const at = (hour, minute, dayOffset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

test('today carries a clock', () => {
  /* The hour is the part that distinguishes two submissions on one morning,
     and "today" alone hid it.
   
     The space before AM is `\s` rather than a literal, because `toLocaleTimeString`
     puts a narrow no-break space there in a browser and an ordinary space
     under node's ICU build. Pinning either one makes this pass in the place
     it runs and describe something the reader never sees. */
  assert.match(arrivedAt(at(9, 5)), /^today, 9:05\sAM$/);
  assert.match(arrivedAt(at(17, 32)), /^today, 5:32\sPM$/);
});

test('today means the calendar day, not the last 24 hours', () => {
  /* The boundaries are where this goes wrong. One minute past midnight is
     today; one minute to midnight is today; eleven last night is not, even
     though it is well within a rolling day. */
  assert.match(arrivedAt(at(0, 1)), /^today, /);
  assert.match(arrivedAt(at(23, 59)), /^today, /);
  assert.doesNotMatch(arrivedAt(at(23, 0, -1)), /today/);
});

test('any other day is a date, not a duration', () => {
  /* "3 days" told an editor how long it had waited rather than when it
     landed. By then the hour has stopped mattering. */
  assert.match(arrivedAt(at(14, 0, -3)), /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  assert.match(arrivedAt(at(0, 30, 1)), /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
});

test('nothing renders as nothing', () => {
  assert.equal(arrivedAt(null), '');
  assert.equal(arrivedAt(undefined), '');
});

console.log(`${passed} date ordering assertions passed.`);
