#!/usr/bin/env node
/**
 * WHY IS SIGN-IN NOT WORKING.
 *
 * `invalid_client` from Google means the client id it received was empty or
 * wrong, and there are four places that can go wrong. Guessing which has
 * cost several rounds, so this asks each one in turn and reports what it
 * finds.
 *
 * The last check is the one that matters: `supabase/config.toml` is read when
 * the auth container **starts**. A container that came up before the
 * variables existed keeps the empty value it was given, and `db reset`
 * restarts the database rather than rebuilding that configuration. So the
 * file can be right, the CLI can receive the variables, and the running
 * container can still be wrong.
 *
 * Usage: npm run doctor
 */

import fs from 'node:fs';
import { loadDevVars, parseDevVars } from './dev-vars.mjs';

const tick = (ok) => (ok ? 'ok  ' : 'X   ');
const lines = [];
let failed = false;

function report(ok, message, detail) {
  if (!ok) failed = true;
  lines.push(`  ${tick(ok)} ${message}`);
  if (detail) lines.push(`       ${detail}`);
}

console.log('\nChecking local sign-in.\n');

/* ── 1. The file ──────────────────────────────────────────────────────────── */

const hasFile = fs.existsSync('.dev.vars');
report(hasFile, '.dev.vars exists', hasFile ? null : 'Copy .dev.vars.example to .dev.vars.');

const fromFile = hasFile ? parseDevVars(fs.readFileSync('.dev.vars', 'utf8')) : {};

/* Names only. A client secret should not appear in a terminal that somebody
   might paste into a bug report. */
const inFile = (name) => Boolean(fromFile[name]?.trim());

report(
  inFile('GOOGLE_CLIENT_ID'),
  'GOOGLE_CLIENT_ID is set in .dev.vars',
  inFile('GOOGLE_CLIENT_ID')
    ? `ends ...${fromFile.GOOGLE_CLIENT_ID.trim().slice(-24)}`
    : 'Google sign-in cannot work without it. Password sign-in still will.'
);

report(
  inFile('GOOGLE_CLIENT_SECRET'),
  'GOOGLE_CLIENT_SECRET is set in .dev.vars',
  inFile('GOOGLE_CLIENT_SECRET') ? `${fromFile.GOOGLE_CLIENT_SECRET.trim().length} characters` : null
);

if (inFile('GOOGLE_CLIENT_ID') && !/\.apps\.googleusercontent\.com$/.test(fromFile.GOOGLE_CLIENT_ID.trim())) {
  report(
    false,
    'GOOGLE_CLIENT_ID looks wrong',
    'A Google web client id ends in .apps.googleusercontent.com'
  );
}

/* ── 2. The loader ───────────────────────────────────────────────────────── */

loadDevVars();
report(
  Boolean(process.env.GOOGLE_CLIENT_ID),
  'the scripts can read it',
  process.env.GOOGLE_CLIENT_ID ? null : 'loadDevVars() did not pick it up'
);

/* ── 3. What config.toml asks for ────────────────────────────────────────── */

const toml = fs.existsSync('supabase/config.toml')
  ? fs.readFileSync('supabase/config.toml', 'utf8')
  : '';

const googleBlock = toml.slice(toml.indexOf('[auth.external.google]'));
const googleEnabled = /^enabled\s*=\s*true/m.test(googleBlock.split('\n[')[0]);
report(googleEnabled, 'config.toml enables Google');

/* ── 4. What the running container actually has ──────────────────────────── */

const url = process.env.PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';

try {
  const response = await fetch(`${url}/auth/v1/settings`, {
    headers: { apikey: process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '' },
  });

  if (!response.ok) {
    report(false, `the auth service answered ${response.status}`, `at ${url}`);
  } else {
    const settings = await response.json();
    const live = Boolean(settings?.external?.google);

    report(
      live,
      'the running auth container has Google configured',
      live
        ? null
        : 'This is the usual cause. config.toml is read when the container ' +
          'STARTS, and `db reset` does not rebuild it, so a container that ' +
          'came up before the variables existed keeps the empty value.'
    );

    if (!live && inFile('GOOGLE_CLIENT_ID')) {
      lines.push('');
      lines.push('  Fix: npm run db:restart');
      lines.push('       (stop and start, which re-reads config.toml)');
    }
  }
} catch (error) {
  report(false, 'the auth service is reachable', `${url} — ${error.message}. Is Supabase running?`);
}

/* ── 5. Whether the fixtures exist at all ─────────────────────────────────
 *
 * "That email and password did not match" is the same answer whether the
 * account is absent or the password is wrong, deliberately, so that nobody
 * can discover who has an account. Locally that hides the only two causes
 * there are: the seed has not run against this database, or DEMO_PASSWORD
 * disagrees with what the accounts were made with.
 *
 * A restart is enough to lose them. `supabase stop` removes the containers,
 * and whether the volume survives depends on how it was stopped, so an
 * afternoon that began with `db:restart` can end with an empty auth
 * directory and no indication of it anywhere.
 */
const secret = fromFile.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SECRET_KEY;

if (secret) {
  try {
    const response = await fetch(`${url}/rest/v1/users?select=id&limit=1`, {
      headers: { apikey: secret, Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(3000),
    });

    const rows = response.ok ? await response.json() : null;
    const seeded = Array.isArray(rows) && rows.length > 0;

    report(
      seeded,
      'the fixture accounts exist',
      seeded ? null : 'No people in this database. Run: npm run reset'
    );
  } catch (error) {
    report(false, 'the fixture accounts exist', `could not ask: ${error.message}`);
  }
}

/* Named, because the number of hours lost to a password that is not the one
   in the instructions is not zero. */
const demoPassword = fromFile.DEMO_PASSWORD ?? process.env.DEMO_PASSWORD;

if (demoPassword && demoPassword !== 'scipath') {
  lines.push('');
  lines.push(`  Note: DEMO_PASSWORD is set to "${demoPassword}", not "scipath".`);
  lines.push('        Fixture accounts were created with it, so sign in with that.');
}

console.log(lines.join('\n'));
console.log(
  failed
    ? '\nSomething above needs attention. Password sign-in works regardless:\n' +
      'any fixture address with the password scipath.\n'
    : '\nEverything checks out.\n'
);
