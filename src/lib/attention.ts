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

export function tally(verdicts: Verdict[]) {
  return {
    disqualifying: verdicts.filter((v) => v.level === 'disqualifying').length,
    attention: verdicts.filter((v) => v.level === 'attention').length,
    ok: verdicts.filter((v) => v.level === 'ok').length,
  };
}
