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
/*
 * There were `articles` and `projects` collections here, loading markdown out
 * of src/content/. Published records moved to the record store, so nothing
 * read them and the loader warned at every startup that its directory did not
 * exist. A collection nobody reads is a trap: the next person to open this
 * file assumes records live in the repository, which is the arrangement the
 * store exists to replace.
 *
 * The schema itself is not gone. It is `RecordEntry` in src/lib/records-store,
 * which is what the manifest holds and what the pages render.
 */

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

export const collections = { guides };
