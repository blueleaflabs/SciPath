/**
 * WHAT A GENERATED FILE IS CALLED (2.8).
 *
 * Every file SciPath hands out (a drawn graphic, its slide, a document or
 * notebook saved as PDF) is named the same way, so a teacher's download
 * folder sorts itself:
 *
 *     <program><season>-<full name>-<deliverable>-<date>-<time>
 *
 * e.g. `irpd2027-Vikram Mallya-Project summary-2026-09-06-1743`. The
 * program part is the short name and the season year, lower case, run
 * together; the rest is kept as written, with only the characters a file
 * system refuses replaced.
 */

export interface ProgramNamed { short_name?: string | null; name?: string | null; season_year?: number | null }

export function programSlug(program: ProgramNamed | null | undefined): string {
  const stem = (program?.short_name || program?.name || 'scipath').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${stem}${program?.season_year ?? ''}`;
}

export function safePart(text: string): string {
  return String(text ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The date and time part, in the given zone, as `YYYY-MM-DD-HHMM`. */
export function stampFor(at: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}-${get('hour').replace('24', '00')}${get('minute')}`;
}

/** The name without its extension. */
export function exportName(program: ProgramNamed | null | undefined, who: string, what: string, at = new Date(), timeZone?: string): string {
  return [programSlug(program), safePart(who), safePart(what), stampFor(at, timeZone)].filter(Boolean).join('-');
}
