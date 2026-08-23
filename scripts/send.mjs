/**
 * SENDING WHAT IS IN THE OUTBOX.
 *
 * A script for now rather than a scheduled Worker, for the same reason
 * `digest.mjs` is: it can be run by hand against a real queue and read in a
 * terminal, which is how the first sends of anything should be watched. The
 * Worker is this call behind a cron trigger and nothing else.
 *
 *   npm run send            print what would go, send nothing
 *   npm run send -- --send  hand it to the transport
 *
 * `--send` is governed by everything in `transport.ts` and nothing here: the
 * default transport is the console, `@demo.invalid` is refused, and
 * `MAIL_ALLOWLIST` decides who may be written to at all. This flag is not a
 * fourth guard, it is the difference between looking and acting.
 *
 * The window is an hour. Anything older is marked skipped rather than sent,
 * because a queue that has been filling since the outbox was written would
 * otherwise mail everybody a year of arrears on its first run. `--minutes`
 * widens it, which is a thing to do deliberately and never by default.
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars } from './dev-vars.mjs';
import { drain, SINCE_MINUTES } from '../src/lib/notify/drain.ts';

loadDevVars();

const URL_ = process.env.PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SECRET_KEY ?? '';

if (!URL_ || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed. They live in .dev.vars.');
  process.exit(1);
}

const send = process.argv.includes('--send');
const minutes = Number(
  process.argv.find((a) => a.startsWith('--minutes='))?.split('=')[1] ?? SINCE_MINUTES
);

const db = createClient(URL_, KEY, { auth: { persistSession: false } });

const result = await drain(db, process.env, {
  dryRun: !send,
  sinceMinutes: minutes,
});

console.log(`\n${send ? 'Sending' : 'Would send'}, window ${minutes} minutes\n`);
for (const line of result.lines) console.log(line);

console.log(
  `\n${result.sent} ${send ? 'sent' : 'to send'}, ` +
    `${result.skipped} skipped, ${result.failed} failed.`
);

if (!send) console.log('\nNothing was sent. Add -- --send to act.\n');
