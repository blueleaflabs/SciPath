/**
 * LIVE UPDATES: THE SOCKET FIRST, THE PULSE ON THE SCHOOL'S CLOCK (2.8).
 *
 * The socket carries changes and costs the edge nothing; the pulse is
 * the backup for a browser whose socket will not connect, paced by the
 * class periods in the school's file. What is asserted here:
 *
 *   - the plan is read from the org file and a bad period fails loudly;
 *   - "in class" is judged on the school's clock, not the browser's;
 *   - the backup is quick in class and hourly outside it;
 *   - the shell polls only when the transport reports a fallback, never
 *     on a timer of its own, and says so on the page;
 *   - every table the pulse watched has a broadcast trigger, so a change
 *     that used to reach a page by polling still reaches it by socket;
 *   - the document page joins its room with presence and honors a held box.
 *
 * Run: npm run test:live
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shapeLive, DEFAULT_LIVE } from '../src/config/org-shape.ts';
import { inClass, fallbackDelay, localClock } from '../src/lib/live-plan.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const plan = shapeLive({ class_periods: [{ days: ['Tue', 'Thu'], from: '08:30', to: '09:25' }], fallback: { in_class_seconds: 8, in_class_idle_seconds: 30, off_hours_seconds: 3600 } });

test('the plan is read from the file', () => {
  assert.equal(plan.classPeriods.length, 1);
  assert.deepEqual(plan.fallback, { inClass: 8, inClassIdle: 30, offHours: 3600, enabled: true });
  assert.deepEqual(shapeLive(undefined), DEFAULT_LIVE);
});

test('the backup has an off switch, and it is on unless the file says otherwise (2.9)', () => {
  assert.equal(shapeLive({ fallback: {} }).fallback.enabled, true);
  assert.equal(shapeLive({ fallback: { enabled: false } }).fallback.enabled, false);
  assert.equal(shapeLive({ fallback: { enabled: 'false' } }).fallback.enabled, false);
  assert.equal(shapeLive({ fallback: { enabled: true } }).fallback.enabled, true);
  /* The shell reads the switch: no polling when it is off, and the strip says reload. */
  const shellSrc = fs.readFileSync('src/components/AppShell.astro', 'utf8');
  assert.match(shellSrc, /fallback\?\.enabled !== false/);
  assert.match(shellSrc, /reload the page to see new replies/);
});

test('a bad period fails loudly', () => {
  assert.throws(() => shapeLive({ class_periods: [{ days: ['Tuesday'], from: '08:30', to: '09:25' }] }), /Mon\.\.Sun/);
  assert.throws(() => shapeLive({ class_periods: [{ days: ['Tue'], from: '8:30', to: '09:25' }] }), /HH:MM/);
  assert.throws(() => shapeLive({ class_periods: [{ days: ['Tue'], from: '09:30', to: '09:25' }] }), /before/);
  assert.throws(() => shapeLive({ class_periods: [{ days: [], from: '08:30', to: '09:25' }] }), /no days/);
});

test('in class is judged on the school clock', () => {
  /* 2026-09-08 is a Tuesday. 16:00Z is 09:00 in Los Angeles (PDT). */
  const at = new Date('2026-09-08T16:00:00Z');
  assert.equal(localClock(at, 'America/Los_Angeles').day, 'Tue');
  assert.equal(localClock(at, 'America/Los_Angeles').hhmm, '09:00');
  assert.equal(inClass(plan, at, 'America/Los_Angeles'), true);
  /* The same instant is 18:00 in Paris: not in class. */
  assert.equal(inClass(plan, at, 'Europe/Paris'), false);
  /* Wednesday at 09:00 Los Angeles: no period. */
  assert.equal(inClass(plan, new Date('2026-09-09T16:00:00Z'), 'America/Los_Angeles'), false);
  /* The end is exclusive. */
  assert.equal(inClass(plan, new Date('2026-09-08T16:25:00Z'), 'America/Los_Angeles'), false);
});

