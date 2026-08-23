/**
 * THE NOTEBOOK BUCKET, FROM A SCRIPT.
 *
 * Three scripts write into it — `seed-scenarios` draws showcase images,
 * `seed-publish` writes records and a manifest, `index-records` writes the
 * search index — and only the last one could reach the real bucket. The other
 * two called `getPlatformProxy` and took whatever wrangler's local state
 * offered, which is right on a laptop and silently wrong anywhere else: a
 * cloud seed wrote its images into `.wrangler` on the machine that ran it and
 * said "written to local file storage" while doing it. The demonstration then
 * had a showcase with no pictures and nothing had failed.
 *
 * **The Supabase target decides.** If the rows are going to a deployed
 * project, a bucket on this laptop is never the right answer for the files
 * that belong to them — and asking a person to remember a second flag that
 * has to agree with the first is asking for the run where they do not.
 *
 * The shape returned is R2's own binding: `get`, `put`, `list`. Everything
 * here already speaks it, `src/lib/records-store.ts` included, and a wrapper
 * of a different shape would mean the seed exercised a path the Worker never
 * takes.
 */

import { loadDevVars } from './dev-vars.mjs';

/* Loaded here as well as in the script that imported this, and harmlessly:
   `loadDevVars` fills a variable only where nothing has set one, so a cloud
   run — whose values arrive already set, from `.cloud.vars` by way of
   `reset-cloud` — keeps them. It is here because a module that reads
   configuration and trusts somebody else to have loaded it is a module that
   works until it is imported by the one script that did not. */
loadDevVars();

/**
 * Copy into a fresh ArrayBuffer before writing.
 *
 * Miniflare's proxy serializes everything crossing into the worker, and its
 * decoder asserts on a typed array whose byte offset is not zero. Pagefind
 * hands back Node Buffers, which are views onto a shared pool and therefore
 * almost never start at zero, so writing one straight through fails with an
 * assertion from inside devalue that says nothing about what went wrong.
 *
 * Copying into a fresh ArrayBuffer sidesteps the view entirely. Text passes
 * through untouched. Applied on both paths: the remote one has the same
 * problem for a different reason, since a view over a larger buffer is sent
 * whole by some clients, which for a drawn image means trailing bytes that
 * were never part of it.
 */
function normalize(body) {
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return body;
  return new Uint8Array(body).buffer;
}

function need(name, why) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set, and ${why}.\n` +
        'The four R2 variables are R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID\n' +
        'and R2_SECRET_ACCESS_KEY. Put them in .cloud.vars beside the Supabase\n' +
        'ones. See .dev.vars.example.'
    );
  }
  return value;
}

/** Wrangler's local state, which is what a laptop has. */
async function localBucket() {
  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy();
  const bucket = proxy.env.NOTEBOOK ?? null;

  if (!bucket) {
    await proxy.dispose();
    return null;
  }

  /* `dispose` is not optional. `getPlatformProxy` starts a miniflare runtime
     with open handles, so a script that does not call it prints everything it
     was going to print and then hangs — which reads as the work having failed
     when it succeeded. */
  /* Wrapped rather than handed over bare, so that `normalize` above applies
     to the local path too. It lived in `index-records` and guarded only the
     writes that file made; every other caller was one Buffer away from the
     same assertion. */
  const wrapped = {
    list: (options) => bucket.list(options),
    get: (key) => bucket.get(key),
    put: (key, body, options) => bucket.put(key, normalize(body), options),
  };

  return { bucket: wrapped, remote: false, dispose: () => proxy.dispose() };
}

/** The real bucket, over R2's S3 API, presented as the binding. */
async function remoteBucket() {
  const { AwsClient } = await import('aws4fetch');

  const why = 'the files have to go to the same place as the rows';
  const account = need('R2_ACCOUNT_ID', why);
  const bucketName = need('R2_BUCKET', why);
  const base = `https://${account}.r2.cloudflarestorage.com/${bucketName}`;

  const client = new AwsClient({
    accessKeyId: need('R2_ACCESS_KEY_ID', why),
    secretAccessKey: need('R2_SECRET_ACCESS_KEY', why),
    service: 's3',
    region: 'auto',
  });

  const bucket = {
    async list({ prefix = '', cursor } = {}) {
      const url = new URL(base);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      if (cursor) url.searchParams.set('continuation-token', cursor);

      const response = await client.fetch(url.toString());
      if (!response.ok) throw new Error(`list ${prefix}: ${response.status}`);
      const xml = await response.text();

      const objects = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => ({ key: m[1] }));
      const next = xml.match(/<NextContinuationToken>([^<]+)</)?.[1];

      /* The binding's own shape, so a caller written against a laptop works
         here without knowing which it got. */
      return { objects, truncated: Boolean(next), cursor: next };
    },

    async get(key) {
      const response = await client.fetch(`${base}/${key}`);
      if (!response.ok) return null;

      /* Read once and hand back both readings. A caller may ask for either,
         and a Response body can only be consumed one time. */
      const buffer = await response.arrayBuffer();
      return {
        arrayBuffer: async () => buffer,
        text: async () => new TextDecoder().decode(buffer),
      };
    },

    async put(key, body, options = {}) {
      const response = await client.fetch(`${base}/${key}`, {
        method: 'PUT',
        body: normalize(body),
        headers: {
          'Content-Type': options.httpMetadata?.contentType ?? 'application/octet-stream',
        },
      });
      if (!response.ok) throw new Error(`put ${key}: ${response.status}`);
    },
  };

  return { bucket, remote: true, dispose: async () => {} };
}

/**
 * Open the bucket the rows are going to.
 *
 * `remote` defaults to whatever the Supabase URL says, which is the whole
 * point: one decision, made from the thing that was already decided.
 *
 * Returns null when there is no local bucket to be had, because a checkout
 * with no wrangler state is a normal thing and the seeds that draw pictures
 * carry on without them. A *remote* run never returns null: reaching a
 * deployed project without the credentials to write its files is a mistake,
 * not a degraded mode, and it raises.
 */
export async function openBucket({ url = process.env.PUBLIC_SUPABASE_URL ?? '', remote } = {}) {
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
  const wantRemote = remote ?? !isLoopback;

  return wantRemote ? remoteBucket() : localBucket();
}
