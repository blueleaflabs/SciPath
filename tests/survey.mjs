/**
 * THE SURVEY: ONE QUESTION, RARELY (dev-156).
 *
 * Asserted: the rules — sampling, warm-up, cap, cooldown with back-off,
 * once per question, retirement after dismissals, the bank's order and
 * each question's day; 0002 adds and only adds, and no session writes the
 * table; the one card is used by both surfaces and posts to the one route,
 * which records through the one function and sends the person back only
 * inside the app; the report counts shown, answered and dismissed and
 * never a line; and the deeper measures from dev-155 are still in the file.
 *
 * Run: npm run test:survey
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chooseQuestion, sampled, trailingDismissals, historyFrom, tally, weekdayOf, mondayOf, shownThisWeek } from '../src/lib/survey.ts';
import { QUESTIONS, CADENCE, questionById } from '../src/config/survey.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const DAY = 24 * 3600 * 1000;
const now = new Date('2026-09-25T17:00:00Z');
const ago = (days) => new Date(now.getTime() - days * DAY).toISOString();
const fresh = (days = 10) => ({ since: ago(days), saved: true, events: [] });
const ask = (moment, audience, history, extra = {}) => chooseQuestion({ moment, audience, history, now, roll: 0, ...extra });

test('the bank is well formed: unique ids, three answers on every scale, a moment and an audience each', () => {
  assert.equal(new Set(QUESTIONS.map((q) => q.id)).size, QUESTIONS.length);
  for (const q of QUESTIONS) {
    assert.match(q.id, /^[a-z0-9_]{1,40}$/);
    assert.ok(['after_submit', 'after_feedback', 'workbench'].includes(q.moment));
    assert.ok(['student', 'elder', 'teacher'].includes(q.audience));
    if (q.kind === 'scale') assert.deepEqual(q.answers.map((a) => a.value), [3, 2, 1]);
    else assert.equal(q.answers, undefined);
    if (q.audience === 'teacher') assert.equal(q.cadence, 'weekly', 'a teacher is asked weekly or not at all');
  }
  assert.equal(questionById('nope'), null);
  assert.equal(questionById('know_next')?.moment, 'workbench');
});

test('the Workbench is sampled, the moments are not', () => {
  assert.equal(sampled('workbench', 0), true);
  assert.equal(sampled('workbench', 1 / CADENCE.workbenchOneIn), false);
  assert.equal(sampled('workbench', 0.99), false);
  assert.equal(sampled('after_submit', 0.99), true);
  assert.equal(ask('workbench', 'student', fresh(), { roll: 0.9 }), null);
  assert.equal(ask('workbench', 'student', fresh())?.id, 'know_next');
});

test('the warm-up: no account date, no save, or fewer than three days — nothing', () => {
  assert.equal(ask('after_submit', 'student', null), null);
  assert.equal(ask('after_submit', 'student', { since: null, saved: true, events: [] }), null);
  assert.equal(ask('after_submit', 'student', { since: ago(10), saved: false, events: [] }), null);
  assert.equal(ask('after_submit', 'student', fresh(2.9)), null);
  assert.equal(ask('after_submit', 'student', fresh(3))?.id, 'submit_easier');
});

test('the right question for the moment and the audience, and none for a teacher-shaped ask', () => {
  assert.equal(ask('after_submit', 'student', fresh())?.id, 'submit_easier');
  assert.equal(ask('after_submit', 'elder', fresh()), null);
  assert.equal(ask('after_feedback', 'elder', fresh())?.id, 'review_easy');
  assert.equal(ask('after_feedback', 'student', fresh()), null);
  assert.equal(ask('workbench', 'elder', fresh())?.id, 'waiting_clear');
});

test('the cap: six showings and the person is never asked again', () => {
  const events = Array.from({ length: CADENCE.capPerPerson }, (_, i) => ({ question_id: `q${i}`, event: 'shown', created_at: ago(100 - i * 10) }));
  assert.equal(ask('after_submit', 'student', { since: ago(200), saved: true, events }), null);
  assert.equal(ask('after_submit', 'student', { since: ago(200), saved: true, events: events.slice(1) })?.id, 'submit_easier');
});

test('the cooldown: seven days from the last showing, whatever became of it', () => {
  const shownAt = (d, outcome) => ({ since: ago(60), saved: true, events: [{ question_id: 'know_next', event: 'shown', created_at: ago(d) }, ...(outcome ? [{ question_id: 'know_next', event: outcome, created_at: ago(d) }] : [])] });
  assert.equal(ask('after_submit', 'student', shownAt(6.9, 'answered')), null);
  assert.equal(ask('after_submit', 'student', shownAt(6.9, 'dismissed')), null);
  assert.equal(ask('after_submit', 'student', shownAt(6.9, null)), null, 'a showing nobody touched still starts the cooldown');
  assert.equal(ask('after_submit', 'student', shownAt(7.1, 'answered'))?.id, 'submit_easier');
});

test('once per question: an answered question is never asked again; the next in the bank comes up on its day', () => {
  const h = { since: ago(60), saved: true, events: [
    { question_id: 'know_next', event: 'shown', created_at: ago(30) },
    { question_id: 'know_next', event: 'answered', created_at: ago(30) },
  ] };
  assert.equal(ask('workbench', 'student', h)?.id, 'vs_without', 'day 60: the comparison is due');
  assert.equal(ask('workbench', 'student', { ...h, since: ago(10) }), null, 'day 10: the comparison waits for day 14, and nothing else is left');
  assert.equal(ask('workbench', 'student', { ...h, since: ago(21) })?.id, 'vs_without');
  const later = { ...h, events: [...h.events, { question_id: 'vs_without', event: 'shown', created_at: ago(20) }, { question_id: 'vs_without', event: 'answered', created_at: ago(20) }] };
  assert.equal(ask('workbench', 'student', later)?.id, 'one_change', 'day 60: the open line');
  assert.equal(ask('workbench', 'student', { ...later, since: ago(25) })?.id, 'one_change');
  assert.equal(ask('workbench', 'student', { ...later, since: ago(20.5) }), null, 'the open line waits for day 21');
});

test('dismissals: two of one question retire it; three in a row double the cooldown', () => {
  const twice = { since: ago(60), saved: true, events: [
    { question_id: 'know_next', event: 'shown', created_at: ago(40) }, { question_id: 'know_next', event: 'dismissed', created_at: ago(40) },
    { question_id: 'know_next', event: 'shown', created_at: ago(30) }, { question_id: 'know_next', event: 'dismissed', created_at: ago(30) },
  ] };
  assert.equal(trailingDismissals(twice.events), 2);
  assert.equal(ask('workbench', 'student', twice)?.id, 'vs_without', 'know_next is retired for this person');
  const thrice = { ...twice, events: [...twice.events, { question_id: 'vs_without', event: 'shown', created_at: ago(10) }, { question_id: 'vs_without', event: 'dismissed', created_at: ago(10) }] };
  assert.equal(trailingDismissals(thrice.events), 3);
  assert.equal(ask('workbench', 'student', thrice), null, 'ten days is inside a doubled cooldown');
  const calm = { ...thrice, events: thrice.events.map((e) => ({ ...e, created_at: e.created_at === ago(10) ? ago(15) : e.created_at })) };
  assert.equal(ask('workbench', 'student', calm)?.id, 'vs_without', 'fifteen days is past it, and the once-dismissed question may be asked again');
  const answeredLast = { ...thrice, events: [...thrice.events, { question_id: 'one_change', event: 'shown', created_at: ago(8) }, { question_id: 'one_change', event: 'answered', created_at: ago(8) }] };
  assert.equal(trailingDismissals(answeredLast.events), 0, 'an answer ends the run');
});

test('the weekly question (dev-157): from Friday, once a week, on every load until settled, outside every other rule', () => {
  const TZ = 'America/Los_Angeles';
  assert.equal(weekdayOf('2026-09-11'), 5); assert.equal(weekdayOf('2026-09-13'), 7); assert.equal(mondayOf('2026-09-13'), '2026-09-07');
  const teacher = (today, events = []) => chooseQuestion({ moment: 'workbench', audience: 'teacher', history: { since: null, saved: false, events }, today, timezone: TZ, roll: 0.99 });
  assert.equal(teacher('2026-09-10'), null, 'Thursday: not yet');
  assert.equal(teacher('2026-09-11')?.id, 'teacher_minutes', 'Friday, with no warm-up, no save and a failed roll');
  assert.equal(teacher('2026-09-13')?.id, 'teacher_minutes', 'Sunday still');
  const shown = [{ question_id: 'teacher_minutes', event: 'shown', created_at: '2026-09-11T20:00:00Z' }];
  assert.equal(teacher('2026-09-12', shown)?.id, 'teacher_minutes', 'a showing alone does not settle the week');
  assert.equal(shownThisWeek(shown, 'teacher_minutes', '2026-09-12', TZ), true);
  assert.equal(shownThisWeek(shown, 'teacher_minutes', '2026-09-19', TZ), false);
  const answered = [...shown, { question_id: 'teacher_minutes', event: 'answered', created_at: '2026-09-11T21:00:00Z' }];
  assert.equal(teacher('2026-09-12', answered), null, 'answered this week');
  assert.equal(teacher('2026-09-18', answered)?.id, 'teacher_minutes', 'next Friday it is back');
  const putOff = [...shown, { question_id: 'teacher_minutes', event: 'dismissed', created_at: '2026-09-11T21:00:00Z' }];
  assert.equal(teacher('2026-09-13', putOff), null, 'put off for the week');
  /* Sunday 6 pm Pacific is Monday 01:00 UTC: the school's day decides. */
  const sundayEvening = [...shown, { question_id: 'teacher_minutes', event: 'answered', created_at: '2026-09-14T01:00:00Z' }];
  assert.equal(teacher('2026-09-18', sundayEvening)?.id, 'teacher_minutes', 'a Sunday-evening answer belongs to the week before');
  assert.equal(chooseQuestion({ moment: 'workbench', audience: 'teacher', history: { since: null, saved: false, events: [] }, today: '2026-09-11' }), null);
  /* A teacher's weekly rows never count toward a student's cap or cooldown. */
  const student = { since: ago(60), saved: true, events: Array.from({ length: 8 }, (_, i) => ({ question_id: 'teacher_minutes', event: 'shown', created_at: ago(i) })) };
  assert.equal(ask('workbench', 'student', student)?.id, 'know_next');
});

