/**
 * WHETHER TO ASK, AND WHAT (dev-156).
 *
 * A pure decision over the person's trail, so the rules are one function
 * with tests rather than a condition on each page. The pages call
 * `survey_history()` for the trail, pass the moment and the audience, and
 * put up whatever comes back; nothing here reads the database.
 *
 * The rules, in the order they are checked:
 *
 *   1. **Sampling.** On the Workbench a card is shown on one eligible page
 *      load in `workbenchOneIn`, decided by a roll the page passes in. A
 *      person cannot feel a schedule they cannot see. After a submission
 *      or feedback the moment is the sample.
 *   2. **Warm-up.** Not before the account is `warmupDays` old, and never
 *      before a first save: week one is about finding the door, and the
 *      questions are about the room.
 *   3. **The cap.** No more than `capPerPerson` showings, ever.
 *   4. **The cooldown.** `cooldownDays` since the last showing, whatever
 *      became of it. `backOffAfterDismissals` dismissals in a row, of
 *      anything, double it: that is what a "don't ask again" box would
 *      have said, heard without the box.
 *   5. **The question.** The first in the bank for this moment and this
 *      audience that is not before its day, that the person has not
 *      answered, and that they have not dismissed `retireAfterDismissals`
 *      times.
 *
 * A showing with no answer and no dismissal (the tab closed) counts toward
 * the cap and starts the cooldown, and is otherwise silent.
 */

import { QUESTIONS, CADENCE, WEEKLY_FROM_WEEKDAY, type Moment, type Audience, type SurveyQuestion } from '../config/survey.ts';
import { dayOf } from './dates.ts';

export interface SurveyEvent {
  question_id: string;
  event: 'shown' | 'answered' | 'dismissed';
  created_at: string;
}

export interface SurveyHistory {
  /** When the account was made. */
  since: string | null;
  /** Whether the person has ever saved a line. */
  saved: boolean;
  /** Oldest first. */
  events: SurveyEvent[];
}

export interface Asking {
  moment: Moment;
  audience: Audience;
  history: SurveyHistory | null;
  now?: Date;
  /** 0 ≤ roll < 1; the Workbench's sample. Ignored elsewhere. */
  roll?: number;
  /** Today in the school's time, YYYY-MM-DD, and the zone; the weekly question needs both. */
  today?: string;
  timezone?: string;
}

const DAY = 24 * 3600 * 1000;

/** Whether this Workbench load is one of the sampled ones. Cheap; ask it before the history. */
export function sampled(moment: Moment, roll: number): boolean {
  if (moment !== 'workbench') return true;
  return roll < 1 / CADENCE.workbenchOneIn;
}

/** How many of the latest outcomes, counting back, were dismissals. */
export function trailingDismissals(events: SurveyEvent[]): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e.event === 'shown') continue;
    if (e.event === 'dismissed') n += 1;
    else break;
  }
  return n;
}

