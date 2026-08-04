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
  /** The single most useful thing to say about it, or null when in order. */
  reason: string | null;
}

export function assess(p: ProjectState): Verdict {
  if (p.worst?.severity === 'disqualifying') {
    return { level: 'disqualifying', reason: p.worst.name };
  }

  if (!p.hasSponsor) {
    return { level: 'attention', reason: 'No teacher sponsor' };
  }

  if (!p.hasOfficer) {
    return { level: 'attention', reason: 'No club officer' };
  }

  if (!p.startedOn) {
    return { level: 'attention', reason: 'No start date' };
  }

  if (p.worst) {
    return { level: 'attention', reason: p.worst.name };
  }

  return { level: 'ok', reason: null };
}

export function tally(verdicts: Verdict[]) {
  return {
    disqualifying: verdicts.filter((v) => v.level === 'disqualifying').length,
    attention: verdicts.filter((v) => v.level === 'attention').length,
    ok: verdicts.filter((v) => v.level === 'ok').length,
  };
}
