/**
 * PROGRAMS A SCHOOL KEEPS OUT OF SIGHT FOR NOW.
 *
 * The org file's `hidden_until.programs` names templates the school lists
 * but has not opened. A school's own program is seeded as `draft` and is
 * invisible by status. A shared program (a regional or state fair, one
 * row for every school) cannot be drafted for one school without
 * drafting it for all, so the pages that list programs also ask this,
 * per school, by template. Dated like the rest of `hidden_until`.
 */
import type { Org } from '../config/org-shape';

export function hidesProgram(org: Org, templateId: string | null | undefined): boolean {
  const h = org.hiddenUntil;
  if (!h || !templateId || !h.programs.includes(templateId)) return false;
  return new Date().toISOString().slice(0, 10) < h.date;
}