/** ISO weekday of a YYYY-MM-DD, 1 Monday … 7 Sunday. */
export function weekdayOf(day: string): number {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The Monday of the week holding YYYY-MM-DD, as YYYY-MM-DD. */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (weekdayOf(day) - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * The weekly question (dev-157): from Friday to Sunday, once a week — put
 * up on every load until it is answered or put off, because a teacher's
 * tab closed on Friday afternoon is not an answer. Only the day matters;
 * none of the students' rules apply, and a weekly question never counts
 * toward them.
 */
function chooseWeekly(a: Asking, events: SurveyEvent[]): SurveyQuestion | null {
  if (!a.today || !a.timezone) return null;
  if (weekdayOf(a.today) < WEEKLY_FROM_WEEKDAY) return null;
  const monday = mondayOf(a.today);
  const tz = a.timezone;
  for (const q of QUESTIONS) {
    if (q.cadence !== 'weekly' || q.moment !== a.moment || q.audience !== a.audience) continue;
    /* Settled on a day of this week, in the school's time: a Sunday-evening
       answer is this week's, not Monday's in UTC. */
    const settledThisWeek = events.some((e) => e.question_id === q.id && e.event !== 'shown' && dayOf(e.created_at, tz) >= monday);
    if (!settledThisWeek) return q;
  }
  return null;
}

/** Whether a weekly question was already put up this week, so the showing is recorded once a week. */
export function shownThisWeek(events: SurveyEvent[], questionId: string, today: string, timezone: string): boolean {
  const monday = mondayOf(today);
  return events.some((e) => e.question_id === questionId && e.event === 'shown' && dayOf(e.created_at, timezone) >= monday);
}

export function chooseQuestion(a: Asking): SurveyQuestion | null {
  const now = a.now ?? new Date();
  const roll = a.roll ?? Math.random();
  const h = a.history;
  if (!h) return null;
  if (a.audience === 'teacher') return chooseWeekly(a, h.events);
  if (!sampled(a.moment, roll)) return null;
  if (!h.since || !h.saved) return null;

  const days = (now.getTime() - Date.parse(h.since)) / DAY;
  if (!(days >= CADENCE.warmupDays)) return null;

  const weekly = new Set(QUESTIONS.filter((q) => q.cadence === 'weekly').map((q) => q.id));
  const events = [...h.events].filter((e) => !weekly.has(e.question_id)).sort((x, y) => Date.parse(x.created_at) - Date.parse(y.created_at));
  const shown = events.filter((e) => e.event === 'shown');
  if (shown.length >= CADENCE.capPerPerson) return null;

  const last = shown.length ? Date.parse(shown[shown.length - 1].created_at) : null;
  const cooldown = CADENCE.cooldownDays * (trailingDismissals(events) >= CADENCE.backOffAfterDismissals ? 2 : 1);
  if (last != null && now.getTime() - last < cooldown * DAY) return null;

  const answered = new Set(events.filter((e) => e.event === 'answered').map((e) => e.question_id));
  const dismissed = new Map<string, number>();
  for (const e of events) if (e.event === 'dismissed') dismissed.set(e.question_id, (dismissed.get(e.question_id) ?? 0) + 1);

  for (const q of QUESTIONS) {
    if (q.cadence === 'weekly' || q.moment !== a.moment || q.audience !== a.audience) continue;
    if (q.notBeforeDay != null && days < q.notBeforeDay) continue;
    if (answered.has(q.id)) continue;
    if ((dismissed.get(q.id) ?? 0) >= CADENCE.retireAfterDismissals) continue;
    return q;
  }
  return null;
}

/** The trail as `survey_history()` returns it, or nothing the rules can use. */
export function historyFrom(data: unknown): SurveyHistory | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const events = Array.isArray(d.events) ? (d.events as SurveyEvent[]).filter((e) => e && typeof e.question_id === 'string' && typeof e.created_at === 'string') : [];
  return { since: typeof d.since === 'string' ? d.since : null, saved: Boolean(d.saved), events };
}

/**
 * A survey answer, and how it is read for the report: `shown` is the
 * denominator, `answered` the numerator, `dismissed` the cost.
 */
export function tally(events: { question_id: string; event: string; answer?: number | null }[]) {
  const by = new Map<string, { shown: number; answered: number; dismissed: number; answers: Record<'1' | '2' | '3', number> }>();
  for (const e of events) {
    const row = by.get(e.question_id) ?? { shown: 0, answered: 0, dismissed: 0, answers: { '1': 0, '2': 0, '3': 0 } };
    if (e.event === 'shown') row.shown += 1;
    else if (e.event === 'answered') { row.answered += 1; if (e.answer === 1 || e.answer === 2 || e.answer === 3) row.answers[String(e.answer) as '1' | '2' | '3'] += 1; }
    else if (e.event === 'dismissed') row.dismissed += 1;
    by.set(e.question_id, row);
  }
  return by;
}
