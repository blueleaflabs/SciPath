/**
 * READING THE ARCHIVE.
 *
 * Every public record page goes through here, so the manifest is fetched once
 * per request and the organization is taken from the hostname rather than
 * from anything in the URL. A page cannot accidentally read another school's
 * records because it never gets the chance to name a prefix.
 */

import { activeOrg } from './tenant';
import {
  bucketFrom,
  readManifest,
  visible,
  findRecord,
  authorsOf,
  type Manifest,
  type RecordEntry,
} from './records-store';

export interface Archive {
  org: ReturnType<typeof activeOrg>;
  manifest: Manifest;
  all: RecordEntry[];
  articles: RecordEntry[];
  projects: RecordEntry[];
}

export async function openArchive(context: any): Promise<Archive> {
  const org = activeOrg(context);
  const manifest = await readManifest(bucketFrom(context.locals), org.slug);

  return {
    org,
    manifest,
    all: visible(manifest),
    articles: visible(manifest, 'article'),
    projects: visible(manifest, 'project'),
  };
}

export { findRecord, authorsOf };
export type { RecordEntry };

/**
 * The record's body, which lives in its own file rather than in the manifest.
 * An index page listing forty records should not carry forty full papers.
 */
export async function readBody(
  context: any,
  record: RecordEntry
): Promise<{ markdown: string; frontmatterEnd: number } | null> {
  const org = activeOrg(context);
  const bucket = bucketFrom(context.locals);
  if (!bucket) return null;

  const space = record.recordKind === 'project' ? 'projects' : 'articles';
  const object = await bucket.get(
    `records/${org.slug}/${space}/${record.year}/${record.slug}/record.md`
  );
  if (!object) return null;

  const markdown = await object.text();
  /* Frontmatter is already parsed into the manifest, so the page needs only
     what follows it. */
  const end = markdown.indexOf('\n---', 4);
  return { markdown, frontmatterEnd: end >= 0 ? end + 4 : 0 };
}

export function bodyOf(file: { markdown: string; frontmatterEnd: number } | null): string {
  if (!file) return '';
  return file.markdown.slice(file.frontmatterEnd).trim();
}

/** Records grouped by year, newest first, for the year listings. */
export function byYear(records: RecordEntry[]): [number, RecordEntry[]][] {
  const map = new Map<number, RecordEntry[]>();
  for (const record of records) {
    const list = map.get(record.year) ?? [];
    list.push(record);
    map.set(record.year, list);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]);
}
