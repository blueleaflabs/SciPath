export const prerender = false;

/**
 * ONE FAMILY SCORE, SAVED (2.8).
 *
 * The tracker's editor posts here as a cell changes: the obligation, the
 * student, the score, the comment, and the id of the assessment the cell
 * was showing when it was opened. `grade_milestone` decides everything
 * about who may write; this route adds one guard, that the cell has not
 * been rewritten by somebody else since it was opened, so two Elders on
 * one family cannot overwrite each other without seeing it.
 */

import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/supabase';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  if (!(locals as any).session) return json({ ok: false }, 401);
  const supabase = serverClient(request, cookies, (locals as any).runtime?.env);

  let body: any;
  try { body = JSON.parse(await request.text()); } catch { return json({ ok: false, error: 'not JSON' }, 400); }
  const milestoneId = String(body?.milestone_id ?? '');
  const studentId = String(body?.student_id ?? '');
  if (!milestoneId || !studentId) return json({ ok: false, error: 'obligation and student' }, 400);
  const raw = body?.score == null || body.score === '' ? null : Number(body.score);
  if (raw !== null && (Number.isNaN(raw) || raw < 0 || raw > 4)) return json({ ok: false, error: 'a score is 0 to 4' }, 400);
  const comment = String(body?.comment ?? '').slice(0, 4000);
  const was = String(body?.was ?? '');

  /* The cell as it stands now. Different from what the editor opened on
     means somebody else wrote it since. */
  const { data: now } = await supabase
    .from('assessments')
    .select('id, score, feedback_md, created_at, grader:grader_id(display_name)')
    .eq('milestone_id', milestoneId)
    .eq('student_id', studentId)
    .eq('kind', 'elder')
    .is('superseded_by', null)
    .maybeSingle();
  if ((now?.id ?? '') !== was) {
    return json({ ok: false, conflict: true, id: now?.id ?? null, score: now?.score ?? null, comment: now?.feedback_md ?? '', by: (now as any)?.grader?.display_name ?? null, at: now?.created_at ?? null });
  }

  const { data: id, error } = await supabase.rpc('grade_milestone', {
    p_milestone_id: milestoneId,
    p_student_id: studentId,
    p_score: raw,
    p_out_of: 4,
    p_feedback_md: comment,
    p_rubric: null,
    p_release: false,
  });
  if (error) return json({ ok: false, error: error.message }, 403);
  return json({ ok: true, id, at: new Date().toISOString() });
};
