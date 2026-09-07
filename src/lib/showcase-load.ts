/**
 * READING A PROJECT'S SHOWCASE (2.8).
 *
 * The sections a project has (one per submitted deliverable whose shape
 * has a showcase block), what is still to come, and the tile's picture
 * and line, for one project or for every project in a class at once.
 * One place, so the gallery's tiles and the project's page are built
 * from the same reading; the policies decide what the session may see.
 *
 * `asOf` (a day) reads the versions submitted by that day instead of the
 * documents as they stand, which is how the page shows what it looked
 * like a week ago.
 */

import { deliverablesFor, shape as shapeOf } from './templates';
import { showcaseSection, latestPicture, firstHeadline, type ShowcaseSection } from './showcase-sections';

export interface Showcase {
  sections: ShowcaseSection[];
  coming: { name: string; dueOn: string | null }[];
  picture: { path: string; alt: string } | null;
  line: string | null;
  /** The days something was submitted, newest first, for the "as of" picker. */
  days: string[];
  /** How many showcase-able deliverables exist, and how many are in. */
  total: number;
  have: number;
}

const SUBMITTED = new Set(['submitted', 'revising']);

export async function loadShowcases(
  supabase: any,
  program: any,
  programId: string,
  projectIds: string[],
  opts: { asOf?: string | null } = {}
): Promise<Map<string, Showcase>> {
  const out = new Map<string, Showcase>();
  if (!program || projectIds.length === 0) return out;

  const { data: parts } = await supabase
    .from('participations')
    .select('id, project_id, projects(facts), entry_milestones(name, due_on, completed_on)')
    .eq('program_id', programId)
    .in('project_id', projectIds)
    .in('status', ['entered', 'competed']);

  /* Only what has been submitted, with its fields; a draft is not on the
     showcase and its text is not read. */
  const { data: docs } = await supabase
    .from('documents')
    .select('id, project_id, deliverable, shape_id, status, submitted_at, version_no, document_fields(field_id, value)')
    .in('project_id', projectIds)
    .in('status', ['submitted', 'revising']);

  /* As of a day: the newest version of each document on or before it. */
  let versionsByDoc = new Map<string, any>();
  if (opts.asOf && (docs ?? []).length) {
    const { data: versions } = await supabase
      .from('document_versions')
      .select('document_id, version_no, content, submitted_at')
      .in('document_id', (docs ?? []).map((d: any) => d.id))
      .lte('submitted_at', `${opts.asOf}T23:59:59.999Z`)
      .order('version_no', { ascending: false });
    for (const v of versions ?? []) if (!versionsByDoc.has(v.document_id)) versionsByDoc.set(v.document_id, v);
  }

  for (const pid of projectIds) {
    const part = (parts ?? []).find((p: any) => p.project_id === pid);
    const facts = (part?.projects as any)?.facts ?? {};
    const milestones = part?.entry_milestones ?? [];
    const mine = (docs ?? []).filter((d: any) => d.project_id === pid);

    const sections: ShowcaseSection[] = [];
    const coming: { name: string; dueOn: string | null }[] = [];
    const days = new Set<string>();
    let total = 0, have = 0;
    const seen = new Set<string>();
    for (const step of program.steps ?? []) {
      for (const d of deliverablesFor(program, step, facts)) {
        if (!d.shape || seen.has(d.id)) continue;
        const sh = shapeOf(d.shape);
        if (!sh?.showcase) continue;
        seen.add(d.id);
        total += 1;
        const m = milestones.find((x: any) => x.name === step.name);
        const doc = mine.find((x: any) => x.deliverable === d.id);
        let values: Record<string, any> | null = null;
        let at: string | null = null;
        if (opts.asOf) {
          const v = doc ? versionsByDoc.get(doc.id) : null;
          if (v) { values = v.content ?? {}; at = v.submitted_at; }
        } else if (doc && SUBMITTED.has(doc.status) && doc.submitted_at) {
          values = Object.fromEntries((doc.document_fields ?? []).map((f: any) => [f.field_id, f.value]));
          at = doc.submitted_at;
        }
        if (values) {
          const sec = showcaseSection(sh, values, { key: d.id, deliverable: d.name, at });
          if (sec) { sections.push({ ...sec, at: at ?? sec.at }); have += 1; if (at) days.add(at.slice(0, 10)); continue; }
        }
        coming.push({ name: d.name, dueOn: m?.due_on ?? null });
      }
    }
    /* In the order they were submitted, which is the story of the work. */
    sections.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
    coming.sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));
    out.set(pid, { sections, coming, picture: latestPicture(sections), line: firstHeadline(sections), days: [...days].sort().reverse(), total, have });
  }
  return out;
}
