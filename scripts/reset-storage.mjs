/**
 * EMPTY THE BUCKET.
 *
 * `supabase db reset` drops the database, but photographs live in R2 and
 * survive it. What is left is a set of objects no row refers to: invisible,
 * because /app/media/ refuses to serve anything without a row pointing at it,
 * and therefore worse than visible. Orphans accumulate silently, they are
 * somebody's uploaded work, and "the reset left nothing behind" has to be
 * true rather than nearly true.
 *
 * **Local by default and remote only when asked**, because a script that
 * empties object storage should be incapable of reaching a real bucket by
 * accident. `--remote` is that asking, and it needs the four `R2_` variables
 * as well: two deliberate acts rather than one.
 *
 * The remote half exists because a cloud project is rebuilt rather than
 * migrated while the schema is still moving, and `supabase db reset --linked`
 * knows nothing about R2. Photographs would survive every rebuild as objects
 * no row refers to — invisible, because `/app/media/` refuses to serve
 * anything without a row pointing at it, and therefore worse than visible.
 * "The reset left nothing behind" has to be true rather than nearly true, and
 * that sentence was only true of the local stack.
 *
 * Usage:
 *   node scripts/reset-storage.mjs
 *   node scripts/reset-storage.mjs --remote --bucket=scipath-notebook
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadDevVars } from './dev-vars.mjs';

/* wrangler reads this file itself on the way to setting up bindings, so this
   changes nothing here today. It is here so all four scripts get their
   configuration the same way, which is what stopped being true and cost an
   evening. */
loadDevVars();

const BINDING = 'NOTEBOOK';
const STATE = '.wrangler/state';

function say(message) {
  console.log(message);
}

const args = process.argv.slice(2);
const remote = args.includes('--remote');

/* ── Guard ────────────────────────────────────────────────────────────────
   Remote credentials in the environment mean the local path could conceivably
   reach a real bucket through the platform proxy. Refuse rather than reason
   about it — and only on the local path, since `--remote` is somebody saying
   the real bucket is what they meant. */
if (!remote) {
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    if (process.env[name]) {
      console.error(
        `\n${name} is set, and this was run without --remote. It empties file\n` +
          'storage, so it refuses to guess which bucket you meant. Unset the\n' +
          'variable, or pass --remote and name the bucket.\n'
      );
      process.exit(1);
    }
  }
}

/**
 * The real bucket, over R2's S3 API.
 *
 * The same route `index-records.mjs` takes for the CI job, for the same
 * reason: there is no wrangler session and no local state directory. The
 * bucket has to be named on the command line rather than defaulted, because
 * the one thing worse than not emptying a bucket is emptying a different one.
 */
async function emptyRemote() {
  const { AwsClient } = await import('aws4fetch');

  const bucketName = args.find((a) => a.startsWith('--bucket='))?.split('=')[1];

  if (!bucketName) {
    console.error(
      '\n--remote needs the bucket named: --bucket=scipath-notebook\n\n' +
        'Not defaulted, because the one thing worse than not emptying a\n' +
        'bucket is emptying a different one.\n'
    );
    process.exit(1);
  }

  const need = (name) => {
    const value = process.env[name];
    if (!value) {
      console.error(`\n${name} is needed for --remote. See .dev.vars.example.\n`);
      process.exit(1);
    }
    return value;
  };

  const account = need('R2_ACCOUNT_ID');
  const base = `https://${account}.r2.cloudflarestorage.com/${bucketName}`;

  const client = new AwsClient({
    accessKeyId: need('R2_ACCESS_KEY_ID'),
    secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
    service: 's3',
    region: 'auto',
  });

  let removed = 0;

  /* Listed and deleted a page at a time rather than gathering every key
     first: a season of notebooks is more than one page, and holding the whole
     list to delete it afterwards is a way to run out of memory on the one
     occasion it matters. */
  for (;;) {
    const url = new URL(base);
    url.searchParams.set('list-type', '2');

    const listed = await client.fetch(url.toString());
    if (!listed.ok) {
      throw new Error(`Could not list ${bucketName}: ${listed.status} ${listed.statusText}`);
    }

    const xml = await listed.text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);

    if (keys.length === 0) break;

    for (const key of keys) {
      const response = await client.fetch(`${base}/${encodeURI(key)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Could not remove ${key}: ${response.status}`);
      }
      removed += 1;
    }
  }

  return { removed, bucketName };
}

async function emptyThroughProxy() {
  const { getPlatformProxy } = await import('wrangler');

  const proxy = await getPlatformProxy({ persist: true });
  const bucket = proxy.env?.[BINDING];

  if (!bucket) {
    await proxy.dispose();
    return null;
  }

  let removed = 0;
  let cursor;

  /* Listing is paginated, and a season of notebooks is more than one page. */
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      await bucket.delete(object.key);
      removed += 1;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  await proxy.dispose();
  return removed;
}

/* Fallback for the case where the proxy cannot start: the local state is a
   directory on disk, and deleting it is what `wrangler` would do anyway. */
function emptyOnDisk() {
  if (!fs.existsSync(STATE)) return 0;
  fs.rmSync(path.join(STATE), { recursive: true, force: true });
  return -1;
}

if (remote) {
  /* No fallback here. Locally, failing to reach the bucket means clearing a
     directory and losing nothing that matters; against a real bucket a
     failure has to be a failure, because the alternative is a reset that
     reports success and leaves somebody's photographs behind. */
  const { removed, bucketName } = await emptyRemote();
  say(`${bucketName}: ${removed} object${removed === 1 ? '' : 's'} removed.`);
} else {
  try {
    const removed = await emptyThroughProxy();

    if (removed === null) {
      say('No file storage binding found. Nothing to empty.');
    } else {
      say(`File storage emptied: ${removed} object${removed === 1 ? '' : 's'} removed.`);
    }
  } catch (error) {
    say(`Could not reach the local bucket (${error.message}). Clearing state on disk.`);
    const result = emptyOnDisk();
    say(result === 0 ? 'No local state to clear.' : 'Local storage state cleared.');
  }
}
