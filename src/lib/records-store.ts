/**
 * THE PUBLISHED RECORD STORE.
 *
 * Records live in R2, never in the code repository. Three reasons, and the
 * first is the one that settles it:
 *
 * A repository holding students' work couples publishing to shipping code. A
 * takedown becomes a history rewrite, a school's archive sits under our
 * branch protection rather than theirs, and nobody who runs a club has the
 * repository, or git, or a reason to learn either.
 *
 * One prefix per organization, `records/{org}/`, holding the record files and
 * their assets together. That makes separation structural rather than a
 * filter somebody has to remember to write: a page for one school cannot see
 * another's records because it never reads outside its own prefix. It also
 * makes a school leaving a prefix copy rather than an export tool somebody
 * has to build.
 *
 * A manifest sits beside them. Listing an R2 prefix and fetching every object
 * to render an index page would be one request per record; the manifest is
 * one request for all of them, and the record files carry the bodies.
 */

export interface RecordEntry {
  recordId: string;
  recordKind: 'article' | 'project';
  slug: string;
  year: number;
  title: string;
  authors: {
    displayName: string;
    authorSlug: string | null;
    school?: string | null;
    gradYear?: number | null;
    affiliationVerified?: boolean;
  }[];
  abstract: string;
  keywords: string[];
  discipline: string;
  publishedOn: string;
  datePrecision: 'month' | 'day';
  source: 'workbench' | 'external' | 'migrated';
  reviewed: boolean;
  bodyFormat: 'full-text' | 'pdf-only' | 'link-only' | 'none';
  externalUrl?: string | null;
  doi?: string | null;
  pdf?: string | null;
  contributions?: string | null;

  /** The research question, one sentence, under the title. */
  question?: string | null;

  /** What was done, with what, producing what. Short lines, not prose. */
  methods: string[];
  dataSources: string[];
  outputs: string[];
  entries: {
    program: string;
    season?: string | null;
    category?: string | null;
    entryCode?: string | null;
    placement?: string | null;
    awards: string[];
    advancedTo?: string | null;
  }[];
  figures: { src: string; caption: string; alt: string }[];

  /** Up to four, shown above the abstract. Not figures: no numbering, no
   *  reference from the text, and they are about what the work looked like. */
  shots: { src: string; caption: string; alt: string }[];

  /** One address, stored and never fetched. The page shows a still until
   *  somebody presses play. */
  video?: string | null;

  /**
   * Our own still for that video, where one was captured.
   *
   * Declared because `RecordDetail` reads it and the interface did not have
   * it: a published page preferred a poster nobody could store. The
   * alternative on a YouTube record is `i.ytimg.com`, which is a request to
   * somebody else before a reader has pressed anything — so this being
   * absent from the type was the difference between the click-to-load
   * promise holding and not.
   */
  videoPoster?: string | null;
  references: string[];
  dataLinks: { label: string; url: string }[];
  license: string;
  status: 'published' | 'archived' | 'retracted';
  priorVenue?: string | null;
  supersedes?: string | null;
  supersededBy?: string | null;
  /** Indexed, never rendered. Kept out of the manifest; lives in the file. */
  pdfText?: string | null;

  /**
   * Which project this came from, as a one-way digest rather than the id.
   *
   * Two records sharing a project are companions: a paper and the entry for
   * the fair it was presented at. Each page links to the other, which needs
   * something to match on. The manifest is publicly fetchable, so this is a
   * hash rather than the internal identifier.
   */
  projectRef?: string | null;
}

export interface Manifest {
  org: string;
  updatedAt: string;
  records: RecordEntry[];
}

/** Minimal R2 surface, so a test can hand in a map. */
export interface Bucket {
  get(key: string): Promise<any>;
  put(key: string, value: any, opts?: any): Promise<unknown>;
  list?(opts: any): Promise<any>;
  delete?(key: string): Promise<unknown>;
}

export const RECORDS_ROOT = 'records';

