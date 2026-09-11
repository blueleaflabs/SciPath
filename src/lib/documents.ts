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

/* `textOf` and `isFilled` live in field-values.ts (2.8), where the pure
   readers can take them; the same two functions, re-exported. */
import { textOf, isFilled, tallyWords } from './field-values';
export { textOf, isFilled, tallyWords };

/** How far along a document is: filled of asked, and which required ones are missing. */
export function progressOf(shape: Shape, values: Record<string, any>) {
  const asked = askedOf(shape);
  /* The count is of what is required, because that is what Submit waits
     on. A shape's optional fields (a part filled in later, in the family
     session) are not in it: "8 of 9" with the ninth not required read as
     one thing still missing (2.8). */
  const required = asked.filter((f) => f.required);
  const filled = required.filter((f) => isFilled(f, values[f.id]));
  const missing = required.filter((f) => !isFilled(f, values[f.id]));
  const over = asked.filter((f) => f.max_words != null && wordCount(textOf(f, values[f.id])) > (f.max_words ?? 0));
  return { asked: required.length, filled: filled.length, missing, over };
}

export type DocState = 'not_started' | 'in_progress' | 'submitted' | 'revising';

export function stateLabel(state: DocState): string {
  return state === 'not_started' ? 'Not Started' : state === 'in_progress' ? 'In Progress' : state === 'submitted' ? 'Submitted' : 'Revising';
}

/**
 * WHERE A DOCUMENT STANDS, SAID ONCE (2.8).
 *
 * The verb on its row, the state, and the sentence under it, the same on
 * the project page, the Workbench, the Class page, the exports and the
 * notebook. A document is started the moment its row is opened
 * (`opened_at`, which is the Start click), so the sentence carries when
 * it was started, and, once submitted, how long it took.
 *
 * `open`: the step this row is for is still open although the document
 * was submitted for an earlier step that wanted it (the journey map's
 * draft): update it and submit again.
 */
export interface DocRowLike {
  status?: string | null;
  version_no?: number | null;
  opened_at?: string | null;
  submitted_at?: string | null;
  updated_at?: string | null;
  document_fields?: { field_id: string; value: any }[] | null;
}
export interface DocStanding {
  state: DocState;
  verb: 'Start' | 'Continue' | 'Update' | 'Open';
  label: string;
  filled: number;
  asked: number;
  startedAt: string | null;
  submittedAt: string | null;
  tookDays: number | null;
}
const dayDiff = (a: string | null | undefined, b: string | null | undefined): number | null => {
  if (!a || !b) return null;
  const from = Date.parse(a), to = Date.parse(b);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.round((to - from) / 86_400_000));
};
export function docStanding(
  doc: DocRowLike | null | undefined,
  shape: Shape | null | undefined,
  fmt: (iso: string) => string,
  opts: { open?: boolean } = {}
): DocStanding {
  const asked = shape ? progressOf(shape, {}).asked : 0;
  if (!doc) return { state: 'not_started', verb: 'Start', label: 'Not Started', filled: 0, asked, startedAt: null, submittedAt: null, tookDays: null };
  const values: Record<string, any> = {};
  for (const f of doc.document_fields ?? []) values[f.field_id] = f.value;
  const p = shape ? progressOf(shape, values) : { asked: 0, filled: 0, missing: [], over: [] };
  const started = doc.opened_at ? ` · started ${fmt(doc.opened_at)}` : '';
  const base = { filled: p.filled, asked: p.asked, startedAt: doc.opened_at ?? null, submittedAt: doc.submitted_at ?? null };
  if (doc.status === 'submitted' && opts.open) {
    return { ...base, state: 'in_progress', verb: 'Update', label: `Submitted for the earlier deadline${started} · update and submit again`, tookDays: null };
  }
  if (doc.status === 'submitted') {
    const took = dayDiff(doc.opened_at, doc.submitted_at);
    const version = (doc.version_no ?? 0) > 1 ? ` (version ${doc.version_no})` : '';
    const tookWords = took === null ? '' : ` · took ${took} ${took === 1 ? 'day' : 'days'}`;
    return { ...base, state: 'submitted', verb: 'Open', label: `Submitted${doc.submitted_at ? ` ${fmt(doc.submitted_at)}` : ''}${version}${started}${tookWords}`, tookDays: took };
  }
  const word = doc.status === 'revising' ? 'Revising' : 'In Progress';
  return { ...base, state: doc.status === 'revising' ? 'revising' : 'in_progress', verb: 'Continue', label: `${word}${started} · ${p.filled} of ${p.asked} answered`, tookDays: null };
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
  /** The steps this one waits on that are not met; empty when it may start (2.8). */
  waitsOn: string[];
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
      .select('id, name, due_on, completed_on, step_id, requires_steps, requires_step')
      .eq('participation_id', part.id)
      .in('name', steps.map((st: any) => st.name));
    /* The gate (2.8): which of the steps this one waits on are not met,
       read from the same place's rows in one further query. */
    const wantedIds = [...new Set((rows ?? []).flatMap((r: any) => [...(r.requires_steps ?? []), ...(r.requires_step ? [r.requires_step] : [])]))];
    const { data: needed } = wantedIds.length
      ? await supabase.from('entry_milestones').select('step_id, name, completed_on, sort_order').eq('participation_id', part.id).in('step_id', wantedIds).order('sort_order')
      : { data: [] as any[] };
    const gateOf = (row: any): string[] => {
      const ids = new Set<string>([...(row?.requires_steps ?? []), ...(row?.requires_step ? [row.requires_step] : [])]);
      return (needed ?? []).filter((n: any) => ids.has(n.step_id) && !n.completed_on).map((n: any) => n.name);
    };

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
        waitsOn: gateOf(row),
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
