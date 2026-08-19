/**
 * THE MIGRATIONS, AS ONE STRING.
 *
 * Every check that reads the schema named `0001_identity_and_tenancy.sql`
 * directly — twelve call sites across eight files — which was correct for as
 * long as there was one migration and silently wrong the moment there were
 * two. `0002` was added the day `0001` became immutable (11.7), and every one
 * of those checks would have gone on passing while covering less than it said.
 *
 * That is 19.9's oldest shape: **a check that names its inputs stops covering
 * the thing it was written for the moment somebody adds a file, and the only
 * signal is that it keeps passing.** The secrets scan went from 2 files to
 * 220 for the same reason; the contrast floor missed a color pair nobody had
 * listed; the config-source scan missed `astro.config.mjs`.
 *
 * So: read the directory, sorted, joined. Sorted because a numbered migration
 * is applied in order and a `create` in `0001` must precede a `grant` in
 * `0002` for any check reading position. Joined with newlines so a pattern
 * cannot match across the seam between two files.
 *
 * Fails rather than returning empty if the directory holds nothing, because a
 * schema check reading no schema is the failure this file exists to prevent.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'supabase/migrations';

/** Every migration, in the order Postgres applies them. */
export function migrationFiles() {
  const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(DIR, f));

  assert.ok(files.length > 0, `no migrations in ${DIR}`);

  return files;
}

/** All of them as one string. What a check that greps the schema wants. */
export function migrationSql() {
  return migrationFiles()
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}