/**
 * The prefix is named by the organization's **slug**, never by its row id.
 *
 * Both halves of this system meet here and they used to disagree. Every
 * reader passed `activeOrg(...).id`, the identifier from `src/config/orgs/`,
 * and the two seeds passed `org.id` off a database row, which is the uuid
 * primary key. Same expression, two values, so the seeds wrote
 * `records/<uuid>/manifest.json` while every page read `records/demo/…`.
 *
 * Nothing failed. `readManifest` answers an absent manifest with an empty one
 * so a corrupt file cannot take the archive down, `index-records` discovers
 * prefixes from the store and indexed the uuid, and the showcase rendered
 * *Nothing published yet* — the worst shape a bug can take, because the empty
 * state is a real state and reads as the truth.
 *
 * **The fix is the rename**: the config field is `Org.slug` now, so the two
 * values are spelled differently and TypeScript separates them.
 *
 * **This is not that rule written twice.** The rename protects the typed
 * half. The two callers that got it wrong are `scripts/*.mjs`, plain
 * JavaScript that no type reaches, and they are also where the next seed will
 * be written. So the one place both halves pass through refuses the shape
 * outright. A slug is never uuid-shaped, so it can only fire on the error it
 * names.
 */
export const prefixFor = (org: string) => {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(org)) {
    throw new Error(
      `The record store is keyed by an organization's slug, and "${org}" is a row id. ` +
        'Pass `slug` rather than `id`; a uuid here writes an archive no page can read.'
    );
  }

  return `${RECORDS_ROOT}/${org}`;
};

export const manifestKey = (org: string) => `${prefixFor(org)}/manifest.json`;

/** Where one record's files live, together, so a prefix copy is a whole archive. */
export function keysFor(org: string, record: { recordKind: string; year: number; slug: string }) {
  const space = record.recordKind === 'project' ? 'projects' : 'articles';
  const dir = `${prefixFor(org)}/${space}/${record.year}/${record.slug}`;
  return {
    dir,
    body: `${dir}/record.md`,
    pdf: `${dir}/${record.slug}.pdf`,
    figure: (n: number, ext: string) => `${dir}/fig-${n}.${ext}`,
    /** The public address, which is the same shape as the storage path. */
    url: `/${space}/${record.year}/${record.slug}/`,
  };
}

/**
 * The public path for an asset, served back through `/records/`.
 *
 * **The organization comes off, and that is the whole point of the route.**
 * `/records/[...key]` prepends `records/{slug}/` from the hostname, and its
 * own comment says why: "one school's address cannot reach another's files
 * even by guessing a key: the prefix is prepended here rather than taken from
 * the URL." A URL that carries the prefix is a URL somebody can edit.
 *
 * This stripped `records/` alone and left the slug behind, so every published
 * asset was addressed `/records/demo/articles/…` and the route looked up
 * `records/demo/demo/articles/…`. One 404 per PDF, per figure, per showcase
 * image, on a path nothing had ever exercised because no seeded record had
 * ever reached a page.
 *
 * Refused rather than trimmed when the key is the wrong shape. This runs
 * while a record is being assembled, so a throw here stops a publication;
 * silently producing a plausible URL puts a dead link on a permanent page.
 */
export function assetUrl(key: string): string {
  const parts = key.split('/');

  if (parts[0] !== RECORDS_ROOT || parts.length < 3) {
    throw new Error(
      `"${key}" is not a key in the record store, so it has no public address. ` +
        `Keys are ${RECORDS_ROOT}/{org}/…`
    );
  }

  return `/${RECORDS_ROOT}/${parts.slice(2).join('/')}`;
}

export function bucketFrom(locals: any): Bucket | null {
  return (locals?.runtime?.env?.NOTEBOOK as Bucket) ?? null;
}

export async function readManifest(bucket: Bucket | null, org: string): Promise<Manifest> {
  const empty: Manifest = { org, updatedAt: new Date(0).toISOString(), records: [] };
  if (!bucket) return empty;

  const object = await bucket.get(manifestKey(org));
  if (!object) return empty;

  try {
    const text = typeof object.text === 'function' ? await object.text() : String(object);
    const parsed = JSON.parse(text) as Manifest;
    return { ...empty, ...parsed, records: parsed.records ?? [] };
  } catch {
    /* A corrupt manifest must not take the archive down. An empty one shows
       an honest empty state; a thrown error shows a stack trace. */
    return empty;
  }
}

