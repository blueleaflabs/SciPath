/**
 * EMPTY THE LOCAL BUCKET.
 *
 * `supabase db reset` drops the database, but photographs live in R2 and
 * survive it. What is left is a set of objects no row refers to: invisible,
 * because /app/media/ refuses to serve anything without a row pointing at it,
 * and therefore worse than visible. Orphans accumulate silently, they are
 * somebody's uploaded work, and "the reset left nothing behind" has to be
 * true rather than nearly true.
 *
 * Local only, and the guard is not a flag. It refuses to touch a bucket that
 * is not the Miniflare one on this machine, because a script that empties
 * object storage should be incapable of reaching production even when run by
 * mistake in the wrong directory.
 *
 * Usage:  node scripts/reset-storage.mjs
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

/* ── Guard ────────────────────────────────────────────────────────────────
   Remote credentials in the environment mean this could conceivably reach a
   real bucket through the platform proxy. Refuse rather than reason about it. */
for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
  if (process.env[name]) {
    console.error(
      `\n${name} is set. This script empties file storage and only ever runs\n` +
        'against the local stack. Unset it, or run this somewhere else.\n'
    );
    process.exit(1);
  }
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