test('the trail from the database is read defensively, and the tally reads shown as the denominator', () => {
  assert.equal(historyFrom(null), null);
  assert.deepEqual(historyFrom({ since: ago(1), saved: 'yes', events: [{ question_id: 'x', event: 'shown', created_at: ago(1) }, { bad: true }] }), { since: ago(1), saved: true, events: [{ question_id: 'x', event: 'shown', created_at: ago(1) }] });
  const t = tally([
    { question_id: 'a', event: 'shown' }, { question_id: 'a', event: 'answered', answer: 3 },
    { question_id: 'a', event: 'shown' }, { question_id: 'a', event: 'dismissed' },
    { question_id: 'a', event: 'shown' },
    { question_id: 'b', event: 'shown' }, { question_id: 'b', event: 'answered', answer: null },
  ]);
  assert.deepEqual(t.get('a'), { shown: 3, answered: 1, dismissed: 1, answers: { '1': 0, '2': 0, '3': 1 } });
  assert.deepEqual(t.get('b'), { shown: 1, answered: 1, dismissed: 0, answers: { '1': 0, '2': 0, '3': 0 } });
});

test('0002 adds the table, the trail and the recorder, and lets no session write the table; the pulse draft is gone', () => {
  assert.ok(!fs.existsSync('supabase/migrations/0002_pulses.sql'));
  const sql = fs.readFileSync('supabase/migrations/0002_survey.sql', 'utf8');
  assert.match(sql, /create table public\.survey_events/);
  assert.match(sql, /create or replace function public\.survey_history\(\)/);
  assert.match(sql, /create or replace function public\.record_survey_event/);
  assert.match(sql, /grant insert on public\.survey_events to service_role;/);
  assert.doesNotMatch(sql, /grant insert on public\.survey_events to authenticated/);
  assert.match(sql, /event\s+text not null check \(event in \('shown', 'answered', 'dismissed'\)\)/);
  assert.match(sql, /length\(comment\) <= 240/);
  assert.match(sql, /survey_events_answer_shape/);
  assert.match(sql, /answer between 0 and 9999/);
  assert.doesNotMatch(sql, /\bpulses?\b/i, 'the old name is not in the new file');
  /* The days anybody wrote (dev-157): a rollup no session writes, filled by a trigger, backfilled once. */
  assert.match(sql, /create table public\.activity_days/);
  assert.match(sql, /create trigger document_field_history_roll_activity\s+after insert on public\.document_field_history/);
  assert.doesNotMatch(sql, /grant insert on public\.activity_days/);
  assert.match(sql, /on conflict \(user_id, project_id, day\) do update/);
  assert.match(sql, /on conflict \(user_id, project_id, day\) do nothing/);
});

