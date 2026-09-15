/**
 * HOW FAR ALONG A DOCUMENT IS (2.8, dev-161).
 *
 * Filled of required, which required ones are missing, which run over
 * their word limit — and, since dev-161, whether an upload stands in for
 * the lot. Pure over a shape and its values, so the page, the Elder's
 * grading view and a Node test all read the same rule.
 */

import { sectionsOf, askedOf, type Shape } from './template-resolve.ts';
import { textOf, isFilled } from './field-values.ts';

export function wordCount(text: string | null | undefined): number {
  if (!text) return 0;
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  return words.length;
}

/** How far along a document is: filled of asked, and which required ones are missing. */
export function progressOf(shape: Shape, values: Record<string, any>) {
  const asked = askedOf(shape);
  /* The count is of what is required, because that is what Submit waits
     on. A shape's optional fields (a part filled in later, in the family
     session) are not in it: "8 of 9" with the ninth not required read as
     one thing still missing (2.8). */
  const required = asked.filter((f) => f.required);
  const filled = required.filter((f) => isFilled(f, values[f.id]));
  /* A section that stands in (dev-161, the uploads): one filled field in
     it and nothing is missing, whatever the typed fields say. */
  const standsIn = sectionsOf(shape).filter((s) => s.stands_in).flatMap((s) => s.fields).filter((f) => f.kind !== 'note');
  const uploaded = standsIn.filter((f) => isFilled(f, values[f.id])).length;
  const missing = uploaded > 0 ? [] : required.filter((f) => !isFilled(f, values[f.id]));
  const over = asked.filter((f) => f.max_words != null && wordCount(textOf(f, values[f.id])) > (f.max_words ?? 0));
  return { asked: required.length, filled: filled.length, missing, over, uploaded };
}
