/**
 * THE TEACHERS BEHIND A PROJECT, READ FROM THE PROJECT'S SIDE (2.9).
 *
 * Every page that named a sponsor asked `project_sponsors` with the
 * project id inside the `participations!inner` embed. PostgREST answers
 * that by scanning `project_sponsors` itself — the smallest table there
 * is, and still every row of every tenant's, each one offered to the row
 * policy and each policy call asking `can_see_project` — and only then
 * joining the places that match. The load test named it as the slowest
 * call on the project page and the deadlines page, at 30 to 65 ms for a
 * handful of rows that never change during a pilot.
 *
 * Read the other way round, the question is cheap: the project's places
 * by the indexed `project_id` (the policy judges one or two rows), and
 * each place's sponsors embedded by the indexed `participation_id`. One
 * call, the same rows, the same policies. Seven pages asked this in
 * seven slightly different shapes; they all ask here now.
 */

export interface Sponsor {
  participation_id: string;
  project_id: string;
  program_id: string;
  program_name: string | null;
  teacher_name: string;
  confirmed_at: string | null;
  signed_on: string | null;
  recorded_at: string | null;
}

/** The current sponsors (not superseded) of every place of these projects. */
export async function sponsorsOf(supabase: any, projectIds: (string | undefined | null)[]): Promise<Sponsor[]> {
  const ids = [...new Set(projectIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0 || !supabase) return [];
  const { data } = await supabase
    .from('participations')
    .select('id, project_id, program_id, programs:program_id(name), project_sponsors(teacher_name, confirmed_at, signed_on, recorded_at, superseded_at)')
    .in('project_id', ids);
  const out: Sponsor[] = [];
  for (const p of data ?? []) {
    for (const s of p.project_sponsors ?? []) {
      if (s.superseded_at) continue;
      out.push({
        participation_id: p.id,
        project_id: p.project_id,
        program_id: p.program_id,
        program_name: p.programs?.name ?? null,
        teacher_name: s.teacher_name,
        confirmed_at: s.confirmed_at ?? null,
        signed_on: s.signed_on ?? null,
        recorded_at: s.recorded_at ?? null,
      });
    }
  }
  out.sort((a, b) => String(a.recorded_at ?? '').localeCompare(String(b.recorded_at ?? '')));
  return out;
}

/** The distinct names, in the order they were recorded. */
export const sponsorNamesOf = (rows: Sponsor[]): string[] => [...new Set(rows.map((r) => r.teacher_name).filter(Boolean))];
