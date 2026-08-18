/**
 * ONE PROJECT, ONE PROGRAM, ONE ROW.
 *
 * **This is the only place page code reads `participations` directly, and the
 * exception is deliberate.**
 *
 * Section 22.5 merged `project_cohorts` and `entries` into one table and
 * recorded the cost of doing so: a query reading that table raw counts IRPD
 * as a fair. The mitigation was two filtered views and a rule that no page
 * selects from the table itself. That rule has already caught three real
 * bugs, so it is worth keeping and worth stating why this file is outside it.
 *
 * The participation page serves both kinds. Asking a view first means asking
 * the wrong one half the time, and asking both and merging is more code
 * pretending to follow a rule it is not following. So it resolves once, here,
 * and returns something that **knows which kind it is holding**. Everything
 * downstream reads `isCohort` rather than guessing from the shape.
 *
 * Every other query on that page stays on the views.
 */

export type ParticipationKind = 'cohort' | 'opportunity';

export interface ResolvedParticipation {
  id: string;
  kind: ParticipationKind;
  isCohort: boolean;
  projectId: string;
  programId: string;
  viaId: string | null;
  row: any;
}

/** What the page needs off the row, in one place so the two callers agree. */
export const PARTICIPATION_COLUMNS = [
  'id',
  'status',
  'placement',
  'category',
  'entry_code',
  'awards',
  'advanced_to',
  'requested_amount',
  'awarded_amount',
  'currency',
  'result_recorded_at',
  'project_id',
  'program_id',
  'via_id',
  'selection_state',
  'projects(id, title, started_on, facts, video_url, process_id, project_authors(role, users(id)))',
  'programs(id, name, season_year, kind, program_role, process_id, phases, roles, template_id, fair_date, advances_to_fairs)',
].join(', ');

/**
 * The participation a project has in a program, or null.
 *
 * Null means this project is not in that program -- not that the program is
 * missing. The caller redirects; it does not invent a page for a
 * relationship that does not exist, because a class's deadlines rendered
 * against a project that never joined it is an obligation nobody agreed to.
 */
export async function participationFor(
  supabase: any,
  projectId: string | undefined,
  programId: string | undefined
): Promise<ResolvedParticipation | null> {
  if (!projectId || !programId) return null;

  const { data } = await supabase
    .from('participations')
    .select(PARTICIPATION_COLUMNS)
    .eq('project_id', projectId)
    .eq('program_id', programId)
    .maybeSingle();

  if (!data) return null;

  return shape(data);
}

/**
 * The same, found by its own id.
 *
 * `/app/entry/{id}/` was keyed on the row, and links to it are in sent mail
 * and in anything queued. This is what lets that address survive as a
 * redirect rather than a dead end.
 */
export async function participationById(
  supabase: any,
  id: string | undefined
): Promise<ResolvedParticipation | null> {
  if (!id) return null;

  const { data } = await supabase
    .from('participations')
    .select(PARTICIPATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (!data) return null;

  return shape(data);
}

function shape(data: any): ResolvedParticipation {
  /* Read off the joined program rather than inferred from which columns are
     null. A cohort row and an entry row have the same columns, and half of
     them are null on an ordinary entry too: a course has no money, a grant
     has no placement. `program_role` is the only thing that actually says. */
  const kind: ParticipationKind =
    (data.programs as any)?.program_role === 'cohort' ? 'cohort' : 'opportunity';

  return {
    id: data.id,
    kind,
    isCohort: kind === 'cohort',
    projectId: data.project_id,
    programId: data.program_id,
    viaId: data.via_id ?? null,
    row: data,
  };
}

/**
 * Everything a project takes part in, both kinds, in one list.
 *
 * The project-level pages need this: a sponsor is recorded against one
 * participation now, so a page that asks "who sponsors this project" has to
 * ask which class or fair it is for. Same justification as the resolvers
 * above -- the caller wants both kinds and a view answers half the question.
 */
export async function participationsForProject(
  supabase: any,
  projectId: string | undefined
): Promise<ResolvedParticipation[]> {
  if (!projectId) return [];

  const { data } = await supabase
    .from('participations')
    .select('id, project_id, program_id, via_id, programs(id, name, season_year, kind, program_role)')
    .eq('project_id', projectId);

  return (data ?? []).map(shape);
}

/** Where this participation lives. One address, keyed on the pair. */
export function participationPath(projectId: string, programId: string): string {
  return `/app/project/${projectId}/in/${programId}/`;
}
