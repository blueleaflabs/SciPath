#!/usr/bin/env node
/**
 * A BACKUP, RESTORED (2.8).
 *
 * A backup nobody has restored is a hope. This replays the three files
 * `npm run backup` wrote (roles, schema, data, in that order) into the
 * LOCAL stack's database, through `psql` inside the Supabase database
 * container, so no client has to be installed. The local stack is reset
 * first, so what you have afterward is the backup and nothing else.
 *
 * It never restores into the hosted project. Restoring over a live
 * class is a deliberate act done by hand with the connection string from
 * the dashboard, and the three commands to type are printed at the end of
 * `npm run backup`. This script exists so that you have typed them once,
 * against a copy, before the day you need them.
 *
 *   npm run restore:db -- local-data/backups/<ref>-2026-09-08T07-00-00
 */

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadDevVars } from './dev-vars.mjs';
import { requireDocker } from './docker.mjs';

loadDevVars();
requireDocker();

const base = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!base) {
  console.error('\n  Which backup? Pass the base path, without .roles.sql / .schema.sql / .data.sql.\n');
  process.exit(1);
}
if (process.argv.includes('--cloud') || process.argv.includes('--linked')) {
  console.error('\n  This restores into the local stack only. For the hosted project, use the psql\n  commands `npm run backup` prints, by hand, against the connection string from\n  the dashboard.\n');
  process.exit(1);
}

const parts = ['roles', 'schema', 'data'].map((p) => `${base}.${p}.sql`);
for (const f of parts) {
  if (!fs.existsSync(f) || fs.statSync(f).size === 0) {
    console.error(`\n  ${f} is missing or empty, so this set is not a backup. Nothing restored.\n`);
    process.exit(1);
  }
}

/* The database container of the running local stack. */
const ps = spawnSync('docker', ['ps', '--filter', 'name=supabase_db_', '--format', '{{.Names}}'], { encoding: 'utf8' });
const container = (ps.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
if (!container) {
  console.error('\n  The local stack is not running (no supabase_db_ container). `npm run db:start` first.\n');
  process.exit(1);
}

console.log(`\nRestoring ${base} into ${container}\n`);

/* A clean database: drop and recreate the public and app schemas the
   dump will rebuild. The platform's own schemas (auth, storage, realtime)
   stay; the schema dump recreates ours. */
const psql = (sqlOrFile, fromFile = false) => {
  const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'];
  const run = spawnSync('docker', args, { input: fromFile ? fs.readFileSync(sqlOrFile) : sqlOrFile, stdio: ['pipe', 'inherit', 'inherit'] });
  if (run.status !== 0) {
    console.error(`\n  Failed while replaying ${fromFile ? sqlOrFile : 'the reset'}. The local database is now partial; run this again or \`npm run reset\`.\n`);
    process.exit(1);
  }
};

psql('drop schema if exists public cascade; drop schema if exists app cascade; create schema public; grant usage on schema public to anon, authenticated, service_role; grant all on schema public to postgres;');
for (const f of parts) {
  console.log(`  replaying ${f}`);
  psql(f, true);
}
psql("notify pgrst, 'reload schema';");

console.log(`
Restored. The local stack now holds the backup: open http://montavista.localhost:4321
and sign in with a pilot account to look at it.

What this proves: the dump restores and the pages read it. What it does not:
the pictures, which are in the media mirror (npm run backup:media) and are
served from the bucket, not the database.
`);
