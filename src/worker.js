import { createExports as astroExports } from '@astrojs/cloudflare/entrypoints/server.js';

/**
 * THE WORKER, WITH A CLOCK.
 *
 * Astro's Cloudflare adapter builds a Worker exporting `fetch` and nothing
 * else, so there was nowhere for a cron trigger to arrive. This is that entry
 * with `scheduled` added beside it; `fetch` is unchanged and delegates to the
 * adapter exactly as before.
 *
 * **Why cron rather than sending inside a request.** Every field on the
 * outbox presumes a drain: `send_after` so a burst becomes one message,
 * `dedupe_key` unique per recipient so a replay cannot double one, `attempts`
 * and `last_error` so a failure can be retried. Sending at the moment of a
 * click would leave all of that unused and would put a mail provider's
 * latency inside a student's page load.
 *
 * **The schedule is deliberately a year away.** `0 0 1 1 *` is midnight on
 * the first of January. Nothing in the queue has ever been sent, no message
 * has been read by anybody outside this project, and a trigger that starts
 * firing the moment it is deployed would make the first real send an
 * unattended one. The wiring is what needed proving; the hour is a one-line
 * change in `wrangler.jsonc` when somebody has watched `npm run send` do the
 * same work by hand and is willing to own it.
 *
 * A scheduled invocation has no request, no session and no tenant. Everything
 * it touches is therefore addressed explicitly — which is why the drain takes
 * its database client rather than building one.
 */

export function createExports(manifest) {
  /* The adapter's own entry, wrapped rather than reimplemented. Its request
     handling is not public API — the `handle` it calls is an internal path —
     and a copy of it here would be a second copy to keep in step with the
     adapter through every upgrade. */
  const { default: astro } = astroExports(manifest);

  return {
    default: {
      ...astro,

      /**
       * A cron trigger.
       *
       * `waitUntil` rather than an awaited call: Cloudflare ends the
       * invocation when the handler returns, and a drain that is still
       * sending when that happens is a set of messages marked claimed and
       * never delivered.
       */
      scheduled: async (event, env, context) => {
        context.waitUntil(runScheduled(event, env));
      },
    },
  };
}

async function runScheduled(event, env) {
  /* Imported here rather than at the top of the file. This module is the
     Worker's entry, so anything imported at its top is in the bundle for
     every request — including the mail transport, which no page has any use
     for. */
  const { createClient } = await import('@supabase/supabase-js');
  const { drain } = await import('./lib/notify/drain.ts');

  const url = env.PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;

  if (!url || !key) {
    console.error('scheduled: no Supabase credentials bound, nothing was drained');
    return;
  }

  const db = createClient(url, key, { auth: { persistSession: false } });

  try {
    const result = await drain(db, env, { dryRun: false });

    /* Logged, because a scheduled run has nobody watching it. A count in the
       Worker log is the only evidence that the trigger fired at all, and its
       absence is how a silently unbound cron is noticed. */
    console.log(
      `scheduled ${event.cron}: ${result.sent} sent, ` +
        `${result.skipped} skipped, ${result.failed} failed`
    );
  } catch (e) {
    console.error(`scheduled ${event.cron}: ${String(e?.message ?? e)}`);
  }
}