test('the backup is quick in class and hourly outside it', () => {
  assert.equal(fallbackDelay(plan, 0, true), 8000);
  assert.equal(fallbackDelay(plan, 5 * 60 * 1000, true), 30000);
  assert.equal(fallbackDelay(plan, 20 * 60 * 1000, true), null);
  assert.equal(fallbackDelay(plan, 0, false), 3600 * 1000);
  assert.equal(fallbackDelay(plan, 30 * 60 * 1000, false), 3600 * 1000);
});

const shell = fs.readFileSync('src/components/AppShell.astro', 'utf8');
const client = fs.readFileSync('src/lib/live-client.ts', 'utf8');
const doc = fs.readFileSync('src/pages/app/project/[id]/doc/[deliverable].astro', 'utf8');
const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');
const org = fs.readFileSync('src/config/orgs/montavista.yaml', 'utf8');

test('the shell joins the socket first and polls only on fallback', () => {
  assert.match(shell, /myTopics\(\)\.then/, 'the shell asks for its topics');
  assert.match(shell, /for \(const t of topics\) join\(t\)/, 'and joins each');
  assert.match(shell, /onHealth\(\(h: Health, detail: string\) => \{\s*if \(h === 'fallback' \|\| h === 'off'\) \{\s*const enabled = [^;]+;\s*if \(enabled\) startPolling\(\)/, 'polling starts on fallback, when the switch is on');
  assert.match(shell, /else if \(h === 'live'\) \{\s*stopPolling\(\)/, 'and stops when the socket is back');
  assert.doesNotMatch(shell, /^\s*loop\(\);\s*$/m, 'no poll loop starts on its own');
  assert.match(shell, /live-strip/, 'the fallback is said on the page');
  assert.match(shell, /\/app\/api\/live-incident\//, 'and reported');
  assert.match(shell, /data-live-url=\{liveUrl\}/, 'the socket address comes from the request environment');
});

test('the client judges health by deadline and repeated errors, and channels are private', () => {
  assert.match(client, /DEADLINE = 20_000/);
  assert.match(client, /ERRORS_TO_FALL = 3/);
  assert.match(client, /config: \{ private: true/);
  assert.match(client, /live:reconnected/, 'a page re-reads after a gap');
});

test('every table the pulse watched has a broadcast trigger', () => {
  for (const t of ['deliverable_feedback', 'documents', 'assessments', 'entry_milestones', 'notifications', 'document_fields']) {
    assert.match(sql, new RegExp(`create trigger live_\\w+\\s+after [a-z, ]+(?:of [a-z_, ]+ )?on public\\.${t}`), `no live trigger on ${t}`);
  }
  assert.match(sql, /create policy live_listen on realtime\.messages for select to authenticated using \(app\.may_listen\(realtime\.topic\(\)\)\)/);
  assert.match(sql, /create policy live_speak on realtime\.messages for insert to authenticated with check \(app\.may_listen\(realtime\.topic\(\)\)\)/);
  assert.match(sql, /to_regclass\('realtime\.messages'\) is null/, 'the policies wait for the service to make its table');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts.reset, /db reset && node scripts\/live-policies\.mjs/, 'reset applies the live policies after the stack settles');
});

test('the document page joins its room with presence and holds a box', () => {
  assert.match(doc, /join\(topic, \{ presence: true \}\)/);
  assert.match(doc, /is-held/);
  assert.match(doc, /ch\.track\(\{ name: myName, field: here/);
  assert.match(doc, /m\.event === 'field'/, 'a saved field arrives in the box');
  assert.match(doc, /if \(p\.by_id === me\) return;/, 'my own save is not applied back to me');
});

test('the school file names its class periods', () => {
  assert.match(org, /^live:\n\s+class_periods:/m);
});

console.log(`${passed} live-update assertions passed.`);
