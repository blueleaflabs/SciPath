/**
 * HOW FAR A PROJECT IS, COUNTED ONCE (2.8).
 *
 * The home page said 18 open, the project page 25 of 30 remaining, the
 * care table 5 of 30 met, each counting a slightly different set: with or
 * without events, with or without the Elder's tasks, met by the record
 * or by the date. One function now, used by every page that says how far
 * along a project is, so the numbers agree wherever they are read.
 *
 * What counts: the student's own steps (not the Elder's tasks) that are
 * things to do (not events on the calendar). What is done: a step with
 * `completed_on`, which is what recording a deliverable, submitting a
 * document and the seed's grants all write.
 */

export interface StepRow {
  kind?: string | null;
  owner?: string | null;
  completed_on?: string | null;
}

export interface StepProgress {
  total: number;
  done: number;
  open: number;
}

export function countsAsStep(m: StepRow): boolean {
  return (m.owner ?? 'student') !== 'staff' && m.kind !== 'event';
}

/**
 * `isDone` lets a page that holds the ledger derive doneness from the
 * record as well as the date (the project page's `satisfied`), which
 * covers a deliverable recorded before the row was dated. The default is
 * the date, which every writer since 2.6 sets, so the two agree.
 */
export function stepProgress(rows: StepRow[] | null | undefined, isDone: (m: any) => boolean = (m) => Boolean(m.completed_on)): StepProgress {
  const steps = (rows ?? []).filter(countsAsStep);
  const done = steps.filter((m) => isDone(m)).length;
  return { total: steps.length, done, open: steps.length - done };
}

/** "25 of 30 remaining", the one phrase for it. */
export function remainingWords(p: StepProgress): string {
  return `${p.open} of ${p.total} remaining`;
}

/** "5 of 30 done", where the page speaks of what is met. */
export function doneWords(p: StepProgress): string {
  return `${p.done} of ${p.total} done`;
}
