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

test('every school is closed or by invitation for the pilot; the club and the platform are open (dev-167)', () => {
  for (const f of fs.readdirSync('src/config/orgs')) {
    const org = fs.readFileSync(`src/config/orgs/${f}`, 'utf8');
    const mode = org.match(/^signup_mode: (\w+)$/m)?.[1];
    if (f === 'mvrj.yaml') {
      assert.equal(mode, 'open', 'the research club makes its own accounts');
      assert.match(org, /^sign_in: password$/m, 'with a password, not Google');
      assert.match(org, /^requires_mentor: false$/m, 'and no club mentor between an account and the club');
      continue;
    }
    if (f === 'scipath.yaml') {
      assert.equal(mode, 'open', 'the platform takes people working on their own (dev-167)');
      continue;
    }
    assert.ok(mode === 'closed' || mode === 'invite', `${f} is ${mode}; nobody signs up anywhere during the pilot`);
  }
  assert.match(fs.readFileSync('src/config/orgs/montavista.yaml', 'utf8'), /^signup_mode: closed$/m);
});

test('the open door is a sign-up route, gated by the file, confirmed by token, and made on the welcome page (dev-167)', () => {
  const route = fs.readFileSync('src/pages/auth/signup.ts', 'utf8');
  assert.match(route, /org\.signupMode !== 'open' \|\| signupsClosed\(org, runtime\)/, 'only an open door, and never past the global switch');
  assert.match(route, /supabase\.auth\.signUp\(/);
  assert.match(route, /emailRedirectTo: `\$\{url\.origin\}\/auth\/confirm\/`/);
  assert.match(route, /signin=check_mail/, 'the same sentence for a new address and a taken one');
  const confirm = fs.readFileSync('src/pages/auth/confirm.astro', 'utf8');
  assert.match(confirm, /verifyOtp\(\{ type, token_hash: token \}\)/, 'the token is spent on the POST, not on arrival');
  assert.match(confirm, /Astro\.redirect\('\/app\/welcome\/'\)/);
  const template = fs.readFileSync('supabase/templates/confirmation.html', 'utf8');
  assert.match(template, /\{\{ \.RedirectTo \}\}\?token_hash=\{\{ \.TokenHash \}\}&type=signup/);
  const config = fs.readFileSync('supabase/config.toml', 'utf8');
  assert.match(config, /\[auth\.email\.template\.confirmation\][\s\S]*content_path = "\.\/supabase\/templates\/confirmation\.html"/);
  const callback = fs.readFileSync('src/pages/auth/callback.ts', 'utf8');
  assert.match(callback, /\(arrived\.app_metadata\?\.provider \?\? 'email'\) === 'email'/, 'a password tenant turns Google away, never its own sign-ups');
  const signin = fs.readFileSync('src/pages/app/index.astro', 'utf8');
  assert.match(signin, /org\.signupMode === 'open' && !signupsClosed\(org/, 'the form appears only where the door is open');
  assert.match(signin, /action="\/auth\/signup\/"/);
  const welcome = fs.readFileSync('src/pages/app/welcome.astro', 'utf8');
  assert.match(welcome, /const openProgram = org\?\.signupMode === 'open' && Boolean\(org\?\.isPlatform\)/, 'a school asks no school questions');
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

test('the deployment can name its tenants — at runtime, never at build, and never against the platform', () => {
  const middleware = fs.readFileSync('src/middleware.ts', 'utf8');
  assert.match(middleware, /env\?\.TENANTS/);
  assert.doesNotMatch(middleware, /import\.meta\.env\.TENANTS/, 'a build with TENANTS set prerendered every public page as Not found');
  assert.match(middleware, /!orgs\[label\]\?\.isPlatform/, 'the bare domain is the platform\'s own slug and is never refused');
  for (const f of ['.cloud.vars.example', '.dev.vars.example']) {
    const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /# SIGNUPS=closed/, `${f} documents SIGNUPS`);
    assert.match(t, /# TENANTS=montavista,demo/, `${f} documents TENANTS`);
  }
});

test('during the pilot nobody leaves by themselves: the account page and the delete route are shut (2.9)', () => {
  const site = fs.readFileSync('src/config/site.ts', 'utf8');
  const page = fs.readFileSync('src/pages/app/account/index.astro', 'utf8');
  const route = fs.readFileSync('src/pages/app/account/delete.ts', 'utf8');
  const profile = fs.readFileSync('src/pages/app/profile.astro', 'utf8');
  assert.match(site, /profileEssentials: true/);
  assert.match(page, /if \(platform\.profileEssentials\) return Astro\.redirect\('\/app\/profile\/'\);/, 'the page sends them to the profile');
  assert.match(route, /if \(platform\.profileEssentials\) return new Response\('Not found', \{ status: 404/, 'the delete route answers nothing');
  assert.match(profile, /\{!platform\.profileEssentials && \(\s*<p class="leaving">/, 'and the link is off the profile');
  const markup = profile.slice(profile.indexOf('<Base'));
  for (const gone of ['id="notifications"', 'Confirmations</b>', 'name="photo_consent"', 'name="outbound_url"']) {
    const i = markup.indexOf(gone);
    assert.ok(i > 0 && markup.lastIndexOf('!platform.profileEssentials', i) > 0, `${gone} sits behind the flag`);
  }
});

console.log(`${passed} door assertions passed.`);
