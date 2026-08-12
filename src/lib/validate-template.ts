/**
 * VALIDATING A PROGRAM TEMPLATE.
 *
 * **This checks the template, not the project.** A template pointing at a
 * deliverable nobody declared is broken and no student can fix it from inside
 * the application. A student who finishes their literature review after they
 * settled their topic is just a student.
 *
 * So: authoring mistakes are errors, and everything about how the work
 * actually goes is at most a warning. High school runs on cramming, and
 * software that refuses to record what happened gets lied to.
 *
 * Run: npm run test:templates
 */

import { datesFor, type Resolved } from './template-resolve.ts';

export interface Problem {
  level: 'error' | 'warning';
  where: string;
  message: string;
}

interface Bundle {
  program: any;
  /** Every deliverable id available, from the libraries this program uses. */
  deliverables: Set<string>;
  shapes: Set<string>;
  facts: Set<string>;
}

const stepList = (program: any): any[] => {
  const steps = program.steps;
  if (!steps) return [];
  return Array.isArray(steps) ? steps : [...(steps.add ?? []), ...(steps.override ?? [])];
};

export function validate(bundle: Bundle): Problem[] {
  const { program, deliverables, shapes, facts } = bundle;
  const problems: Problem[] = [];
  const steps = stepList(program);
  const stepIds = new Set(steps.map((s) => s.id));
  const phaseIds = new Set((program.phases ?? []).map((p: any) => p.id));

  const error = (where: string, message: string) =>
    problems.push({ level: 'error', where, message });
  const warn = (where: string, message: string) =>
    problems.push({ level: 'warning', where, message });

  /* ── Things nobody can fix from inside the application ─────────────────── */

  for (const step of steps) {
    const at = `${program.id}/${step.id}`;

    if (!step.id) error(program.id, 'a step with no id');
    if (!step.name) error(at, 'a step with no name');

    /* A step in a phase that does not exist appears nowhere in a grouped
       view, which is the quietest way to lose a deadline. */
    if (step.phase && phaseIds.size > 0 && !phaseIds.has(step.phase)) {
      error(at, `phase "${step.phase}" is not declared`);
    }

    for (const d of step.deliverables ?? []) {
      const id = d.ref ?? d.id;
      if (id && !deliverables.has(id)) {
        error(at, `deliverable "${id}" is not declared in any library this program uses`);
      }
    }

    for (const required of step.requires ?? []) {
      if (!stepIds.has(required)) {
        error(at, `requires "${required}", which is not a step here`);
      }
    }

    if (step.applies_when) {
      for (const fact of String(step.applies_when).split(/\s+(?:or|and|not)\s+|\s+/)) {
        const name = fact.replace(/[^a-z_]/gi, '');
        if (name && !['or', 'and', 'not', ''].includes(name) && !facts.has(name)) {
          error(at, `applies_when reads fact "${name}", which nobody declares`);
        }
      }
    }
  }

  /* A cycle means no order exists at all, so nothing can be displayed. */
  const cycle = findCycle(steps);
  if (cycle) error(program.id, `requires forms a cycle: ${cycle.join(' → ')}`);

  /* ── Things a template author should see and a student should not ─────── */

  /* The same resolution the pages and the seed use, rather than a second
     copy of it. The copy that used to live here did not know about phase
     windows, so a course's dates were invisible to every check below and the
     one contradiction this is meant to catch went unreported. */
  const dates = new Map<string, string>();
  for (const resolved of datesFor(program as unknown as Resolved)) {
    if (resolved.date) dates.set(resolved.step.id, resolved.date);
  }

  for (const step of steps) {
    const mine = dates.get(step.id);
    if (!mine) continue;
    for (const required of step.requires ?? []) {
      const theirs = dates.get(required);
      if (theirs && theirs > mine) {
        warn(
          `${program.id}/${step.id}`,
          `due ${mine}, but requires "${required}" which is not due until ${theirs}`
        );
      }
    }
  }

  /* A step dated before one that comes earlier in the sequence.
   
     Not an error: a student may do things out of order and the software
     records that rather than preventing it. But a *template* whose own dates
     contradict its own order is an authoring mistake, and it is invisible
     until somebody reads the list and finds milestone 6 above milestone 3. */
/* Within a phase only. Across phases the comparison is noise: "applications
     open" sits in `approval` and happens in September, while the club's first
     conversations sit in `start` and happen in October, and neither is
     wrong. */
  const byPhase = new Map<string, typeof steps>();
  for (const step of steps) {
    if (!dates.has(step.id)) continue;
    const list = byPhase.get(step.phase) ?? [];
    list.push(step);
    byPhase.set(step.phase, list);
  }

  for (const list of byPhase.values()) {
    const inOrder = list.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (let i = 1; i < inOrder.length; i += 1) {
      const previous = inOrder[i - 1];
      const current = inOrder[i];
      const before = dates.get(previous.id)!;
      const after = dates.get(current.id)!;

      if (after < before) {
        warn(
          `${program.id}/${current.id}`,
          `comes after "${previous.id}" in the sequence but is due ${after}, ` +
            `which is before ${before}`
        );
      }
    }
  }

  for (const step of steps) {
    if (step.shape && !shapes.has(step.shape)) {
      warn(`${program.id}/${step.id}`, `shape "${step.shape}" is not declared`);
    }
  }

  /* A program whose steps never touch the phases where the research happens
     is worth noticing. It is what a fair looks like, and it is the argument
     for a club existing. */
  const touched = new Set(steps.map((s) => s.phase));
  const research = ['work', 'collect', 'analyse'].filter((p) => phaseIds.has(p));
  if (research.length > 0 && !research.some((p) => touched.has(p))) {
    warn(program.id, 'nothing is asked of a student while the research is happening');
  }

  return problems;
}


function findCycle(steps: any[]): string[] | null {
  const edges = new Map<string, string[]>(steps.map((s) => [s.id, s.requires ?? []]));
  const state = new Map<string, number>();
  const path: string[] = [];

  const walk = (id: string): string[] | null => {
    if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id];
    if (state.get(id) === 2) return null;

    state.set(id, 1);
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const found = walk(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, 2);
    return null;
  };

  for (const id of edges.keys()) {
    const found = walk(id);
    if (found) return found;
  }
  return null;
}
