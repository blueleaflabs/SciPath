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
 * **For the class, at the teacher's request (2.9).** Google sign-in is the
 * door, and on a day the district's Google will not open it a student
 * needs another. `--for-class` lifts the staff-only rule: one student,
 * named, gets a generated password printed once; or `--roster <file>`
 * gives every account on the roster its own, written to `--out` (a CSV
 * under local-data/, which is gitignored) and printed nowhere, so the
 * teacher can hand each person theirs. Every one is a distinct phrase, an
 * audit line is written on every account, and Google sign-in keeps working.
 *
 *   node scripts/pilot-password.mjs student@student.fuhsd.org --cloud --for-class
 *   node scripts/pilot-password.mjs --roster local-data/pilot-irpd.yaml --cloud --for-class --out local-data/pilot-passwords.csv
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
const forClass = args.includes('--for-class');
const rosterFile = args.includes('--roster') ? args[args.indexOf('--roster') + 1] : null;
const outFile = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;

if (cloud) loadCloudVars();
else loadDevVars();

function fail(message) {
  console.error(`\n  ${message.replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

if (!email && !rosterFile) fail('Name the account: node scripts/pilot-password.mjs teacher@school.org [--set …] [--cloud]\n  or the roster: --roster local-data/pilot-irpd.yaml --for-class --out local-data/pilot-passwords.csv');
if (given !== null && given.length < 10) fail('A password shorter than ten characters is refused. Leave --set off to have one generated.');
if (rosterFile && !forClass) fail('--roster puts a password on every student. Say so: add --for-class.');
if (rosterFile && !outFile) fail('--roster needs --out <file under local-data/>: forty passwords are not printed to a terminal.');
if (rosterFile && given !== null) fail('--roster and --set together make no sense: every account gets its own.');
if (outFile && !/^local-data\//.test(outFile)) fail('--out has to be under local-data/, which is gitignored.');

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

async function setFor(email, users) {
  const authUser = users.find((u) => (u.email ?? '').toLowerCase() === email);
  /* ── The account, and whether it may have a password ──────────────────── */

  if (!authUser) fail(`${email} has no account here. Load the roster first.`);

  const account = await must(
    db.from('users').select('id, org_id, display_name, population, age_band').eq('id', authUser.id).maybeSingle(),
    `reading ${email}`
  );
  if (!account) fail(`${email} has a credential but no account row. Load the roster first.`);

  /* Staff, by what the roster recorded, and never a minor by any reading —
     unless the teacher asked for the class (--for-class), which is the one
     case a student gets one, and the audit line says so. */
  if (!forClass && (account.population !== 'staff' || account.age_band === '13_17')) {
    fail(
      `${email} is ${account.population === 'staff' ? 'recorded as a minor' : 'not a staff account'}.\n` +
        'A password is set only on a teacher or advisor. Students sign in with Google.\n' +
        'For the class, at the teacher\'s request: add --for-class.'
    );
  }

  if (!forClass) {
    const { data: roleRows } = await db
      .from('user_roles')
      .select('role')
      .eq('user_id', account.id)
      .is('revoked_at', null);
    const roles = (roleRows ?? []).map((r) => r.role);
    if (!roles.includes('advisor')) {
      fail(`${email} holds no advisor role. A password is set only on somebody who runs a program.`);
    }
  }

  /* ── The password ─────────────────────────────────────────────────────── */

  /* Readable over a phone, and strong (2.9): sixteen words gave four picks
     and a number 22 bits, which is a lunch break for a machine. Six words
     from a list of 1,296 (six picks of six, the EFF short list's shape) give
     62 bits, and a number on the end. Still words; still a phone call. */
  const WORDS = (() => {
    /* A list built from syllables rather than shipped: 6 x 6 x 6 x 6 = 1,296
       distinct, pronounceable, four-letter words, no two alike. */
    const c1 = ['b', 'd', 'g', 'k', 'm', 'p'];
    const v1 = ['a', 'e', 'i', 'o', 'u', 'y'];
    const c2 = ['l', 'n', 'r', 's', 't', 'v'];
    const v2 = ['a', 'e', 'i', 'o', 'u', 'y'];
    const out = [];
    for (const a of c1) for (const b of v1) for (const c of c2) for (const d of v2) out.push(a + b + c + d);
    return out;
  })();
  const generated = () =>
    `${[0, 1, 2, 3, 4, 5].map(() => WORDS[crypto.randomInt(WORDS.length)]).join('-')}-${crypto.randomInt(10, 99)}`;

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
    reason: forClass ? 'password for the class at the teacher\'s request, as a second way in beside Google' : 'staff password for the pilot',
  });
  if (auditError) console.log(`  (audit line not written: ${auditError.message})`);


  return { account, password };
}

const { data: page, error: listError } = await db.auth.admin.listUsers({ perPage: 1000 });
if (listError) fail(`listing accounts: ${listError.message}`);
const users = page?.users ?? [];

if (rosterFile) {
  const fs = await import('node:fs');
  const yaml = (await import('js-yaml')).default;
  const doc = yaml.load(fs.readFileSync(rosterFile, 'utf8'));
  const people = [
    ...(doc.groups ?? []).flatMap((g) => (g.students ?? []).map((p) => ({ name: p.name, email: String(p.email).toLowerCase() }))),
    ...(doc.teachers ?? []).map((t) => ({ name: t.name, email: String(t.email).toLowerCase() })),
  ].filter((p) => p.email);
  const rows = [['name', 'email', 'password']];
  for (const person of people) {
    const { account, password } = await setFor(person.email, users);
    rows.push([account.display_name ?? person.name ?? '', person.email, password]);
    console.log(`  ${person.email}`);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
  fs.mkdirSync(outFile.replace(/\/[^/]*$/, ''), { recursive: true });
  fs.writeFileSync(outFile, csv, { mode: 0o600 });
  console.log(
    `\n${people.length} accounts on ${cloud ? ref : 'the local stack'} each have their own password, written to ${outFile}\n` +
      'and printed nowhere else. Hand each person theirs; delete the file when the pilot no longer needs it.\n' +
      'Google sign-in with the same addresses keeps working.\n'
  );
} else {
  const { account, password } = await setFor(email, users);
  console.log(
    `\n${account.display_name} <${email}> can sign in with a password on ${cloud ? ref : 'the local stack'}.\n\n` +
      `  password: ${password}\n\n` +
      'Printed once and stored nowhere else. Google sign-in with the same address\n' +
      'keeps working and links to this account.\n'
  );
}
