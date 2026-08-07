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

loadDevVars();

const REMOTE = process.argv.includes('--remote');

/* ── Reaching the store ──────────────────────────────────────────────────── */

/**
 * Miniflare's proxy serializes everything crossing into the worker, and its
 * decoder asserts on a typed array whose byte offset is not zero. Pagefind
 * hands back Node Buffers, which are views onto a shared pool and therefore
 * almost never start at zero, so writing one straight through fails with an
 * assertion from inside devalue that says nothing about what went wrong.
 *
 * Copying into a fresh ArrayBuffer sidesteps the view entirely. Text passes
 * through untouched.
 */
function normalize(body) {
  if (typeof body === 'string') return body;
  const bytes = new Uint8Array(body);
  return bytes.buffer;
}

async function localBucket() {
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy();
  const bucket = proxy.env.NOTEBOOK;
  if (!bucket) throw new Error('No NOTEBOOK binding. Check wrangler.jsonc.');
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
    put: (key, body, contentType) =>
      bucket.put(key, normalize(body), { httpMetadata: { contentType } }),
    done: () => proxy.dispose(),
  };
}

/**
 * The real bucket, over R2's S3 API. Used by the CI job, which has no
 * wrangler session and no local state directory.
 */
async function remoteBucket() {
  const { AwsClient } = await import('aws4fetch');

  const account = need('R2_ACCOUNT_ID');
  const bucketName = need('R2_BUCKET');
  const base = `https://${account}.r2.cloudflarestorage.com/${bucketName}`;

  const client = new AwsClient({
    accessKeyId: need('R2_ACCESS_KEY_ID'),
    secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
    service: 's3',
    region: 'auto',
  });

  return {
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const url = new URL(base);
        url.searchParams.set('list-type', '2');
        url.searchParams.set('prefix', prefix);
        if (token) url.searchParams.set('continuation-token', token);

        const response = await client.fetch(url.toString());
        if (!response.ok) throw new Error(`list ${prefix}: ${response.status}`);
        const xml = await response.text();

        for (const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(match[1]);
        token = xml.match(/<NextContinuationToken>([^<]+)</)?.[1];
      } while (token);
      return keys;
    },
    async get(key) {
      const response = await client.fetch(`${base}/${key}`);
      if (!response.ok) return null;
      return { text: () => response.text() };
    },
    async put(key, body, contentType) {
      const response = await client.fetch(`${base}/${key}`, {
        method: 'PUT',
        body,
        headers: { 'Content-Type': contentType },
      });
      if (!response.ok) throw new Error(`put ${key}: ${response.status}`);
    },
    done: () => {},
  };
}

function need(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. See .dev.vars.example.`);
    process.exit(1);
  }
  return value;
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

const store = REMOTE ? await remoteBucket() : await localBucket();

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
