#!/usr/bin/env node
/**
 * OPEN OR HIDE A PROGRAM THAT IS ALREADY SEEDED.
 *
 * A school's org file can keep a listed program out of sight
 * (`hidden_until.programs`), and `seed-programs` writes it as `draft`.
 * Opening it later, on a live project, must not be a reseed: this flips
 * the one row.
 *
 *   npm run programs:status -- mvhs-scvsefa-2027 open
 *   npm run programs:status -- mvhs-scvsefa-2027 draft
 *   npm run programs:status -- mvhs-scvsefa-2027 open --cloud
 *   npm run programs:status -- mvhs-scvsefa-2027 open --org montavista
 *
 * `--org` names the school where two schools run the same template; a
 * shared program (a regional fair, `org_id` null) is matched without it.
 * `--cloud` reads `.cloud.vars` and checks `PILOT_PROJECT_REF`. Nothing
 * else changes: the deadlines, the staff and the places stay as they are.
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';

const args = process.argv.slice(2);
const cloud = args.includes('--cloud');
const orgSlug = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--org');
const [template, status] = positional;

const STATUSES = ['draft', 'open', 'closed', 'archived'];

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!template || !status) fail('Usage: npm run programs:status -- <template-id> <draft|open|closed|archived> [--org <slug>] [--cloud]');
if (!STATUSES.includes(status)) fail(`${status} is not one of ${STATUSES.join(', ')}.`);

if (cloud) loadCloudVars();
loadDevVars();

const URL_ = process.env.PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SECRET_KEY ?? '';
if (!URL_ || !KEY) fail(`PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed, from ${cloud ? '.cloud.vars' : '.dev.vars'}.`);

if (cloud) {
  const ref = URL_.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] ?? null;
  const pilot = (process.env.PILOT_PROJECT_REF ?? '').trim();
  if (!ref) fail(`--cloud, and ${URL_} is not a Supabase project address.`);
  if (!pilot || ref !== pilot) fail(`${ref} is not the project named by PILOT_PROJECT_REF in .cloud.vars. Nothing has been written.`);
}

const db = createClient(URL_, KEY, { auth: { persistSession: false } });

let query = db.from('programs').select('id, name, status, org_id, organizations:org_id(slug)').eq('template_id', template);
const { data: rows, error } = await query;
if (error) fail(`Could not read the programs: ${error.message}`);

const matches = (rows ?? []).filter((r) => {
  if (!orgSlug) return true;
  return r.org_id === null || r.organizations?.slug === orgSlug;
});

if (matches.length === 0) fail(`No seeded program has the template ${template}${orgSlug ? ` at ${orgSlug}` : ''}. Add it first: npm run seed:programs -- --add ${template}${cloud ? ' --cloud' : ''}`);
if (matches.length > 1) {
  fail(
    `${matches.length} programs have the template ${template}:\n` +
      matches.map((r) => `    ${r.organizations?.slug ?? 'shared'} · ${r.name} · ${r.status}`).join('\n') +
      '\n  Name the school with --org <slug>.'
  );
}

const [row] = matches;
if (row.status === status) {
  console.log(`\n  ${row.name} (${row.organizations?.slug ?? 'shared'}) is already ${status}. Nothing changed.\n`);
  process.exit(0);
}

const { error: updateError } = await db.from('programs').update({ status }).eq('id', row.id);
if (updateError) fail(`Could not change it: ${updateError.message}`);

console.log(`\n  ${cloud ? 'Cloud' : 'Local'}  ${row.name} (${row.organizations?.slug ?? 'shared'}): ${row.status} -> ${status}\n`);
if (status === 'open') {
  console.log('  Students see it on the Workbench now. If the org file still lists it under\n  hidden_until.programs, remove it there so the next seed agrees.\n');
}
