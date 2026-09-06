#!/usr/bin/env node
/**
 * THE LIVE POLICIES, APPLIED ONCE THE STACK HAS SETTLED (2.8).
 *
 * `realtime.messages` belongs to the Realtime service, which recreates it
 * after a local `db reset` has already run the migrations. The migration
 * therefore applies the two policies (`live_listen`, `live_speak`) only
 * when the table is there, and this is the step that applies them
 * afterward: one call to `ensure_live_policies()` with the service key.
 * Idempotent; on the hosted project it finds them already there.
 *
 *   node scripts/live-policies.mjs            # the local stack
 *   node scripts/live-policies.mjs --cloud    # the linked project
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';

const cloud = process.argv.includes('--cloud');
if (cloud) loadCloudVars(); else loadDevVars();

const URL_ = process.env.PUBLIC_SUPABASE_URL ?? '';
const SECRET = process.env.SUPABASE_SECRET_KEY ?? '';
if (!URL_ || !SECRET) {
  console.error('\n  PUBLIC_SUPABASE_URL and the service key are needed (see .dev.vars.example).\n');
  process.exit(1);
}

const db = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

/* The service recreates the table a few seconds after the database comes
   back; wait for it rather than fail on the first look. */
let last = '';
for (let i = 0; i < 20; i += 1) {
  const { data, error } = await db.rpc('ensure_live_policies');
  if (error) { console.error(`\n  ensure_live_policies: ${error.message}\n`); process.exit(1); }
  last = String(data);
  if (!last.includes('not here')) break;
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(`  ${last}`);
if (last.includes('not here')) {
  console.error('\n  realtime.messages never appeared. Is the realtime container running? (`npm run db:restart`, then `node scripts/live-policies.mjs`)\n');
  process.exit(1);
}
