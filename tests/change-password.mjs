/**
 * A PASSWORD CHANGED WITH THE CURRENT ONE, AND GUESSES COUNTED (2.9).
 *
 *   - the change page asks for the current password and sets the new one
 *     in the same request; every failure is the one sentence;
 *   - the gate is asked before the credential, on the change page and on
 *     the sign-in form, and every attempt is recorded;
 *   - a school with `sign_in: password` shows no Google button, links the
 *     change page rather than a mailed reset, and refuses a Google
 *     session in the callback and at the start;
 *   - the migration keeps the count with the secret key only.
 *
 * Run: npm run test:change
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shapeOrg } from '../src/config/org-shape.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const change = fs.readFileSync('src/pages/auth/change.astro', 'utf8');
const signin = fs.readFileSync('src/pages/auth/password.ts', 'utf8');
const start = fs.readFileSync('src/pages/auth/signin.ts', 'utf8');
const callback = fs.readFileSync('src/pages/auth/callback.ts', 'utf8');
const home = fs.readFileSync('src/pages/app/index.astro', 'utf8');
const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');
const mv = fs.readFileSync('src/config/orgs/montavista.yaml', 'utf8');

test('the change page proves the account with its current password and says one sentence for every failure', () => {
  assert.match(change, /signInWithPassword\(\{ email, password: current \}\)/);
  assert.match(change, /updateUser\(\{ password \}\)/);
  const sentences = change.match(/error: CHANGE_FAILED/g) ?? [];
  assert.ok(sentences.length >= 1, 'every refusal goes through refuse()');
  assert.doesNotMatch(change, /error: '[^']*(incorrect|wrong|not match|unknown|locked)/i, 'no failure names its cause');
  const gate = fs.readFileSync('src/lib/password-gate.ts', 'utf8');
  const sentence = gate.match(/CHANGE_FAILED = '([^']+)'/)?.[1] ?? '';
  assert.ok(sentence.length > 0);
  assert.doesNotMatch(sentence, /incorrect|wrong|match|locked|exist/i);
  assert.match(change, /password === current\) return refuse\(\)/, 'the new password must differ');
  assert.match(change, /password\.length < MIN/);
});

test('guesses are counted before the credential is checked, on both doors', () => {
  assert.match(change, /if \(!\(await passwordAllowed\(runtime, email\)\)\) return refuse\(\);/);
  assert.match(change, /notePasswordAttempt\(runtime, email, false\)/);
  assert.match(change, /notePasswordAttempt\(runtime, email, true\)/);
  assert.match(signin, /passwordAllowed\(runtime, lowered\)/);
  assert.match(signin, /notePasswordAttempt\(runtime, lowered, !error\)/);
  assert.match(signin, /allowed\s*\?\s*await supabase\.auth\.signInWithPassword/, 'a locked account is not tried');
  assert.match(change, /await pause\(\)/);
  assert.match(signin, /await pause\(\)/);
});

test('the count lives with the secret key: no policy lets a session near it', () => {
  assert.match(sql, /create table public\.password_attempts/);
  const block = sql.slice(sql.indexOf('create table public.password_attempts'));
  assert.match(block, /alter table public\.password_attempts enable row level security/);
  assert.doesNotMatch(block, /create policy \w+ on public\.password_attempts/);
  assert.match(sql, /grant execute on function public\.password_gate\(text, int, interval\) to service_role;/);
  assert.match(sql, /grant execute on function public\.password_attempt\(text, boolean\) to service_role;/);
  assert.match(sql, /revoke all on function public\.password_gate\(text, int, interval\) from public, anon, authenticated;/);
});

test('a school that signs in by password alone shows no Google and links the change page', () => {
  assert.equal(shapeOrg({ sign_in: 'password' }).signIn, 'password');
  assert.equal(shapeOrg({}).signIn, 'both');
  assert.match(mv, /^sign_in: password$/m);
  assert.match(home, /org\.signIn === 'password' \? \(\s*<p class="lede">Sign in with the email address and password you were given\.<\/p>/);
  assert.match(home, /<a href="\/auth\/change\/">Change your password<\/a>/);
  assert.match(start, /if \(org\.signIn === 'password'\) return redirect\('\/app\/\?signin=password_only'\);/);
  assert.match(callback, /if \(org\?\.signIn === 'password'\) \{/);
  assert.match(callback, /return redirect\('\/app\/\?signin=password_only'\);/);
  assert.match(home, /signin === 'password_only'/);
});

if (!process.exitCode) console.log(`${passed} change-password assertions passed.`);
