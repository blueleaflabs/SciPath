/**
 * THE CONTEXT COOKIE (2.9): signed, per person, a minute long, cleared by
 * any write that could change it.
 *
 * Run: npm run test:context
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sealContext, openContext, mayChangeContext, CONTEXT_TTL_SECONDS } from '../src/lib/context-cache.ts';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const secret = 'a-secret-long-enough-to-stand-in-for-the-project-key';
const me = '8c062d86-a0b7-439b-ac5f-14ca36e96bd5';
const other = 'fd741398-e40b-4679-a737-c64e36723364';
const ctx = { account: { id: me, display_name: 'Elder One' }, roles: [{ role: 'officer', scope_id: 'x' }], own: [], places: [] };

await test('what was sealed opens, for the same person, within the minute', async () => {
  const v = await sealContext(secret, me, ctx, 1_000_000);
  assert.ok(v);
  assert.deepEqual(await openContext(secret, me, v, 1_000_000 + 30_000), ctx);
});

await test('another person cannot use it', async () => {
  const v = await sealContext(secret, me, ctx, 1_000_000);
  assert.equal(await openContext(secret, other, v, 1_000_000), null);
});

await test('it is over after the minute', async () => {
  const v = await sealContext(secret, me, ctx, 1_000_000);
  assert.equal(await openContext(secret, me, v, 1_000_000 + (CONTEXT_TTL_SECONDS + 1) * 1000), null);
});

await test('an edited payload, a changed expiry or another key is refused', async () => {
  const v = await sealContext(secret, me, ctx, 1_000_000);
  const [id, exp, payload, mac] = v.split('.');
  const edited = Buffer.from(JSON.stringify({ ...ctx, roles: [{ role: 'advisor', scope_id: null }] })).toString('base64url');
  assert.equal(await openContext(secret, me, `${id}.${exp}.${edited}.${mac}`, 1_000_000), null, 'edited payload');
  assert.equal(await openContext(secret, me, `${id}.${Number(exp) + 3600}.${payload}.${mac}`, 1_000_000), null, 'extended expiry');
  assert.equal(await openContext('another-secret-entirely-of-the-same-length-x', me, v, 1_000_000), null, 'other key');
  assert.equal(await openContext(secret, me, 'garbage', 1_000_000), null);
  assert.equal(await openContext(secret, me, undefined, 1_000_000), null);
});

await test('a context too big for a cookie is not cached', async () => {
  const big = { ...ctx, places: Array.from({ length: 200 }, (_, i) => ({ id: `place-${i}`, project_id: `project-${i}`, programs: { name: 'A long program name' } })) };
  assert.equal(await sealContext(secret, me, big), null);
});

await test('the autosave and the pulse keep the cookie; every other write and the auth routes clear it', () => {
  assert.equal(mayChangeContext('POST', '/app/api/field/'), false);
  assert.equal(mayChangeContext('GET', '/app/api/pulse/'), false);
  assert.equal(mayChangeContext('GET', '/app/'), false);
  assert.equal(mayChangeContext('POST', '/app/project/x/'), true);
  assert.equal(mayChangeContext('POST', '/app/roles/'), true);
  assert.equal(mayChangeContext('GET', '/auth/callback/'), true);
  assert.equal(mayChangeContext('GET', '/auth/signout/'), true);
});

await test('the middleware asks the cookie first and seals what it read; sign-out clears it', () => {
  const mw = fs.readFileSync('src/middleware.ts', 'utf8');
  assert.match(mw, /if \(changing\) clearContextCookie\(cookies\);/);
  assert.match(mw, /openContext\(cacheSecret, user\.id, cookies\.get\(CONTEXT_COOKIE\)\?\.value\)/);
  assert.match(mw, /if \(!remembered\) \{\s+const answer = await supabase\.rpc\('my_context'\);/);
  assert.match(mw, /sealContext\(cacheSecret, user\.id, answer\.data\)/);
  const out = fs.readFileSync('src/pages/auth/signout.ts', 'utf8');
  assert.match(out, /clearContextCookie\(cookies\)/);
});

if (!process.exitCode) console.log(`${passed} context-cookie assertions passed.`);