test('one card, two surfaces, one route, one function', () => {
  const card = fs.readFileSync('src/components/SurveyCard.astro', 'utf8');
  assert.match(card, /action="\/app\/api\/survey\/"/);
  assert.match(card, /name="event" value="dismissed" formnovalidate>\{question\.cadence === 'weekly' \? 'Not this week' : 'Not now'\}<\/button>/);
  assert.doesNotMatch(card, /checkbox/, 'no "do not show again" box');
  assert.match(card, /name="answer" value=\{String\(a\.value\)\}/);
  assert.match(card, /type="number" inputmode="numeric" min="0" max=\{NUMBER_MAX\}/);
  const cls = fs.readFileSync('src/pages/app/program/[id]/class.astro', 'utf8');
  assert.match(cls, /<SurveyCard question=\{survey\} back=\{Astro\.url\.pathname\}/);
  assert.match(cls, /audience: 'teacher', history, today, timezone: org\.timezone/);
  assert.match(cls, /!shownThisWeek\(history\.events, survey\.id, today, org\.timezone\)/);
  const doc = fs.readFileSync('src/pages/app/project/[id]/doc/[deliverable].astro', 'utf8');
  const bench = fs.readFileSync('src/pages/app/index.astro', 'utf8');
  for (const page of [doc, bench]) {
    assert.match(page, /<SurveyCard question=\{survey\}/);
    assert.match(page, /supabase\.rpc\('survey_history'\)/);
    assert.match(page, /p_event: 'shown'/);
    assert.doesNotMatch(page, /record_pulse|from\('pulses'\)/);
  }
  assert.match(doc, /ask = 'submitted'/);
  assert.match(doc, /ask = 'reviewed'/);
  assert.match(doc, /&& !me\.isAdvisor\) \{/, 'a teacher is never asked on the document page');
  assert.match(bench, /Astro\.request\.method === 'GET' && !me\.isAdvisor/);
  assert.match(bench, /sampled\('workbench', roll\)/);
  const route = fs.readFileSync('src/pages/app/api/survey.ts', 'utf8');
  assert.match(route, /supabase\.rpc\('record_survey_event'/);
  assert.match(route, /q\.kind === 'number' \? \(Number\.isInteger\(answerRaw\) && answerRaw >= 0 && answerRaw <= NUMBER_MAX/);
  assert.match(route, /raw\.startsWith\('\/app\/'\)/);
  assert.match(route, /status: 303/);
  assert.doesNotMatch(route, /error\.message\s*\}\)\s*\);\s*return new Response\(JSON/, 'a refusal is logged, never shown');
  const cache = fs.readFileSync('src/lib/context-cache.ts', 'utf8');
  assert.match(cache, /'\/app\/api\/survey\/'/);
});

