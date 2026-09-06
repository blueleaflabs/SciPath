#!/usr/bin/env node
/**
 * A COPY OF THE DATABASE, ON DISK, THAT SOMEBODY HAS RESTORED ONCE.
 *
 * 19.11 says there is no down migration and that a mistake in the cloud
 * project "costs a restore". A restore needs a backup that exists, and until
 * now nothing in this repository made one. The whole recovery story was a
 * sentence in a document.
 *
 * **This is deliberately the least clever thing that works.** It shells out
 * to `supabase db dump` through the same wrapper every other command uses, so
 * it needs no new credential, no connection string, and no Postgres client on
 * the machine: the CLI is already linked, and the link is already checked
 * against `.cloud.vars` by `reset-cloud`. A backup tool that needs its own
 * configuration is a backup tool nobody runs.
 *
 * ── Roles, schema and data, in that order ─────────────────────────────────
 *
 * `supabase db dump` writes one of three things and the default is schema
 * only, which is the one that would restore an empty database over a class's
 * work while reporting success. So all three are written, named, and the
 * order they must be replayed in is printed at the end rather than left to be
 * worked out under pressure.
 *
 * ── What this does not do ─────────────────────────────────────────────────
 *
 * It does not touch R2. Notebook photographs, signed forms and the published
 * record store live there and are not in any dump. That is a real gap and it
 * is said out loud at the end of a run rather than discovered during a
 * restore.
 *
 * It does not upload anywhere. A file in `local-data/backups/` is on one
 * laptop, which is better than nothing and worse than off-site. Copy it
 * somewhere else; the run says so.
 *
 *   npm run backup                # the local stack
 *   npm run backup -- --cloud     # the linked project
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';

const args = process.argv.slice(2);
const cloud = args.includes('--cloud');

if (cloud) loadCloudVars();
else loadDevVars();

function fail(message) {
  console.error(`\n  ${message.replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

const URL_ = process.env.PUBLIC_SUPABASE_URL ?? '';
const ref = URL_.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] ?? null;

if (cloud && !ref) {
  fail(
    `PUBLIC_SUPABASE_URL is ${URL_ || 'not set'}, which is not a deployed project.\n\n` +
      'Put the project URL in .cloud.vars. Without --cloud this dumps the\n' +
      'local stack instead.'
  );
}

/* `local-data/` because a dump is every student's work in one file: their
   names, their addresses, their guardians' answers. It is gitignored and it
   is where the one other file naming real people already lives (11.7). */
const DIR = 'local-data/backups';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const label = cloud ? (ref ?? 'cloud') : 'local';
const base = path.join(DIR, `${label}-${stamp}`);

fs.mkdirSync(DIR, { recursive: true });

/**
 * Three dumps, and the third is the one that matters.
 *
 * A schema-only dump restores a database with the right shape and nobody in
 * it, which is the failure this whole file exists to prevent. Named so the
 * three cannot be confused for one another on the day somebody is reading a
 * directory listing at speed.
 */
const PARTS = [
  { flag: '--role-only', name: 'roles', why: 'the roles the policies name' },
  { flag: null, name: 'schema', why: 'tables, policies, functions, triggers' },
  { flag: '--data-only', name: 'data', why: "everybody's work" },
];

console.log(`\nBacking up ${cloud ? ref : 'the local stack'}\n`);

for (const part of PARTS) {
  const file = `${base}.${part.name}.sql`;

  const argv = ['scripts/supabase.mjs', 'db', 'dump', '-f', file];
  if (cloud) argv.push('--linked');
  if (part.flag) argv.push(part.flag);

  const run = spawnSync('node', argv, { stdio: 'inherit', env: process.env });

  if (run.status !== 0) {
    fail(
      `The ${part.name} dump failed, so this backup is incomplete.\n\n` +
        'Anything already written is in ' + DIR + ' and is not a backup on its\n' +
        'own. Do not treat a partial set as one.'
    );
  }

  /* An empty file is the shape a failed dump takes when the command exits
     zero, which is the reading nobody double-checks. */
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size === 0) {
    fail(`${file} came back empty, so the ${part.name} dump wrote nothing.`);
  }

  console.log(`  ${(size / 1024).toFixed(0).padStart(6)} KB  ${part.name}  ${part.why}`);
}

console.log(`
Written to ${DIR}/

To restore, replay them in this order against an empty database:

  psql "$CONNECTION" -f ${base}.roles.sql
  psql "$CONNECTION" -f ${base}.schema.sql
  psql "$CONNECTION" -f ${base}.data.sql

Two things this does not cover, said here rather than found during a restore:

  R2 holds the notebook photographs, the signed forms and the published
  record store. None of it is in a dump.

  This file is on one machine. Copy it somewhere else today, and restore one
  once before you need to. A backup nobody has restored is a hope.
`);
