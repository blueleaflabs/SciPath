/**
 * THE DOOR (2.9).
 *
 * Signups closed means closed in every place a session without an account
 * can arrive: the OAuth callback, the middleware, the welcome page, and the
 * database function behind them all. And the pilot's school is closed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { signupsClosed } from '../src/lib/door.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

test('the switch: the school file, or SIGNUPS=closed for every school at once', () => {
  assert.equal(signupsClosed({ signupMode: 'closed' }, {}), true);
  assert.equal(signupsClosed({ signupMode: 'domain' }, {}), false);
  assert.equal(signupsClosed({ signupMode: 'open' }, { SIGNUPS: 'closed' }), true);
  assert.equal(signupsClosed({ signupMode: 'open' }, { SIGNUPS: 'Closed ' }), true);
  assert.equal(signupsClosed(null, {}), false);
});

test('every school is closed or by invitation for the pilot', () => {
  for (const f of fs.readdirSync('src/config/orgs')) {
    const org = fs.readFileSync(`src/config/orgs/${f}`, 'utf8');
    const mode = org.match(/^signup_mode: (\w+)$/m)?.[1];
    assert.ok(mode === 'closed' || mode === 'invite', `${f} is ${mode}; nobody signs up anywhere during the pilot`);
  }
  assert.match(fs.readFileSync('src/config/orgs/montavista.yaml', 'utf8'), /^signup_mode: closed$/m);
});

test('every arrival asks the door', () => {
  const callback = fs.readFileSync('src/pages/auth/callback.ts', 'utf8');
  const middleware = fs.readFileSync('src/middleware.ts', 'utf8');
  const welcome = fs.readFileSync('src/pages/app/welcome.astro', 'utf8');
  const signin = fs.readFileSync('src/pages/app/index.astro', 'utf8');
  assert.match(callback, /signupsClosed\(org, runtime\)/, 'the callback, the moment a code becomes a session');
  assert.match(callback, /closed \? '\/app\/\?signin=closed' : '\/app\/\?signin=domain'/, 'and it says which door');
  assert.match(callback, /admin\.auth\.admin\.deleteUser\(user\.id\)/, 'the identity is removed, not left to sign in tomorrow');
  assert.match(middleware, /signupsClosed\(org, runtime\)/, 'the middleware, for a session with no account');
  assert.match(middleware, /signin=closed/, 'sent to the sign-in page, not the welcome page');
  assert.match(welcome, /signupsClosed\(org/, 'the welcome page itself');
  assert.match(signin, /signin === 'closed'/, 'and the sign-in page has the sentence');
});

test('the database refuses too, whatever posts', () => {
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');
  assert.match(sql, /check \(signup_mode in \('domain', 'open', 'invite', 'closed'\)\)/);
  assert.match(sql, /if v_org\.signup_mode = 'closed' then\s*raise exception/);
  assert.match(sql, /signup_mode = excluded\.signup_mode/, 're-seeding carries the file\'s mode');
});

test('the deployment can name its tenants', () => {
  const middleware = fs.readFileSync('src/middleware.ts', 'utf8');
  assert.match(middleware, /env\.TENANTS/);
  for (const f of ['.cloud.vars.example', '.dev.vars.example']) {
    const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /# SIGNUPS=closed/, `${f} documents SIGNUPS`);
    assert.match(t, /# TENANTS=montavista,demo/, `${f} documents TENANTS`);
  }
});

console.log(`${passed} door assertions passed.`);
