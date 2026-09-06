/**
 * THE HOME PAGE'S SUMMARY FOR SOMEBODY SIGNED IN (2.8).
 *
 * The front door, once a person is known: where their own project stands
 * (the next step, when, and the questions waiting), and for an Elder the
 * projects in their care, each with its next step and whether it is
 * late. One read per list through the session client, so the policies
 * decide what is shown and nothing here widens them. The Workbench does
 * the full job; this is the glance.
 */

import { byDueThenOrder } from './milestone-order';
import { daysUntil } from './attention';
import { stepProgress, countsAsStep, type StepProgress } from './step-progress';

export interface NextStep { name: string; dueOn: string | null; days: number | null; late: boolean }
export interface OwnProject { id: string; title: string; programId: string | null; next: NextStep | null; progress: StepProgress }
export interface CaredProject { id: string; title: string; programId: string | null; authors: string; next: NextStep | null }
export interface HomeSummary { own: OwnProject[]; cared: CaredProject[]; questions: number }

function nextOf(rows: any[], today: string): { next: NextStep | null; progress: StepProgress } {
  const progress = stepProgress(rows);
  const open = rows.filter((m: any) => countsAsStep(m) && !m.completed_on);
  const first = [...open].sort(byDueThenOrder)[0] ?? null;
  if (!first) return { next: null, progress };
  const days = daysUntil(first.due_on ?? null, today);
  return { next: { name: first.name, dueOn: first.due_on ?? null, days, late: days !== null && days < 0 }, progress };
}

export async function homeSummary(supabase: any, userId: string, today: string): Promise<HomeSummary> {
  const { data: roles } = await supabase
    .from('project_authors')
    .select('role, participation_id, projects(id, title)')
    .eq('user_id', userId);

  const ownIds = [...new Set((roles ?? []).filter((r: any) => r.role === 'author' && r.projects).map((r: any) => r.projects.id))] as string[];
  const caredParts = (roles ?? []).filter((r: any) => r.role === 'officer' && r.participation_id && r.projects);

  const own: OwnProject[] = [];
  if (ownIds.length > 0) {
    const { data: parts } = await supabase
      .from('participations')
      .select('id, project_id, program_id, entry_milestones(name, due_on, completed_on, kind, owner, sort_order, id)')
      .in('project_id', ownIds)
      .in('status', ['entered', 'competed']);
    for (const id of ownIds) {
      const title = (roles ?? []).find((r: any) => r.projects?.id === id)?.projects?.title ?? 'Your project';
      const mine = (parts ?? []).filter((p: any) => p.project_id === id);
      const rows = mine.flatMap((p: any) => p.entry_milestones ?? []);
      const { next, progress } = nextOf(rows, today);
      own.push({ id, title, programId: mine[0]?.program_id ?? null, next, progress });
    }
  }

  const cared: CaredProject[] = [];
  if (caredParts.length > 0) {
    const { data: parts } = await supabase
      .from('participations')
      .select('id, project_id, program_id, entry_milestones(name, due_on, completed_on, kind, owner, sort_order, id), projects(title, project_authors(role, users(display_name)))')
      .in('id', caredParts.map((r: any) => r.participation_id))
      .in('status', ['entered', 'competed']);
    for (const p of parts ?? []) {
      if (ownIds.includes(p.project_id)) continue;
      const authors = ((p.projects as any)?.project_authors ?? []).filter((a: any) => a.role === 'author' && a.users).map((a: any) => a.users.display_name).join(', ');
      cared.push({ id: p.project_id, title: (p.projects as any)?.title ?? 'A project', programId: p.program_id, authors, next: nextOf(p.entry_milestones ?? [], today).next });
    }
    cared.sort((a, b) => Number(b.next?.late ?? false) - Number(a.next?.late ?? false) || (a.next?.dueOn ?? '9999').localeCompare(b.next?.dueOn ?? '9999'));
  }

  /* Questions waiting on this person: a student's line, unanswered, on a
     document in their care. The same rule the Workbench's plate uses. */
  let questions = 0;
  if (cared.length > 0) {
    const { data: docs } = await supabase.from('documents').select('id, project_id').in('project_id', cared.map((c) => c.id));
    const docIds = (docs ?? []).map((d: any) => d.id);
    if (docIds.length > 0) {
      const { data: lines } = await supabase
        .from('deliverable_feedback')
        .select('document_id, field_id, author_id, created_at')
        .in('document_id', docIds)
        .order('created_at', { ascending: true });
      const { data: authorRows } = await supabase.from('project_authors').select('project_id, user_id').eq('role', 'author').in('project_id', cared.map((c) => c.id));
      const authorsOf = new Map<string, Set<string>>();
      for (const a of authorRows ?? []) { if (!authorsOf.has(a.project_id)) authorsOf.set(a.project_id, new Set()); authorsOf.get(a.project_id)!.add(a.user_id); }
      const projectOfDoc = new Map<string, string>((docs ?? []).map((d: any) => [d.id, d.project_id]));
      const last = new Map<string, any>();
      for (const c of lines ?? []) last.set(`${c.document_id}:${c.field_id ?? ''}`, c);
      for (const c of last.values()) if (authorsOf.get(projectOfDoc.get(c.document_id) ?? '')?.has(c.author_id)) questions += 1;
    }
  }

  return { own, cared, questions };
}
