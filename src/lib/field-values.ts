/**
 * A FIELD'S VALUE, READ (6.16).
 *
 * What a stored value is as text, and whether it counts as filled. Here
 * rather than in documents.ts so that the pure readers (the showcase's
 * section builder, the tests) can take them without the template
 * registry, which only Vite can load. documents.ts re-exports them.
 */
import type { ShapeField } from './template-resolve.ts';

/** What a field's stored value is, as the page shows it. */
export function textOf(field: ShapeField, value: any): string {
  if (value == null) return '';
  if (field.kind === 'choices') return Array.isArray(value) ? value.join(', ') : String(value);
  if (field.kind === 'file' || field.kind === 'graphic') return value?.name ?? value?.path ?? '';
  return String(value);
}

export function isFilled(field: ShapeField, value: any): boolean {
  if (field.kind === 'note') return true;
  if (value == null) return false;
  if (field.kind === 'choices') return Array.isArray(value) && value.length > 0;
  if (field.kind === 'file' || field.kind === 'graphic') return Boolean(value?.path);
  /* A table counts when any cell is written; a rubric when any row is marked.
     `String({})` is "[object Object]", which counted an empty grid as done. */
  if (Array.isArray(value)) return value.some((row) => (Array.isArray(row) ? row.some((c) => String(c ?? '').trim()) : String(row ?? '').trim()));
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return String(value).trim().length > 0;
}

/**
 * The words of a section's tally (dev-152): "2 of 3 interviews written ·
 * 5 is the goal". Here so the server's first render and the page's live
 * count say the same thing.
 */
export function tallyWords(n: number, t: { singular: string; plural: string; min?: number; goal?: number }): string {
  const noun = (k: number) => (k === 1 ? t.singular : t.plural);
  const parts: string[] = [];
  if (t.min != null) parts.push(`${n} of ${t.min} ${noun(t.min)} written`);
  else parts.push(`${n} ${noun(n)} written`);
  if (t.goal != null && n < t.goal) parts.push(`${t.goal} is the goal`);
  if (t.goal != null && n >= t.goal) parts.push('the goal is met');
  return parts.join(' · ');
}
