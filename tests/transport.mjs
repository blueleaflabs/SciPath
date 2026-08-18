/**
 * WHAT STANDS BETWEEN A TEST RUN AND A REAL STUDENT.
 *
 * Three guards, each of which would be enough alone, tested separately so
 * that removing one does not quietly rely on another (20.9).
 *
 * Run: npm run test:transport
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { refuse, transportFor, consoleTransport } from '../src/lib/notify/transport.ts';

let passed = 0;

/**
 * Awaited, because one of these is async.
 *
 * A helper that calls `fn()` without awaiting counts an async assertion as
 * passed the moment it starts, and a rejection lands as an unhandled
 * promise after the summary has already printed. 19.9 has this as a named
 * trap and `test:scripts` caught this file having it.
 */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

/* ── One: nothing sends unless somebody said so ──────────────────────────── */

await test('the default transport sends nothing', () => {
  /* A development run reaching a real student costs more than one not
     reaching a terminal, so the asymmetry decides the default. */
  assert.equal(transportFor({}).name, 'console');
  assert.equal(transportFor({ MAIL_TRANSPORT: '' }).name, 'console');
  assert.equal(transportFor({ MAIL_TRANSPORT: 'resend' }).name, 'resend');
});

/* ── Two: fixtures are refused whatever else is configured ───────────────── */

await test('a fixture address is refused', () => {
  /* demo.invalid cannot resolve, so this would bounce rather than deliver.
     Refusing it here means a misconfigured run fails visibly instead of
     quietly off a mail server. */
  assert.equal(refuse('montavista.student.a@demo.invalid', {}), 'a fixture address');
  assert.equal(refuse('ANYBODY@DEMO.INVALID', {}), 'a fixture address');
});

await test('and is still refused when an allowlist would have permitted it', () => {
  /* The guards are independent. Putting a fixture on the allowlist is a
     mistake, and it should stay a refusal. */
  const env = { MAIL_ALLOWLIST: 'montavista.student.a@demo.invalid' };
  assert.equal(refuse('montavista.student.a@demo.invalid', env), 'a fixture address');
});

/* ── Three: the allowlist, which is the one that matters while this is new ── */

await test('an allowlist makes everything else unreachable', () => {
  /* This is what turns "I hope every fixture is on demo.invalid" into a list
     somebody wrote on purpose. Somebody else's student cannot be reached
     from a laptop. */
  const env = { MAIL_ALLOWLIST: 'me@example.com' };
  assert.equal(refuse('me@example.com', env), null);
  assert.equal(refuse('astudent@school.example', env), 'not on MAIL_ALLOWLIST');
});

await test('it is case and space insensitive, because a pasted list is not tidy', () => {
  const env = { MAIL_ALLOWLIST: ' Me@Example.com , other@example.com ' };
  assert.equal(refuse('me@example.COM', env), null);
  assert.equal(refuse('other@example.com', env), null);
});

await test('no allowlist means no allowlist, not nothing allowed', () => {
  /* Production has none: the digest decides who hears. An empty variable
     that silently blocked everything would look exactly like a working
     system sending nothing. */
  assert.equal(refuse('somebody@school.example', {}), null);
  assert.equal(refuse('somebody@school.example', { MAIL_ALLOWLIST: '' }), null);
});

await test('nonsense is refused before a provider ever sees it', () => {
  assert.equal(refuse('', {}), 'not an address');
  assert.equal(refuse('no-at-sign', {}), 'not an address');
});

/* ── The wrapper is where the guards live ────────────────────────────────── */

await test('a refused address is skipped rather than failed', async () => {
  /* A skip is not an error: a drain that recorded these as failures would
     retry them five times and then mark them failed, filling a table with
     rows nobody should look at. */
  const sent = await transportFor({ MAIL_ALLOWLIST: 'me@example.com' }).send({
    to: 'somebody@school.example',
    subject: 's',
    text: 't',
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.skipped, true);
});

await test('the guards are in the wrapper, so a new provider inherits them', () => {
  /* A transport added later cannot forget them, because it never sees the
     address unless the wrapper has already allowed it. */
  const source = fs.readFileSync('src/lib/notify/transport.ts', 'utf8');
  const wrapper = source.slice(source.indexOf('export function transportFor'));
  assert.match(wrapper, /refuse\(message\.to, env\)/);

  const resend = source.slice(
    source.indexOf('export function resendTransport'),
    source.indexOf('export function transportFor')
  );
  assert.doesNotMatch(resend, /demo\.invalid|MAIL_ALLOWLIST/, 'a provider is duplicating the guards');
});

await test('one recipient per message, always', () => {
  /* A privacy rule first — two students on one project are two messages and
     neither learns the other's address — and a provider cap second (20.8). */
  const source = fs.readFileSync('src/lib/notify/transport.ts', 'utf8');
  assert.match(source, /to: \[message\.to\]/);
  assert.doesNotMatch(source, /\bcc\b|\bbcc\b/i);
});

await test('nothing diverts a message away from its recipient', () => {
  /* There was briefly a `MAIL_REDIRECT` that sent everything to one address,
     so that delivery could be tested apart from a school district's
     filtering. It did its job and it is gone.
   
     It is worth a check rather than just a deletion. It survived being
     commented out of `.dev.vars`, because an exported variable beats a file,
     and a setting that is hard to turn off is worse than one that never
     existed. **A message must go where the code says it goes.** */
  const source = fs.readFileSync('src/lib/notify/transport.ts', 'utf8');
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\*.*$/gm, '');

  assert.doesNotMatch(code, /MAIL_REDIRECT/, 'a diversion is back');

  /* And the wrapper hands the provider the message it was given. */
  assert.match(code, /return chosen\.send\(message\);/);
});

console.log(`\n${passed} transport assertions passed.`);
