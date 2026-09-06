/**
 * DOCUMENTS (6.16): the pieces the document page, the plate, the ledger
 * and the class board share.
 *
 * A document is a project's instance of a shape. Which program's step it
 * meets is answered here too: the project's places are read, each place's
 * template resolved, and the steps that want this deliverable found, with
 * the milestone row each became. One place in the pilot; the shape of the
 * answer is a list so a fair next spring is a second entry rather than a
 * rewrite.
 */

import { resolveProgram, deliverablesFor, sectionsOf, askedOf, type Shape, type ShapeField, type Resolved, type Deliverable } from './templates';

export function wordCount(text: string | null | undefined): number {
  if (!text) return 0;
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/** What a field's stored value is, as the page shows it. */
export function textOf(field: ShapeField, value: any): string {
  if (value == null) return '';
  if (field.kind === 'choices') return Array.isArray(value) ? value.join(', ') : String(value);
  if (field.kind === 'file') return value?.name ?? value?.path ?? '';
  return String(value);
}

export function isFilled(field: ShapeField, value: any): boolean {
  if (field.kind === 'note') return true;
  if (value == null) return false;
  if (field.kind === 'choices') return Array.isArray(value) && value.length > 0;
  if (field.kind === 'file') return Boolean(value?.path);
  return String(value).trim().length > 0;
}

/** How far along a document is: filled of asked, and which required ones are missing. */
export function progressOf(shape: Shape, values: Record<string, any>) {
  const asked = askedOf(shape);
  const filled = asked.filter((f) => isFilled(f, values[f.id]));
  const missing = asked.filter((f) => f.required && !isFilled(f, values[f.id]));
  const over = asked.filter((f) => f.max_words != null && wordCount(textOf(f, values[f.id])) > (f.max_words ?? 0));
  return { asked: asked.length, filled: filled.length, missing, over };
}

export type DocState = 'not_started' | 'in_progress' | 'submitted' | 'revising';

export function stateLabel(state: DocState): string {
  return state === 'not_started' ? 'Not started' : state === 'in_progress' ? 'In progress' : state === 'submitted' ? 'Submitted' : 'Revising';
}

/** A place on this project that wants this deliverable: the program, the step, its milestone row. */
export interface WantingPlace {
  participationId: string;
  programId: string;
  programName: string;
  program: Resolved;
  step: any;
  deliverable: Deliverable;
  milestoneId: string | null;
  milestoneName: string;
  dueOn: string | null;
  completedOn: string | null;
  isCohort: boolean;
}

export async function placesWanting(
  supabase: any,
  projectId: string,
  deliverableId: string,
  facts: Record<string, boolean> = {},
  projectProcess: string | null = null
): Promise<WantingPlace[]> {
  const { data: parts } = await supabase
    .from('participations')
    .select('id, program_id, status, programs(id, name, short_name, program_role, template_id, process_id, status)')
    .eq('project_id', projectId)
    .in('status', ['entered', 'competed']);

  const out: WantingPlace[] = [];
  for (const part of parts ?? []) {
    const program = part.programs as any;
    if (!program?.template_id) continue;
    let resolved: Resolved;
    try {
      resolved = resolveProgram(program.template_id, program.process_id ?? projectProcess);
    } catch {
      continue;
    }
    const steps = resolved.steps.filter((st: any) =>
      (st.deliverables ?? []).some((d: any) => (d.ref ?? d.id) === deliverableId)
    );
    if (steps.length === 0) continue;

    const { data: rows } = await supabase
      .from('entry_milestones')
      .select('id, name, due_on, completed_on')
      .eq('participation_id', part.id)
      .in('name', steps.map((st: any) => st.name));

    for (const step of steps) {
      const wants = deliverablesFor(resolved, step, facts);
      const deliverable = wants.find((d) => d.id === deliverableId);
      if (!deliverable) continue;
      const row = (rows ?? []).find((r: any) => r.name === step.name) ?? null;
      out.push({
        participationId: part.id,
        programId: part.program_id,
        programName: program.short_name ?? program.name,
        program: resolved,
        step,
        deliverable,
        milestoneId: row?.id ?? null,
        milestoneName: row?.name ?? step.name,
        dueOn: row?.due_on ?? null,
        completedOn: row?.completed_on ?? null,
        isCohort: program.program_role === 'cohort',
      });
    }
  }
  /* The class first, then by date. */
  return out.sort((a, b) => Number(b.isCohort) - Number(a.isCohort) || (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));
}

/** The document page's address. */
export function documentPath(projectId: string, deliverableId: string): string {
  return `/app/project/${projectId}/doc/${deliverableId}/`;
}

export { sectionsOf, askedOf };
