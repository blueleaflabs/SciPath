/**
 * THE SHOWCASE, ASSEMBLED FROM THE DELIVERABLES (2.8).
 *
 * A submitted document becomes a section of the project's showcase page
 * by its shape's `showcase` block: a title, a headline field, a hero
 * picture, and the fields shown under them. Nothing is written twice;
 * the deliverable is the showcase. Pure: the page reads and this shapes
 * what it read, so the class gallery and the project page agree.
 */

import { sectionsOf, type Shape, type ShapeField } from './template-resolve.ts';
import { isFilled, textOf } from './field-values.ts';
import { renderMarkdown } from './notes.ts';

export interface ShowcasePicture { path: string; alt: string }
export interface ShowcaseBlock {
  label?: string;
  kind: 'prose' | 'line' | 'list' | 'picture' | 'chips';
  html?: string;
  text?: string;
  items?: string[];
  picture?: ShowcasePicture;
}
export interface ShowcaseSection {
  key: string;
  title: string;
  headline: string | null;
  hero: ShowcasePicture | null;
  blocks: ShowcaseBlock[];
  /** When it was submitted, for the order and the caption. */
  at: string | null;
  /** The deliverable's own name, for the caption and the version picker. */
  deliverable: string;
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

function fieldsOf(shape: Shape): Map<string, ShapeField> {
  const map = new Map<string, ShapeField>();
  for (const sec of sectionsOf(shape)) for (const f of sec.fields) map.set(f.id, f);
  return map;
}

function pictureOf(value: any): ShowcasePicture | null {
  if (!value || typeof value !== 'object' || !value.path || !IMAGE.test(String(value.path))) return null;
  return { path: String(value.path), alt: String(value.name ?? '') };
}

/** The section a document makes, or null when its shape has no showcase or nothing shown is filled. */
export function showcaseSection(shape: Shape | null, values: Record<string, any>, meta: { key: string; deliverable: string; at: string | null }): ShowcaseSection | null {
  const spec = shape?.showcase;
  if (!shape || !spec) return null;
  const fields = fieldsOf(shape);
  const has = (id: string) => { const f = fields.get(id); return Boolean(f) && isFilled(f!, values[id]); };
  const plain = (id: string) => { const f = fields.get(id); return f ? textOf(f, values[id]) : String(values[id] ?? ''); };

  /* A headline is a line of plain words: markdown marks off, one line. */
  const headline = spec.headline && has(spec.headline) ? plain(spec.headline).replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim() : null;
  const hero = spec.hero ? pictureOf(values[spec.hero]) : null;
  const blocks: ShowcaseBlock[] = [];
  for (const item of spec.show ?? []) {
    const ids = item.fields ?? (item.field ? [item.field] : []);
    if (item.as === 'list') {
      const items: string[] = [];
      for (const id of ids) {
        const f = fields.get(id);
        if (!f || !has(id)) continue;
        const v = values[id];
        if (f.kind === 'table' && Array.isArray(v)) {
          /* A table's first column, one line each, skipping empty rows. */
          for (const row of v) { const first = Array.isArray(row) ? String(row[0] ?? '').trim() : ''; if (first) items.push(first); }
        } else items.push(plain(id).trim());
      }
      if (items.length) blocks.push({ kind: 'list', label: item.label, items });
    } else if (item.as === 'chips') {
      const items = ids.filter(has).map((id) => { const f = fields.get(id)!; const p = (f.prompt ?? '').replace(/_{2,}/g, '…').trim(); return p ? `${p.replace(/:$/, '')}: ${plain(id)}` : plain(id); });
      if (items.length) blocks.push({ kind: 'chips', label: item.label, items });
    } else if (item.as === 'picture') {
      for (const id of ids) { const pic = pictureOf(values[id]); if (pic) blocks.push({ kind: 'picture', label: item.label, picture: pic }); }
    } else {
      for (const id of ids) {
        if (!has(id)) continue;
        const f = fields.get(id)!;
        if (item.as === 'prose' || f.kind === 'long') blocks.push({ kind: 'prose', label: item.label, html: renderMarkdown(plain(id)) });
        else blocks.push({ kind: 'line', label: item.label, text: plain(id) });
      }
    }
  }
  if (!headline && !hero && blocks.length === 0) return null;
  return { key: meta.key, title: spec.title, headline, hero, blocks, at: meta.at, deliverable: meta.deliverable };
}

/** The newest picture across sections, for a card's tile. */
export function latestPicture(sections: ShowcaseSection[]): ShowcasePicture | null {
  const dated = [...sections].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  for (const s of dated) {
    if (s.hero) return s.hero;
    const pic = s.blocks.find((b) => b.kind === 'picture')?.picture;
    if (pic) return pic;
  }
  return null;
}

/** The first headline, for a card's one line. */
export function firstHeadline(sections: ShowcaseSection[]): string | null {
  return sections.find((s) => s.headline)?.headline ?? null;
}
