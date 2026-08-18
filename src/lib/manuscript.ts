/**
 * Between the database and the check.
 *
 * The check is pure and takes a snapshot. This builds the snapshot from rows
 * and takes no client of its own, so it can be exercised without a database
 * and cannot become a second place where authorization is decided.
 */

import { toDate } from './dates';
import type { ManuscriptSnapshot } from './structure';
import type { RecordKind } from '../config/structure';

export interface ManuscriptRow {
  id: string;
  record_kind: string;
  source: string;
  title: string;
  abstract: string | null;
  keywords: string[] | null;
  discipline: string | null;
  contributions: string | null;
  license: string;
  completed_on: string | null;
  date_precision: string;
  body_format: string;
  external_url: string | null;
  pdf_path: string | null;
  updated_at: string;
}

export interface SectionRow {
  section_key: string;
  body: string;
  updated_at: string;
  updated_by?: string | null;
}

export interface FigureRow {
  id: string;
  number: number;
  storage_path: string;
  caption: string;
  alt: string;
}

export function toSnapshot(input: {
  manuscript: ManuscriptRow;
  sections: SectionRow[];
  figures: FigureRow[];
  references: { citation: string }[];
  authors: { displayName: string; accepted: boolean }[];
  entryCount: number;
}): ManuscriptSnapshot {
  const m = input.manuscript;

  return {
    recordKind: (m.record_kind as RecordKind) ?? 'article',
    source: (m.source as ManuscriptSnapshot['source']) ?? 'workbench',
    bodyFormat: (m.body_format as ManuscriptSnapshot['bodyFormat']) ?? 'full-text',
    title: m.title ?? '',
    abstract: m.abstract,
    keywords: m.keywords ?? [],
    discipline: m.discipline,
    contributions: m.contributions,
    externalUrl: m.external_url,
    pdfPath: m.pdf_path,
    sections: input.sections.map((s) => ({ key: s.section_key, body: s.body ?? '' })),
    figures: input.figures.map((f) => ({ number: f.number, caption: f.caption, alt: f.alt })),
    references: input.references.map((r) => r.citation),
    authors: input.authors,
    entryCount: input.entryCount,
  };
}

/**
 * Parsing a keyword field. People type commas, semicolons, and newlines, and
 * arguing with them about which is correct is not a use of anybody's time.
 */
export function parseKeywords(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/** References arrive as a block, one per line, because that is how people have them. */
export function parseReferences(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export const recordKindLabel: Record<string, string> = {
  article: 'Article',
  project: 'Project entry',
};

export const bodyFormatLabel: Record<string, string> = {
  'full-text': 'Written here, section by section',
  'pdf-only': 'A finished PDF',
  'link-only': 'Published elsewhere, this is a landing page',
  none: 'No written paper',
};

export const sourceLabel: Record<string, string> = {
  workbench: 'Written here',
  external: 'Brought in finished',
  migrated: 'Migrated from an earlier archive',
};

/**
 * Month precision is the honest default. Rendering a day for work known only
 * to the month invents one, and it does it on every page, forever.
 */
export function formatCompleted(iso: string | null, precision: string): string {
  const date = toDate(iso);
  if (!date) return 'Not set';
  return precision === 'day'
    ? date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}
