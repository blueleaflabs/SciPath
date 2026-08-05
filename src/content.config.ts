import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Published records. Files in the repository, never rows fetched at request
 * time: the archive has to keep serving if the database is gone.
 *
 * Fields marked [W] are written by the export step from the working surface.
 */
/**
 * Shared by both kinds of published record. An article is a manuscript; a
 * project entry is what a fair produces. They differ in what they contain,
 * not in how they are identified, cited, or indexed, so the schema is one
 * object and `recordKind` says which.
 */
const recordSchema = z.object({
    /** Permanent identifier, e.g. SP-2026-0001. Assigned at publication, never reused. */
    recordId: z.string(),
    /** URL segment. Immutable after publication, even to fix a typo in the title. */
    slug: z.string(),
    title: z.string(),
    /** Ordered. display_name is the byline of record and is stored, never joined. */
    authors: z
      .array(
        z.object({
          displayName: z.string(),
          school: z.string().optional(),
          gradYear: z.number().optional(),
          /** Null for a co-author outside the organization: plain text, no author page. */
          authorSlug: z.string().nullable().default(null),
          affiliationVerified: z.boolean().default(false),
        })
      )
      .min(1),
    /** Empty only on a migrated record that was published without one. */
    abstract: z.string(),
    keywords: z.array(z.string()).max(6).default([]),
    discipline: z.string(),
    publishedOn: z.coerce.date(),
    /** Path in the repository. Never an external drive link. */
    pdf: z.string().optional(),
    figures: z
      .array(z.object({ src: z.string(), caption: z.string(), alt: z.string() }))
      .default([]),
    references: z.array(z.string()).default([]),
    /** Names what each author did and what any mentor did. [W] */
    contributions: z.string().optional(),
    /** Competition record. Facts with dates, no adjectives. [W] */
    entries: z
      .array(
        z.object({
          program: z.string(),
          season: z.string(),
          category: z.string().optional(),
          /** The fair's own, e.g. CHEM047. Displayed, never a key: reassigned next season. */
          entryCode: z.string().optional(),
          placement: z.string().optional(),
          awards: z.array(z.string()).default([]),
          advancedTo: z.string().optional(),
        })
      )
      .default([]),
    dataLinks: z.array(z.object({ label: z.string(), url: z.string().url() })).default([]),
    priorVenue: z.string().optional(),
    license: z.string().default('CC BY 4.0'),
    version: z.number().default(1),
    corrections: z
      .array(z.object({ issuedOn: z.coerce.date(), description: z.string() }))
      .default([]),
    status: z.enum(['published', 'archived', 'retracted']).default('published'),
    retractedOn: z.coerce.date().optional(),
    retractionReason: z.string().optional(),
    updatedAt: z.coerce.date().optional(),

    /* ── Added with the export step ─────────────────────────────────── */

    recordKind: z.enum(['article', 'project']).default('article'),

    /** Month is usually the truth. Rendering a day nobody recorded invents one. */
    datePrecision: z.enum(['month', 'day']).default('month'),

    /** Where the writing lives, so a PDF record says what it is. */
    bodyFormat: z.enum(['full-text', 'pdf-only', 'link-only', 'none']).default('full-text'),

    /** The authoritative version, where somebody else holds it. */
    externalUrl: z.string().url().optional(),

    /** Which path this arrived by. The page must not claim a process it skipped. */
    source: z.enum(['workbench', 'external', 'migrated']).default('workbench'),

    /** True only where this record passed review in this system. */
    reviewed: z.boolean().default(false),

    /**
     * A DOI, if one exists. We mint none: this is a place to record one issued
     * elsewhere, by a fair, a preprint server, or an institution, so a record
     * that has one can be cited by it. Bare, without the https://doi.org
     * prefix, which the page adds.
     */
    doi: z.string().optional(),

    /** A later version of the same record, and the one it replaced. */
    supersedes: z.string().optional(),
    supersededBy: z.string().optional(),

    /** Project entries only. The board, which is the artifact a fair produces. */
    board: z.object({ src: z.string(), alt: z.string() }).optional(),

    /**
     * Text lifted out of an uploaded PDF, for search only. Never rendered:
     * extraction is rough and a reader should see the PDF rather than a
     * flattened approximation of it.
     */
    pdfText: z.string().optional(),
});

const articles = defineCollection({
  loader: glob({ base: './src/content/articles', pattern: '**/*.{md,mdx}' }),
  schema: recordSchema,
});

const projects = defineCollection({
  loader: glob({ base: './src/content/projects', pattern: '**/*.{md,mdx}' }),
  schema: recordSchema,
});

/**
 * Learning content. Public by default here, because the public surface is
 * open to anyone with no account. Organization-specific institutional memory
 * stays on the working surface.
 */
const guides = defineCollection({
  loader: glob({ base: './src/content/guides', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    /** Which lifecycle stage this surfaces in. Attachment, not a library. */
    stage: z
      .enum([
        'question',
        'literature',
        'design',
        'ethics',
        'collection',
        'analysis',
        'communication',
        'judging',
      ])
      .optional(),
    order: z.number().default(50),
    updatedAt: z.coerce.date().optional(),
  }),
});

export const collections = { articles, projects, guides };
