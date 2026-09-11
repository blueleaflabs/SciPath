/**
 * WHICH RECORDS LEAD THE SHOWCASE (dev-149).
 *
 * The front of the showcase shows a handful of records with covers before
 * the full list. A school may name them in its file (`featured`, record
 * ids in order); this fills whatever is left from the archive by one fixed
 * rule, so the choice is the same on every request and explainable to the
 * student who asks why theirs is not there:
 *
 *   1. on a demonstration tenant only, the invented record with pictures
 *      (the fair entry) — the one a visitor should click first, because it
 *      is the one whose page has the pictures, the still and the abstract
 *      a demonstration is for;
 *   2. the school's own list, in its order, for ids that exist;
 *   3. then records with a placement, an award, or an advancement;
 *   4. then reviewed papers;
 *   5. then the rest — newest first within each step.
 *
 * Invented records are otherwise never chosen: on a real school there are
 * none, and on the demonstration tenant the one that leads is the one that
 * has something to show. Pure: the page reads, this chooses.
 */

import type { RecordEntry } from './records-store';

const MAX = 6;

function honored(r: RecordEntry): boolean {
  return r.entries.some((e) => Boolean(e.placement) || e.awards.length > 0 || Boolean(e.advancedTo));
}

function newest(a: RecordEntry, b: RecordEntry): number {
  return b.publishedOn.localeCompare(a.publishedOn);
}

export function featuredRecords(
  org: { featured?: string[]; demo?: boolean } | null | undefined,
  records: RecordEntry[],
  max = MAX
): RecordEntry[] {
  const live = records.filter((r) => r.status === 'published');
  const pool = live.filter((r) => !r.demonstration);
  /* The school's list may name anything that is live, an invented record
     included; the rule below never picks one on its own. */
  const byId = new Map(live.map((r) => [r.recordId, r]));
  const chosen: RecordEntry[] = [];
  const taken = new Set<string>();

  const take = (r: RecordEntry | undefined) => {
    if (!r || taken.has(r.recordId) || chosen.length >= max) return;
    taken.add(r.recordId);
    chosen.push(r);
  };

  if (org?.demo) {
    const shown = live
      .filter((r) => r.demonstration && r.shots.length > 0)
      .sort((a, b) => (a.recordKind === 'project' ? -1 : 1) - (b.recordKind === 'project' ? -1 : 1));
    take(shown[0]);
  }

  for (const id of org?.featured ?? []) take(byId.get(id));

  const rest = pool.filter((r) => !taken.has(r.recordId));
  for (const r of rest.filter(honored).sort(newest)) take(r);
  for (const r of rest.filter((x) => !honored(x) && x.reviewed).sort(newest)) take(r);
  for (const r of rest.filter((x) => !honored(x) && !x.reviewed).sort(newest)) take(r);

  return chosen;
}
