/**
 * WHAT NEEDS ATTENTION, AND WHAT IS ALREADY LOST.
 *
 * Two counters on the club screens, and they were measuring the same thing
 * badly. A project registered five minutes ago has no sponsor, no officer,
 * and no start date, which is exactly the state somebody should look at, and
 * it was being reported as "in order".
 *
 *   DISQUALIFYING   already true and cannot be undone. Work began before an
 *                   approval that had to precede it. The number that should
 *                   stay at zero.
 *
 *   NEEDS ATTENTION anything that will become a problem if nobody acts. A
 *                   missing sponsor, no officer looking after it, no start
 *                   date recorded, an obligation overdue or close, or a
 *                   planned start that precedes an approval.
 *
 * A project is counted in exactly one of them, worst first, so the two
 * numbers add up rather than overlapping.
 */

import type { Finding } from './dateOrder';

export interface ProjectState {
  worst: Finding | null;
  hasOfficer: boolean;
  hasSponsor: boolean;
  startedOn: string | null;
  obligationsDone: number;
  obligationsTotal: number;
}

export type Attention = 'disqualifying' | 'attention' | 'ok';

export interface Verdict {
  level: Attention;
  /** The most useful thing to say, or null when in order. */
  reason: string | null;
  /** Everything true of it, worst first. `reason` is the first of these. */
  reasons: string[];
}

/**
 * Every reason, not the first one.
 *
 * This returned at the first thing it found, so a project with no sponsor
 * *and* no officer read as "No teacher sponsor" — and somebody who fixed
 * that came back to a row that still said something was wrong, having been
 * told about one of two problems and left to discover the other.
 *
 * A disqualification is still the whole answer on its own. It cannot be
 * undone, so what else is missing is not the next thing anybody does.
 */
export function assess(p: ProjectState): Verdict {
  if (p.worst?.severity === 'disqualifying') {
    return {
      level: 'disqualifying',
      reason: p.worst.name,
      reasons: [p.worst.name],
    };
  }

  const reasons: string[] = [];

  if (!p.hasSponsor) reasons.push('No teacher sponsor');
  if (!p.hasOfficer) reasons.push('No club officer');
  if (!p.startedOn) reasons.push('No start date');
  if (p.worst) reasons.push(p.worst.name);

  if (reasons.length === 0) return { level: 'ok', reason: null, reasons: [] };

  return { level: 'attention', reason: reasons[0], reasons };
}

/**
 * WHERE A ROW BELONGS IN THE QUEUE.
 *
 * **The verdict was a column, and it was the eighth one.**
 *
 * `assess()` has always known which projects are lost, which need somebody,
 * and which are fine. The screen computed that and then rendered it as a cell
 * near the right-hand edge, after Project, Students, Elder, Sponsor, Next and
 * Notebook. A teacher scanning left to right met four columns of bookkeeping
 * before she met the fact that a project could no longer be entered.
 *
 * So the verdict stops being something to read and becomes the order things
 * are read in. Lower sorts first.
 *
 *   0-99      disqualifying. Cannot be undone, and she has to know.
 *   100-999   needs somebody, ordered by how little time is left.
 *   1000+     in order.
 *
 * Within the middle band the key is **days remaining**, so overdue sorts
 * above due-tomorrow and both sort above due-in-June. That is the one fact
 * the old table never showed: `Next: Form 1` said the same thing whether it
 * was sixty days out or six days late.
 *
 * An obligation with no date sorts last inside its band rather than first.
 * A step nobody has scheduled is not the next thing to worry about, and
 * treating a null as urgent fills the top of the screen with things that are
 * not due at all.
 */
export interface QueueRow {
  verdict: Verdict;
  /** Days until the next obligation. Negative is overdue, null is undated. */
  daysToNext: number | null;
}

export function queueRank(row: QueueRow): number {
  if (row.verdict.level === 'disqualifying') return 0;
  if (row.verdict.level === 'ok') return 1000;

  /* Undated sits at the bottom of the attention band, above `ok` and below
     everything with a date. */
  if (row.daysToNext === null) return 999;

  /* Clamped into the band, and the width has to be worked out rather than
     guessed: the first version allowed 898 days on a base of 200, which is
     1098 — past the `ok` floor. A project due in three years sorted below one
     that was finished, and `tests/queue.mjs` caught it because the assertion
     was about the bands rather than about a number.
   
     Base 200, so 99 days of overdue fit below it without reaching the
     disqualifying band, and 798 above it without reaching 999. */
  const days = Math.max(-99, Math.min(798, row.daysToNext));

  return 200 + days;
}

/**
 * How many days until a date, from today. Negative is past.
 *
 * Both sides truncated to a day. Comparing a date column against a timestamp
 * makes "due today" read as overdue for most of the day, which is the kind of
 * off-by-one that shows up as a teacher chasing somebody who has until
 * midnight.
 */
export function daysUntil(due: string | null | undefined, today: string): number | null {
  if (!due) return null;

  const from = Date.parse(`${today}T00:00:00Z`);
  const to = Date.parse(`${due}T00:00:00Z`);

  if (Number.isNaN(from) || Number.isNaN(to)) return null;

  return Math.round((to - from) / 86_400_000);
}

export function tally(verdicts: Verdict[]) {
  return {
    disqualifying: verdicts.filter((v) => v.level === 'disqualifying').length,
    attention: verdicts.filter((v) => v.level === 'attention').length,
    ok: verdicts.filter((v) => v.level === 'ok').length,
  };
}
