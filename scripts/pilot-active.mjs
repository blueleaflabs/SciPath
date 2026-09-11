#!/usr/bin/env node
/**
 * WHO IS IN THE SYSTEM RIGHT NOW (dev-152).
 *
 * Before a restart, the question is whether anybody is mid-sentence. The
 * only evidence the database holds is what people write: a field saved,
 * a line of feedback, a notebook entry, a score. This lists everyone with
 * any of those in the last N minutes (15 by default), newest first, as
 * their identifier and role — no names, no addresses — and says when the
 * last one was. Reads only; nothing is written.
 *
 * A person reading without typing does not show. The autosave keeps
 * every unsaved field on their device through a restart, so the cost of
 * restarting over a reader is a reload, and over a writer a few seconds
 * of retry — but this is how to see the writers.
 *
 * Run:
 *   npm run who:active -- --cloud
 *   npm run who:active -- --cloud --minutes 30
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';

const args = process.argv.slice(2);
const cloud = args.includes('--cloud');
const minutes = Number(args[args.indexOf('--minutes') + 1] || 15) || 15;

loadDevVars();
if (cloud) loadCloudVars();

const URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!URL || !KEY) { console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are both needed (.cloud.vars with --cloud, .dev.vars otherwise).'); process.exit(1); }

const db = createClient(URL, KEY, { auth: { persistSession: false } });
const must = async (promise, what) => { const { data, error } = await promise; if (error) throw new Error(`${what}: ${error.message}`); return data; };

const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();
const seen = new Map();
const note = (userId, at, what) => {
  if (!userId) return;
  const had = seen.get(userId);
  if (!had || at > had.at) seen.set(userId, { at, what });
};

const [fields, lines, notes, scores] = await Promise.all([
  must(db.from('document_fields').select('updated_by, updated_at').gte('updated_at', since), 'saves'),
  must(db.from('deliverable_feedback').select('author_id, created_at').gte('created_at', since), 'feedback'),
  must(db.from('field_notes').select('author_id, created_at').gte('created_at', since), 'notebook'),
  must(db.from('assessments').select('grader_id, created_at').gte('created_at', since), 'scores'),
]);
for (const f of fields) note(f.updated_by, f.updated_at, 'saving a field');
for (const l of lines) note(l.author_id, l.created_at, 'writing feedback');
for (const n of notes) note(n.author_id, n.created_at, 'a notebook entry');
for (const s of scores) note(s.grader_id, s.created_at, 'scoring');

if (seen.size === 0) {
  console.log(`\nNobody has written anything in the last ${minutes} minutes.\n`);
  process.exit(0);
}

const users = await must(db.from('users').select('id, display_name').in('id', [...seen.keys()]), 'people');
const roles = await must(db.from('user_roles').select('user_id, role').in('user_id', [...seen.keys()]).is('revoked_at', null), 'roles');
const roleOf = new Map();
for (const r of roles) roleOf.set(r.user_id, r.role);
const who = new Map(users.map((u) => [u.id, u.display_name]));

const rows = [...seen.entries()]
  .map(([id, x]) => ({ who: who.get(id) ?? id.slice(0, 8), role: roleOf.get(id) ?? 'student', ...x }))
  .sort((a, b) => b.at.localeCompare(a.at));

console.log(`\n${rows.length} ${rows.length === 1 ? 'person' : 'people'} active in the last ${minutes} minutes (last thing they did):\n`);
for (const r of rows) {
  const ago = Math.round((Date.now() - Date.parse(r.at)) / 60000);
  console.log(`  ${r.who.padEnd(6)} ${r.role.padEnd(9)} ${ago} min ago  ${r.what}`);
}
console.log('');
