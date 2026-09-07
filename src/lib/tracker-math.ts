/**
 * THE TRACKER'S ARITHMETIC (2.8).
 *
 * A family's, a student's and an assignment's average, from the scores
 * that exist. One function, run on the server for the first paint and in
 * the browser after every change, so the two never disagree.
 */

/** The mean of the numbers among the values, to one decimal, or null. */
export function meanOf(values: (number | string | null | undefined)[]): number | null {
  const nums = values.map((v) => (v == null || v === '' ? NaN : Number(v))).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return null;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10;
}

/** The mean, said: "3.7" or a dash. */
export function meanWord(values: (number | string | null | undefined)[]): string {
  const m = meanOf(values);
  return m === null ? '—' : m.toFixed(1);
}

/** The scores a family may take: whole and half points, four at most. */
export const LEVELS = ['1', '1.5', '2', '2.5', '3', '3.5', '4'] as const;

/** A score as the tracker prints it in a cell: 3 or 3.5. */
export function scoreWord(score: number | string | null | undefined): string {
  if (score == null || score === '') return '';
  const n = Number(score);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
