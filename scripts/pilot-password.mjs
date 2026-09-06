#!/usr/bin/env node
/**
 * A PASSWORD FOR ONE STAFF ACCOUNT.
 *
 * The pilot's accounts are entered through Google: `pilot-load.mjs` makes
 * them with no password and refuses `--password` against the cloud. That is
 * right for thirty-six students and wrong for the two teachers, who need to
 * be able to sign in on a day the district's Google sign-in is not
 * cooperating, and who need to see the password screens before the class
 * does.
 *
 * So this sets a password on **one account, named on the command line, and
 * only if that account is staff.** A student's account is refused whatever
 * the flags say: the roster is minors, and a password on a minor's account
 * is a second way in that nobody consented to.
 *
 * Two other things it does, because the password alone is not enough:
 *
 *   - It mirrors the account's email identity into `public.identities`, which
 *     `sync_identities()` otherwise writes only on a sign-in. Without the
 *     row, "Forgotten your password?" silently sends nothing, because
 *     `may_reset_password` reads that table to decide whether an address
 *     signs in with a password at all.
 *   - It writes an audit line, so the school's record shows that a password
 *     was set by script, on whom, and when.
 *
 * The password is printed once. It is not stored anywhere this script can
 * reach, and it is not written to a file.
 *
 *   node scripts/pilot-password.mjs teacher@fuhsd.org                 # local, generated
 *   node scripts/pilot-password.mjs teacher@fuhsd.org --set 'a phrase' # local, given
 *   node scripts/pilot-password.mjs teacher@fuhsd.org --cloud          # the pilot
 *
 * `--cloud` reads `.cloud.vars` and, as the loader does, refuses any project
 * but the one `PILOT_PROJECT_REF` names.
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';

const args = process.argv.slice(2);
const cloud = args.includes('--cloud');
const email = (args.find((a) => !a.startsWith('--') && a.includes('@')) ?? '').trim().toLowerCase();
const given = args.includes('--set') ? args[args.indexOf('--set') + 1] : null;

if (cloud) loadCloudVars();
else loadDevVars();

function fail(message) {
  console.error(`\n  ${message.replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

if (!email) fail('Name the account: node scripts/pilot-password.mjs teacher@school.org [--set …] [--cloud]');
if (given !== null && given.length < 10) fail('A password shorter than ten characters is refused. Leave --set off to have one generated.');

/* ── The target, guarded the same way the loader is ───────────────────── */

const URL_ = process.env.PUBLIC_SUPABASE_URL ?? '';
const SECRET = process.env.SUPABASE_SECRET_KEY ?? '';
if (!URL_ || !SECRET) fail(`PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed, from ${cloud ? '.cloud.vars' : '.dev.vars'}.`);

const ref = URL_.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] ?? null;
const loopback = /localhost|127\.0\.0\.1|host\.docker\.internal/.test(URL_);

if (cloud) {
  const pilot = (process.env.PILOT_PROJECT_REF ?? '').trim();
  if (!ref) fail(`--cloud, and ${URL_} is not a Supabase project address.`);
  if (!pilot) fail('PILOT_PROJECT_REF is not set in .cloud.vars. Nothing has been written.');
  if (ref !== pilot) fail(`${ref} is not the pilot project (${pilot}). Nothing has been written.`);
} else if (!loopback) {
  fail(`${URL_} is not the local stack. Use --cloud for the pilot project.`);
}

const db = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) fail(`${what}: ${error.message}`);
  return data;
}

/* ── The account, and whether it may have a password ──────────────────── */

const { data: page, error: listError } = await db.auth.admin.listUsers({ perPage: 1000 });
if (listError) fail(`listing accounts: ${listError.message}`);
const authUser = (page?.users ?? []).find((u) => (u.email ?? '').toLowerCase() === email);
if (!authUser) fail(`${email} has no account here. Load the roster first.`);

const account = await must(
  db.from('users').select('id, org_id, display_name, population, age_band').eq('id', authUser.id).maybeSingle(),
  `reading ${email}`
);
if (!account) fail(`${email} has a credential but no account row. Load the roster first.`);

/* Staff, by what the roster recorded, and never a minor by any reading. */
if (account.population !== 'staff' || account.age_band === '13_17') {
  fail(
    `${email} is ${account.population === 'staff' ? 'recorded as a minor' : 'not a staff account'}.\n` +
      'A password is set only on a teacher or advisor. Students sign in with Google.'
  );
}

const { data: roleRows } = await db
  .from('user_roles')
  .select('role')
  .eq('user_id', account.id)
  .is('revoked_at', null);
const roles = (roleRows ?? []).map((r) => r.role);
if (!roles.includes('advisor')) {
  fail(`${email} holds no advisor role. A password is set only on somebody who runs a program.`);
}

/* ── The password ─────────────────────────────────────────────────────── */

/* Four words from a short list and a number: long enough to be strong,
   short enough to read out over a phone. */
const WORDS = 'river maple stone amber cedar harbor meadow copper falcon ember willow orchid quartz summit tundra violet'.split(' ');
const generated = () =>
  `${[0, 1, 2, 3].map(() => WORDS[crypto.randomInt(WORDS.length)]).join('-')}-${crypto.randomInt(10, 99)}`;

const password = given ?? generated();

await must(db.auth.admin.updateUserById(account.id, { password }), `setting the password on ${email}`);

/* ── The mirror, so the reset link works before any sign-in ───────────── */

const identity = (authUser.identities ?? []).find((i) => i.provider === 'email');
if (identity) {
  const { error: mirrorError } = await db.from('identities').upsert(
    {
      org_id: account.org_id,
      user_id: account.id,
      auth_identity_id: identity.id ?? identity.identity_id,
      provider: 'email',
      subject: identity.identity_data?.sub ?? identity.id ?? account.id,
      email,
      is_primary: true,
    },
    { onConflict: 'auth_identity_id' }
  );
  if (mirrorError) console.log(`  (identity not mirrored: ${mirrorError.message}; "Forgotten your password?" will work after the first sign-in)`);
} else {
  console.log('  (no email identity on the credential; "Forgotten your password?" will work after the first sign-in)');
}

const { error: auditError } = await db.from('audit_log').insert({
  org_id: account.org_id,
  action: 'password.set_by_script',
  entity_type: 'user',
  entity_id: account.id,
  after: { email, cloud, generated: given === null },
  reason: 'staff password for the pilot',
});
if (auditError) console.log(`  (audit line not written: ${auditError.message})`);

console.log(
  `\n${account.display_name} <${email}> can sign in with a password on ${cloud ? ref : 'the local stack'}.\n\n` +
    `  password: ${password}\n\n` +
    'Printed once and stored nowhere else. Google sign-in with the same address\n' +
    'keeps working and links to this account.\n'
);