test('the report counts shown, answered and dismissed and never a line; the deeper measures are in the file', () => {
  const src = fs.readFileSync('scripts/pilot-report.mjs', 'utf8');
  assert.match(src, /from\('survey_events'\)/);
  assert.match(src, /response_rate: shown \? Math\.round\(\(answered \/ shown\) \* 100\) : null/);
  assert.match(src, /with_a_line: count\(mine, \(x\) => x\.event === 'answered' && x\.comment\)/);
  assert.doesNotMatch(src, /comment: x\.comment|comments: rows|from\('pulses'\)/);
  for (const key of ['week:', 'feedback_loop:', 'hours:', 'interviews:', 'survey:', 'median_hours_to_first_feedback', 'revised_within_48h', 'saves_outside_class_today', 'at_least_3', 'people_asked', 'teacher_minutes:', 'stale:', 'student_response:', 'reminders:', "from('activity_days')", "from('notifications')", 'median_hours_to_next_save', 'share_of_projects']) {
    assert.ok(src.includes(key), `report lacks ${key}`);
  }
  const reset = fs.readFileSync('scripts/reset-cloud.mjs', 'utf8');
  assert.match(reset, /'survey_events',/);
  assert.match(reset, /'activity_days',/);
});

console.log(`  ${passed} passed`);
