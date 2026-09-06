/**
 * WHICH STEP COMES FIRST (2.8).
 *
 * Three steps due the same day were ordered by whatever the database
 * returned, so the Workbench, the project page and the care table could
 * each name a different "next". The order is the date, then the template's
 * own order (`sort_order`, which is where the step sits in the YAML), then
 * the id so two runs agree. Undated steps sort last.
 */
export function byDueThenOrder(a: { due_on?: string | null; sort_order?: number | null; id?: string }, b: { due_on?: string | null; sort_order?: number | null; id?: string }): number {
  return (
    (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999') ||
    (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
    String(a.id ?? '').localeCompare(String(b.id ?? ''))
  );
}
