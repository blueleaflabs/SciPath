export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../../../lib/supabase';

/**
 * THE GRADES, AS THE DISTRICT'S GRADEBOOK WANTS THEM.
 *
 * One row per student per obligation with a current assessment. The
 * district's system is the gradebook of record; this is the export into it,
 * and it carries nothing that system does not want: student, project,
 * obligation, due date, score, out of, whether the student has seen it, and
 * the feedback. Advisors only, by the policy on the table: anybody else
 * gets an empty file rather than an error, because an empty file is what
 * the policy returns.
 */
export const GET: APIRoute = async ({ params, request, cookies, locals }) => {
  const runtime = (locals as any).runtime?.env;
  const supabase = serverClient(request, cookies, runtime);
  const id = params.id ?? '';

  const runs = ((locals as any).classes ?? []).some((c: any) => c.program_id === id);
  if (!runs) return new Response('Not found', { status: 404 });

  const { data: parts } = await supabase
    .from('participations')
    .select('id, projects(title)')
    .eq('program_id', id);

  const partIds = (parts ?? []).map((p: any) => p.id);
  const titleOf = new Map((parts ?? []).map((p: any) => [p.id, p.projects?.title ?? '']));

  const { data: rows } = partIds.length
    ? await supabase
        .from('assessments')
        .select('participation_id, score, out_of, feedback_md, released_at, created_at, kind, student:student_id(display_name), milestone:milestone_id(name, due_on), grader:grader_id(display_name)')
        .in('participation_id', partIds)
        .is('superseded_by', null)
        .order('created_at')
    : { data: [] as any[] };

  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [
    ['Student', 'Project', 'Obligation', 'Due', 'Kind', 'Score', 'Out of', 'Released', 'Graded on', 'Graded by', 'Feedback'].join(','),
    ...(rows ?? []).map((r: any) =>
      [
        r.student?.display_name,
        titleOf.get(r.participation_id),
        r.milestone?.name,
        r.milestone?.due_on,
        r.kind === 'elder' ? 'elder score' : 'grade',
        r.score,
        r.out_of,
        r.released_at ? 'yes' : 'no',
        String(r.created_at ?? '').slice(0, 10),
        r.grader?.display_name,
        r.feedback_md,
      ]
        .map(cell)
        .join(',')
    ),
  ];

  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="grades.csv"',
      'Cache-Control': 'private, no-store',
    },
  });
};
