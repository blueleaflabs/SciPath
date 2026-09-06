/**
 * THE COLOR OF A FAMILY SCORE (2.8).
 *
 * The class reads its tracker by color: 1 red, 2 yellow, 3 green, 4
 * blue, all pale. A score between numbers takes the band below it (a
 * 3.5 is green; only a 4 is blue), which is how the sheet was read.
 * One function, so the deliverables list and the tracker agree.
 */
export function scoreBand(score: number | string | null | undefined): '' | 'band-1' | 'band-2' | 'band-3' | 'band-4' {
  const n = Number(score);
  if (score == null || score === '' || Number.isNaN(n)) return '';
  if (n >= 4) return 'band-4';
  if (n >= 3) return 'band-3';
  if (n >= 2) return 'band-2';
  return 'band-1';
}
