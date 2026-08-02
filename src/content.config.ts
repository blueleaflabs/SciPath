import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * Published records. Files in the repository, never rows fetched at request
 * time: the archive has to keep serving if the database is gone.
 *
 * Fields marked [W] are written by the export step from the working surface.
 */
const articles = defineCollection({
  loader: glob({ base: './src/content/articles', pattern: '**/*.{md,mdx}' }),
  schema: z.object({
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
  }),
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

export const collections = { articles, guides };
