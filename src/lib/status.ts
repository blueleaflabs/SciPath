/**
 * WHERE A PROJECT STANDS.
 *
 * One computation, rendered three ways: the entry page shows it in full, the
 * overview shows a row of it, and the digest mails it (20.1). Two
 * implementations would drift, and the day they drift a student is told two
 * different things about one project.
 *
 * Everything here is pure. It takes rows and a template and returns a
 * description, so it can be tested exactly and run anywhere — including in a
 * scheduled Worker with no request behind it, which is the reason it is a
 * module rather than page frontmatter.
 *
 * **Nothing here is stored.** A status is true at the moment it is computed
 * and false a minute later when somebody records a form, which is why the
 * digest is built when it is sent rather than queued in advance (20.2).
 */

/* From the resolver rather than from `templates.ts`, which reaches the
   YAML through an import Vite resolves and node does not. This module runs
   in a scheduled Worker with no bundler in front of it. */
import { deliverablesFor, stepApplies } from './template-resolve.ts';
import type { Resolved, Step } from './template-resolve.ts';

export type Urgency = 'late' | 'urgent' | 'soon' | 'later';

export interface Item {
  /** The step this is about. */
  stepId: string;
  name: string;
  /** The day it is due, or null where a program sets no date. */
  dueOn: string | null;
  /** Whole days from today. Negative is in the past. */
  days: number | null;
  urgency: Urgency;
  /** What it still wants, by name. Empty when it wants nothing. */
  missing: string[];
  /** Recorded against this step, out of what applies. */
  done: number;
  total: number;
  /** True where being late ends something rather than merely being late. */
  blocking: boolean;
  /** The line a template chose to add, if any. */
  note: string | null;
  /** Where to send somebody. A path with `at`, never a fragment. */
  href: string;
}

export interface Status {
  entryId: string;
  projectId: string;
  title: string;
  programName: string;
  /** Steps that want something and have not got it, soonest first. */
  outstanding: Item[];
  /** Of the steps that apply and are required, how many are not yet met. */
  remaining: number;
  applicable: number;
  /** The worst urgency present, or null when nothing is outstanding. */
  worst: Urgency | null;
}

/** Whole days from today, comparing calendar days rather than moments. */
function daysUntil(iso: string | null, today: Date): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const midnight = (a: Date) => new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  return Math.round((midnight(new Date(y, m - 1, d)) - midnight(today)) / 86400000);
}

/**
 * How loud this is, from the step's own window.
 *
 * The template says when a step starts being worth mentioning and when it
 * starts being worth mentioning first, because three weeks is right for a
 * form that needs a signature and absurd for rehearsing a talk (20.5).
 */
export function urgencyOf(step: Step, days: number | null): Urgency | null {
  const window = step.notify;
  if (!window) return null;

  /* A step with no date is never urgent and never late. It is work to do,
     and the program has not said when. */
  if (days === null) return 'later';

  if (days < 0) return 'late';
  if (days <= (window.urgent ?? 0)) return 'urgent';
  if (days <= (window.from ?? 0)) return 'soon';
  return null;
}

const ORDER: Record<Urgency, number> = { late: 0, urgent: 1, soon: 2, later: 3 };

export interface Inputs {
  entryId: string;
  projectId: string;
  title: string;
  programName: string;
  template: Resolved | null;
  /** What the project has declared about itself, for `applies_when`. */
  facts: Record<string, boolean>;
  /** Deliverable ids already recorded. */
  recorded: Set<string>;
  /** Step id to the date it resolved to, from `datesFor`. */
  dueBy: Map<string, string | null>;
  today?: Date;
}

/**
 * The whole answer.
 *
 * A step is met when everything it asked for is there, which is the same
 * derivation the deadline row uses — never `completed_on`, because recording
 * a shared deliverable satisfies several steps and only one of them would
 * ever have been marked (7.3a).
 */
export function projectStatus(input: Inputs): Status {
  const today = input.today ?? new Date();
  const outstanding: Item[] = [];

  let applicable = 0;
  let remaining = 0;

  for (const step of input.template?.steps ?? []) {
    /* A step this project is not subject to. Counting it would tell somebody
       they are behind on work they will never do, and the vertebrate forms
       are the case that makes it obvious. */
    if (!stepApplies(step, input.facts)) continue;

    const wants = deliverablesFor(input.template!, step, input.facts);
    const needed = wants.filter((d) => d.requirement !== 'optional');

    /* A step that asks for nothing has nothing to be outstanding about. It
       is a date on a calendar rather than an obligation. */
    if (needed.length === 0) continue;

    applicable += 1;

    const missing = needed.filter((d) => !input.recorded.has(d.id));
    if (missing.length === 0) continue;

    remaining += 1;

    const dueOn = input.dueBy.get(step.id) ?? null;
    const days = daysUntil(dueOn, today);
    const urgency = urgencyOf(step, days);

    /* Outside its window it is real work and not yet worth saying. The
       count above still includes it, because "4 of 16 remaining" is about
       the project and not about what is loud today. */
    if (!urgency) continue;

    outstanding.push({
      stepId: step.id,
      name: step.name,
      dueOn,
      days,
      urgency,
      missing: missing.map((d) => d.name ?? d.id),
      done: needed.length - missing.length,
      total: needed.length,
      blocking: Boolean(step.consequence && step.consequence !== 'none'),
      note: step.notify_note ?? null,
      href: `/app/entry/${input.entryId}/?at=deliverables`,
    });
  }

  outstanding.sort((a, b) => {
    const byUrgency = ORDER[a.urgency] - ORDER[b.urgency];
    if (byUrgency !== 0) return byUrgency;
    if (a.days === null) return 1;
    if (b.days === null) return -1;
    return a.days - b.days;
  });

  return {
    entryId: input.entryId,
    projectId: input.projectId,
    title: input.title,
    programName: input.programName,
    outstanding,
    remaining,
    applicable,
    worst: outstanding[0]?.urgency ?? null,
  };
}

/**
 * How a moment is described, which is the escalation.
 *
 * The same line reads "in 7 days", then "in 2 days", then "3 days late".
 * Nothing is created and nothing cancelled: one row of state described
 * differently as the date moves, which cannot contradict itself (20.6).
 */
export function whenText(days: number | null): string {
  if (days === null) return 'no date set';
  if (days < 0) return `${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} late`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}
