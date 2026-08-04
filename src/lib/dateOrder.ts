/**
 * THE DATE ORDERING CHECK.
 *
 * A pure function, written before any interface around it, because it is the
 * one piece of this system that has to be verifiable on its own.
 *
 * The failure it exists to catch: a student begins experimenting before the
 * approval that had to precede it. The work is real, the paper is good, and
 * the entry is disqualified on a date comparison. That failure is procedural
 * rather than intellectual, and nothing about it requires a human to notice.
 *
 * No database, no clock, no imports. Everything it needs is an argument.
 */

export interface Obligation {
  id: string;
  name: string;
  /** ISO date the obligation is due. */
  dueOn: string | null;
  /** ISO date it was actually satisfied, or null. */
  completedOn: string | null;
  /**
   * The date on a signature, from the deliverable hanging off this
   * obligation. Where one exists it is what the check uses, because a
   * student ticking "done" is not a signed form and the fair cares about
   * the form. See brief 11.3.
   */
  signedOn?: string | null;
  /** True where work may not begin until this is satisfied. */
  blocksExperimentation: boolean;
  required: boolean;
}

export type Severity =
  /** Already true and cannot be undone. */
  | 'disqualifying'
  /** Not true yet, and will be unless something changes. A planned start
      date is a plan, not a fact, and saying otherwise about a date in the
      future is both wrong and the kind of wrong that teaches people to
      ignore warnings. */
  | 'planned'
  | 'urgent'
  | 'due'
  | 'ok';

export interface Finding {
  id: string;
  name: string;
  severity: Severity;
  message: string;
}

export interface CheckInput {
  /**
   * ISO date experimentation began or is planned to begin, or null.
   * A date in the future is a plan; a date today or earlier is a fact.
   */
  startedOn: string | null;
  obligations: Obligation[];
  /** ISO date to treat as today. Passed in so the function stays pure. */
  today: string;
}

const day = 86_400_000;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / day);
}

/**
 * Returns one finding per obligation worth reporting, most serious first.
 * An empty array means nothing is wrong, which is a meaningful answer.
 */
export function checkDateOrder(input: CheckInput): Finding[] {
  const { startedOn, obligations, today } = input;
  const findings: Finding[] = [];

  /* A start date in the future has not happened. Everything about it is
     still changeable, which is exactly why it is worth flagging early and
     exactly why it is not a disqualification. */
  const hasStarted = startedOn !== null && daysBetween(startedOn, today) >= 0;

  for (const o of obligations) {
    if (!o.required && !o.blocksExperimentation) continue;

    if (o.blocksExperimentation && startedOn) {
      /* The signature wins over the tick. */
      const satisfiedOn = o.signedOn ?? o.completedOn;
      const gap = satisfiedOn ? daysBetween(satisfiedOn, startedOn) : null;

      if (hasStarted) {
        /* Already true and cannot be undone. */
        if (gap !== null && gap < 0) {
          findings.push({
            id: o.id,
            name: o.name,
            severity: 'disqualifying',
            message: `Work began ${Math.abs(gap)} days before ${o.name} was signed. Most fairs treat this as disqualifying. Talk to your sponsor now rather than at the fair.`,
          });
          continue;
        }

        if (gap === null) {
          findings.push({
            id: o.id,
            name: o.name,
            severity: 'disqualifying',
            message: `${o.name} is not signed, and work has already started. This has to be resolved before the entry is judged.`,
          });
          continue;
        }
      } else {
        /* Still a plan. Say what has to happen first, and by when. */
        const until = daysBetween(today, startedOn);

        if (gap !== null && gap < 0) {
          findings.push({
            id: o.id,
            name: o.name,
            severity: 'planned',
            message: `${o.name} was signed after the day you plan to start. Move your start date to ${satisfiedOn} or later, or the entry is disqualified on a date comparison.`,
          });
          continue;
        }

        if (gap === null) {
          findings.push({
            id: o.id,
            name: o.name,
            severity: 'planned',
            message: `${o.name} is not signed yet, and you plan to start in ${until} day${until === 1 ? '' : 's'}. It has to be signed before you begin, not after.`,
          });
          continue;
        }
      }
    }

    if (o.signedOn ?? o.completedOn) continue;

    if (!o.dueOn) continue;

    const left = daysBetween(today, o.dueOn);

    if (left < 0) {
      findings.push({
        id: o.id,
        name: o.name,
        severity: 'urgent',
        message: `${o.name} was due ${Math.abs(left)} days ago.`,
      });
    } else if (left <= 14) {
      findings.push({
        id: o.id,
        name: o.name,
        severity: 'due',
        message: `${o.name} is due in ${left} day${left === 1 ? '' : 's'}.`,
      });
    }
  }

  const rank: Record<Severity, number> = {
    disqualifying: 0,
    planned: 1,
    urgent: 2,
    due: 3,
    ok: 4,
  };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** The single worst thing true right now, or null. */
export function worstFinding(findings: Finding[]): Finding | null {
  return findings.length > 0 ? findings[0] : null;
}