export async function writeManifest(bucket: Bucket, manifest: Manifest): Promise<void> {
  await bucket.put(manifestKey(manifest.org), JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * Add or replace one record. Republishing after a correction is the same call,
 * which is why this matches on the identifier rather than appending.
 */
export function upsert(manifest: Manifest, record: RecordEntry): Manifest {
  const rest = manifest.records.filter((r) => r.recordId !== record.recordId);
  return {
    ...manifest,
    updatedAt: new Date().toISOString(),
    records: [...rest, record].sort((a, b) => b.publishedOn.localeCompare(a.publishedOn)),
  };
}

/**
 * TAKE ONE OUT.
 *
 * The mirror of `upsert`, and it did not exist: an account deletion removed a
 * record's rows from the database and left its public page, its files and its
 * manifest entry exactly where they were. The archive is static, so a record
 * with no row behind it does not stop being readable — it stops being
 * *listed*, which is worse: still at its address, still in search, and no
 * longer reachable by anybody who could ask for it to come down.
 *
 * Matching on the identifier rather than the slug, because two records can
 * share a slug across years and the identifier is what the row carried.
 */
export function withdraw(manifest: Manifest, recordId: string): Manifest {
  return {
    ...manifest,
    updatedAt: new Date().toISOString(),
    records: manifest.records.filter((r) => r.recordId !== recordId),
  };
}

/**
 * Every object belonging to one record, so a caller can remove them.
 *
 * Listed rather than derived from `keysFor`, because a record's directory
 * accumulates: figures added after publication, a regenerated PDF, a bundle.
 * Deriving the names would delete the ones this file happens to know about
 * and leave the rest as orphans nobody lists.
 */
export async function objectsFor(
  bucket: Bucket,
  org: string,
  record: { recordKind: string; year: number; slug: string }
): Promise<string[]> {
  if (!bucket.list) return [];

  const space = record.recordKind === 'project' ? 'projects' : 'articles';
  const prefix = `${prefixFor(org)}/${space}/${record.year}/${record.slug}/`;

  const keys: string[] = [];
  let cursor: string | undefined;

  do {
    const page: any = await bucket.list({ prefix, cursor });
    keys.push(...(page.objects ?? []).map((o: any) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return keys;
}

/** Everything a reader should see, newest first. */
export function visible(manifest: Manifest, kind?: 'article' | 'project'): RecordEntry[] {
  return manifest.records
    .filter((r) => r.status !== 'archived')
    .filter((r) => !kind || r.recordKind === kind);
}

export function findRecord(
  manifest: Manifest,
  kind: 'article' | 'project',
  year: number,
  slug: string
): RecordEntry | null {
  return (
    manifest.records.find(
      (r) => r.recordKind === kind && r.year === year && r.slug === slug && r.status !== 'archived'
    ) ?? null
  );
}

/**
 * The other record for the same project, where there is one.
 *
 * `supersedes` is deliberately not this relationship: it means a later
 * version of the same record, and using it here would tell a reader the
 * entry had been replaced when it had not.
 */
export function companionOf(
  records: RecordEntry[],
  record: RecordEntry
): RecordEntry | null {
  if (!record.projectRef) return null;
  return (
    records.find(
      (r) => r.projectRef === record.projectRef && r.recordId !== record.recordId
    ) ?? null
  );
}

/** Author pages, topic pages, and the byline index all need this shape. */
export function authorsOf(records: RecordEntry[]) {
  const byline = new Map<string, { slug: string; name: string; records: RecordEntry[] }>();

  for (const record of records) {
    for (const author of record.authors) {
      if (!author.authorSlug) continue;
      const held = byline.get(author.authorSlug) ?? {
        slug: author.authorSlug,
        name: author.displayName,
        records: [],
      };
      held.records.push(record);
      byline.set(author.authorSlug, held);
    }
  }

  return [...byline.values()].sort((a, b) => a.name.localeCompare(b.name));
}
