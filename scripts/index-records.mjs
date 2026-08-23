/**
 * INDEXING PUBLISHED RECORDS.
 *
 * Records live in the record store, not in the repository, so nothing about
 * them is present when the site is built. Pagefind's CLI crawls a directory
 * of built HTML and is therefore the wrong tool here. Its Node API is the
 * right one: `addCustomRecord` takes content directly, and `getFiles` returns
 * the index in memory, which goes straight back into the store.
 *
 * The indexer is a native binary and cannot run in a Worker, so this runs
 * where Node runs: locally as `npm run index:records`, and in CI on a
 * dispatch fired by publishing.
 *
 * That split is the point. **Publishing does not wait for this.** A record is
 * readable the moment it is written and findable a minute later, which is the
 * right way round: a record nobody can find is a nuisance, a record nobody
 * can read is a broken link.
 *
 * Usage:
 *   node scripts/index-records.mjs            local bucket via wrangler
 *   node scripts/index-records.mjs --remote   the real bucket, via S3
 */

import * as pagefind from 'pagefind';
import { loadDevVars } from './dev-vars.mjs';
import { openBucket } from './notebook-bucket.mjs';

loadDevVars();

const REMOTE = process.argv.includes('--remote');

/* ── Reaching the store ──────────────────────────────────────────────────── */

/**
 * The bucket, and the wrapper this file wants over it.
 *
 * `openBucket` returns R2's own binding shape, local or real, chosen from the
 * Supabase target. This adds the two conveniences the indexer uses: a `list`
 * that follows the cursor to the end, and a `put` that takes a content type
 * directly. Both used to be written twice here, once per bucket, which is how
 * the local and remote paths came to disagree about what `get` returns.
 */
async function openStore() {
  const store = await openBucket({ url: process.env.PUBLIC_SUPABASE_URL ?? '', remote: REMOTE });

  if (!store) throw new Error('No NOTEBOOK binding. Check wrangler.jsonc.');

  const { bucket } = store;

  return {
    bucket,
    async list(prefix) {
      const out = [];
      let cursor;
      do {
        const page = await bucket.list({ prefix, cursor });
        out.push(...page.objects.map((o) => o.key));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return out;
    },
    get: (key) => bucket.get(key),
    put: (key, body, contentType) => bucket.put(key, body, { httpMetadata: { contentType } }),
    done: () => store.dispose(),
  };
}

/* ── Indexing ────────────────────────────────────────────────────────────── */

/**
 * What Pagefind is given per record. Body text where there is one, the
 * extracted PDF text where the paper is a file, and the abstract either way,
 * so a PDF-only record is findable by its argument rather than by its title
 * alone.
 */
/**
 * Pagefind's client fetches its own assets and some of them are fussy about
 * what they are served as. Everything else is bytes it decodes itself.
 */
function contentTypeFor(path) {
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  if (path.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}

function contentFor(record, body) {
  return [
    record.title,
    record.authors.map((a) => a.displayName).join(', '),
    record.abstract,
    record.keywords.join(' '),
    record.contributions ?? '',
    record.entries.map((e) => [e.program, e.category, e.placement, ...e.awards].filter(Boolean).join(' ')).join(' '),
    body,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Frontmatter is already in the manifest; the file carries the prose. */
function bodyOf(markdown) {
  const end = markdown.indexOf('\n---', 4);
  return end >= 0 ? markdown.slice(end + 4).trim() : markdown.trim();
}

async function indexOrg(store, org) {
  const manifestKey = `records/${org}/manifest.json`;
  const object = await store.get(manifestKey);
  if (!object) return { org, records: 0, skipped: true };

  const manifest = JSON.parse(await object.text());
  const records = (manifest.records ?? []).filter((r) => r.status !== 'archived');

  const { index } = await pagefind.createIndex();

  for (const record of records) {
    const space = record.recordKind === 'project' ? 'projects' : 'articles';
    const key = `records/${org}/${space}/${record.year}/${record.slug}/record.md`;

    const file = await store.get(key);
    const markdown = file ? await file.text() : '';
    const body = markdown ? bodyOf(markdown) : '';

    /* pdfText lives in the file's frontmatter rather than the manifest, so it
       is picked up with the body and never rendered. */
    const pdfText = markdown.match(/^pdfText: >-\n([\s\S]*?)\n[a-zA-Z]/m)?.[1] ?? '';

    await index.addCustomRecord({
      url: `/${space}/${record.year}/${record.slug}/`,
      content: contentFor(record, `${body}\n${pdfText}`),
      language: 'en',
      meta: {
        title: record.title,
        authors: record.authors.map((a) => a.displayName).join(', '),
      },
      filters: {
        discipline: [record.discipline],
        year: [String(record.year)],
        kind: [record.recordKind],
      },
    });
  }

  const { files } = await index.getFiles();

  for (const file of files) {
    await store.put(
      `records/${org}/pagefind/${file.path}`,
      file.content,
      contentTypeFor(file.path)
    );
  }

  await index.deleteIndex();
  return { org, records: records.length, files: files.length };
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

const store = await openStore();

/* Every organization with a manifest. Discovered from the store rather than
   from the config, so this works the same in CI where the config is not
   necessarily current. */
const manifests = (await store.list('records/')).filter((k) => k.endsWith('/manifest.json'));
const orgs = manifests.map((k) => k.split('/')[1]);

if (orgs.length === 0) {
  console.log('No published records yet. Nothing to index.');
} else {
  for (const org of orgs) {
    const result = await indexOrg(store, org);
    console.log(
      result.skipped
        ? `${org}: no manifest`
        : `${org}: ${result.records} records, ${result.files} index files`
    );
  }
}

await pagefind.close();
await store.done();
