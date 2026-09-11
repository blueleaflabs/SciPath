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
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { checkDateOrder, worstFinding } from '../src/lib/dateOrder.ts';
import { arrivedAt, dayOf, daysFrom } from '../src/lib/dates.ts';

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

test('the day a timestamp fell on is the school\'s day, and a bare date is left alone (2.9)', () => {
  /* 7 September, 11 pm in Cupertino is 8 September, 06:00 UTC. */
  assert.equal(dayOf('2026-09-08T06:00:00+00:00', 'America/Los_Angeles'), '2026-09-07');
  assert.equal(dayOf('2026-09-08T06:00:00Z', 'America/Los_Angeles'), '2026-09-07');
  /* The same instant as the database now writes it. */
  assert.equal(dayOf('2026-09-07T23:00:00-07:00', 'America/Los_Angeles'), '2026-09-07');
  /* A date column has no instant: converting it would move it a day. */
  assert.equal(dayOf('2026-09-10', 'America/Los_Angeles'), '2026-09-10');
  assert.equal(dayOf(null, 'America/Los_Angeles'), '');
  assert.equal(dayOf(new Date('2026-09-08T06:00:00Z'), 'America/Los_Angeles'), '2026-09-07');
  /* And the migration keeps the database on the school's clock, so the
     first ten characters are right even where a page still slices. */
  const fs = require('node:fs');
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');
  assert.match(sql, /alter database %I set timezone = %L', current_database\(\), 'America\/Los_Angeles'/);
});

test('days from today are counted on the school\'s calendar, not the server\'s (dev-153)', () => {
  /* Eleven at night on September 10 in Cupertino is already September 11
     in UTC, where the Worker's clock runs. A deliverable due the 10th is
     due today there, not a day late. */
  const lateEvening = new Date('2026-09-11T06:30:00Z');
  assert.equal(daysFrom('2026-09-10', 'America/Los_Angeles', lateEvening), 0);
  assert.equal(daysFrom('2026-09-21', 'America/Los_Angeles', lateEvening), 11);
  assert.equal(daysFrom('2026-09-09', 'America/Los_Angeles', lateEvening), -1);
  /* A timestamp is placed on the day it falls on there. */
  assert.equal(daysFrom('2026-09-11T05:00:00Z', 'America/Los_Angeles', lateEvening), 0);
  /* The page passes the school's zone. */
  const page = require('node:fs').readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  assert.match(page, /daysFrom\(iso, org\.timezone, now\)/);
});

console.log(`${passed} date ordering assertions passed.`);
