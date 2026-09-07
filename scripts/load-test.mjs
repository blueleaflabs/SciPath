#!/usr/bin/env node
/**
 * THE WHOLE CLASS AT ONCE (2.9; thirty demonstration students before).
 *
 * Tomorrow forty people sign in inside the same two minutes and click on
 * everything they can. This does that, on purpose, against the local
 * stack first and the cloud after: it signs in as the pilot's own roster
 * (from the pilot file, or accounts named on the command line), all of
 * them inside `--ramp` seconds, which is the bell; then each person
 * spends `--seconds` doing what people do, reading their Workbench,
 * their project, its deadlines and its first document, saving a box on
 * that document as they type (the autosave route, the one write every
 * student makes most), and asking the pulse as a browser on the backup
 * path would. It reports per route: requests, errors, p50/p95/p99, and,
 * from the `Server-Timing` header the middleware writes, how much of each
 * was the database and how many round trips; and it writes the same to
 * `local-data/load/<when>.json`, so the run before the paid plans and the
 * run after can be put side by side.
 *
 *   npm run load -- --pilot local-data/pilot.yaml --password 'phrase'
 *   npm run load -- --pilot ... --base https://montavista.scipath.org --users 40 --seconds 180
 *   npm run load -- --as a@x --as b@x --password ... --base http://montavista.localhost:4321
 *
 * The routes are discovered per person off their own Workbench, so a
 * student reads a student's pages and an Elder an Elder's, and nobody is
 * sent to a page they would be refused. Nothing is submitted; the one
 * write is a draft save on a box, which the document keeps as a draft.
 * Reads nothing from `.dev.vars`: the target is an address on the command
 * line, so it cannot be pointed at anything by a file it did not mean to
 * read. Against the cloud, that means the pilot's real database: run it
 * before the students do, or on the demonstration tenant.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const BASE = (opt('--base', 'http://montavista.localhost:4321') || '').replace(/\/$/, '');
const USERS = Number(opt('--users', 40));
const SECONDS = Number(opt('--seconds', 120));
const RAMP = Number(opt('--ramp', 90));
const THINK_MS = Number(opt('--think', 1500));
const PASSWORD = opt('--password', '');
const NAMED = all('--as');
const PILOT = opt('--pilot', NAMED.length ? null : 'local-data/pilot-irpd.yaml');
const OUT = opt('--out', 'local-data/load');

function fail(message) { console.error(`\n  ${message.replace(/\n/g, '\n  ')}\n`); process.exit(1); }
if (!/^https?:\/\//.test(BASE)) fail(`--base must be an address, not ${BASE}`);
if (!PASSWORD) fail('The fixture password: --password \'phrase\'');

/* ── Who ──────────────────────────────────────────────────────────────── */

let emails = NAMED;
if (PILOT) {
  const doc = yaml.load(fs.readFileSync(PILOT, 'utf8'));
  const students = (doc.groups ?? []).flatMap((g) => (g.students ?? []).map((s) => s.email));
  const teachers = (doc.teachers ?? []).map((t) => t.email);
  /* Students first, the teachers at the end: the class is mostly students. */
  emails = [...students, ...teachers].filter(Boolean);
}
if (emails.length === 0) fail('Name the people: --pilot local-data/pilot.yaml, or --as <email> (repeatable).');
const seats = Array.from({ length: USERS }, (_, i) => emails[i % emails.length]);

/* ── A person's cookies ───────────────────────────────────────────────── */

function takeCookies(jar, response) {
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/* ── Measured requests ────────────────────────────────────────────────── */

const samples = new Map();
let inFlight = 0, peak = 0, total = 0, failed = 0;
const errors = [];

/** The route with its ids folded, so forty projects are one line. */
const shape = (route) => route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id');

function timings(header) {
  const out = { db: null, calls: null, total: null };
  for (const part of (header ?? '').split(',')) {
    const name = part.trim().split(';')[0];
    const dur = Number(part.match(/dur=([\d.]+)/)?.[1] ?? NaN);
    const desc = part.match(/desc="([^"]*)"/)?.[1] ?? '';
    if (name === 'db') { out.db = dur; out.calls = Number(desc.match(/(\d+) calls/)?.[1] ?? NaN); }
    if (name === 'total') out.total = dur;
  }
  return out;
}

async function measured(kind, jar, route, init = {}) {
  const key = `${kind} ${shape(route)}`;
  if (!samples.has(key)) samples.set(key, { ms: [], db: [], calls: [], errors: 0, n: 0 });
  const s = samples.get(key);
  inFlight += 1; peak = Math.max(peak, inFlight); total += 1;
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}${route}`, { ...init, headers: { ...(init.headers ?? {}), cookie: cookieHeader(jar) }, redirect: 'manual' });
    const text = await response.text();
    const ms = Date.now() - started;
    takeCookies(jar, response);
    s.n += 1; s.ms.push(ms);
    const t = timings(response.headers.get('server-timing'));
    if (t.db !== null && !Number.isNaN(t.db)) s.db.push(t.db);
    if (t.calls !== null && !Number.isNaN(t.calls)) s.calls.push(t.calls);
    if (response.status >= 400 || response.status === 302) { s.errors += 1; failed += 1; if (errors.length < 12) errors.push(`${response.status} ${kind} ${route}`); }
    return { status: response.status, text };
  } catch (e) {
    s.n += 1; s.errors += 1; failed += 1; if (errors.length < 12) errors.push(`${e.message} ${kind} ${route}`);
    return { status: 0, text: '' };
  } finally { inFlight -= 1; }
}

/* ── Sign in, and find out what this person has ───────────────────────── */

async function signIn(email) {
  const jar = new Map();
  const body = new URLSearchParams({ email, password: PASSWORD, next: '/app/' });
  const response = await fetch(`${BASE}/auth/password/`, { method: 'POST', body, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  takeCookies(jar, response);
  const to = response.headers.get('location') ?? '';
  if (to.includes('signin=')) throw new Error(`${email}: refused (${to})`);
  if (jar.size === 0) throw new Error(`${email}: no session cookie came back`);
  return jar;
}

/** The pages off the Workbench, and the first document's first long box to save into. */
async function discover(jar) {
  const home = await measured('GET', jar, '/app/');
  if (home.status !== 200) throw new Error(`/app/ answered ${home.status} after sign-in`);
  const hrefs = [...home.text.matchAll(/href="(\/app\/[^"#?]+)"/g)].map((m) => m[1]);
  const first = (re) => hrefs.find((h) => re.test(h));
  const pages = ['/app/', first(/^\/app\/project\/[^/]+\/in\/[^/]+\/$/), first(/^\/app\/project\/[^/]+\/$/), first(/^\/app\/project\/[^/]+\/doc\/[^/]+\/$/), first(/^\/app\/program\/[^/]+\/tracker\/$/)].filter(Boolean);
  let box = null;
  const doc = pages.find((p) => /\/doc\//.test(p));
  if (doc) {
    const page = await measured('GET', jar, doc);
    const docId = page.text.match(/data-doc="([0-9a-f-]{36})"/)?.[1];
    /* The first long box this person may write: the field wrapper carries
       its id, version and kind as data attributes, in whatever order. */
    const field = [...page.text.matchAll(/<div class="field[^"]*"([^>]*)>/g)]
      .map((m) => m[1])
      .map((attrs) => ({ id: attrs.match(/data-field="([^"]+)"/)?.[1], version: attrs.match(/data-version="(\d+)"/)?.[1], kind: attrs.match(/data-kind="([^"]+)"/)?.[1], w: /data-writable="1"/.test(attrs) }))
      .find((f) => f.id && f.kind === 'long' && f.w);
    if (docId && field) box = { doc: docId, field: field.id, version: Number(field.version ?? 0) };
  }
  return { pages, box };
}

/* ── A person's stretch ───────────────────────────────────────────────── */

async function person(email, seat, startAt) {
  await new Promise((r) => setTimeout(r, startAt));
  let jar;
  try { jar = await signIn(email); } catch (e) { errors.push(e.message); failed += 1; return; }
  let plan;
  try { plan = await discover(jar); } catch (e) { errors.push(`${email}: ${e.message}`); failed += 1; return; }
  const end = Date.now() + SECONDS * 1000;
  let i = seat;
  while (Date.now() < end) {
    const page = plan.pages[i % plan.pages.length];
    i += 1;
    await measured('GET', jar, page);
    /* A browser on the backup path asks the pulse; every third turn here,
       which is heavier than the schedule would be in class. */
    if (i % 3 === 0) await measured('GET', jar, '/app/api/pulse/');
    /* And a box saved as they type: one draft every few turns. */
    if (plan.box && i % 4 === 0) {
      const r = await measured('POST', jar, '/app/api/field/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ document_id: plan.box.doc, field_id: plan.box.field, value: `Load walk ${new Date().toISOString()} · ${email}`, version: plan.box.version }),
      });
      try { const j = JSON.parse(r.text); if (j?.version) plan.box.version = j.version; } catch {}
    }
    await new Promise((r) => setTimeout(r, THINK_MS * (0.5 + Math.random())));
  }
}

/* ── Run ──────────────────────────────────────────────────────────────── */

const pct = (xs, p) => { if (xs.length === 0) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const fmt = (n) => (Number.isNaN(n) || n === null ? '   -' : String(Math.round(n)).padStart(4));

console.log(`\n${BASE}: ${USERS} seats over ${new Set(seats).size} accounts, everyone in within ${RAMP}s, then ${SECONDS}s each, ${THINK_MS}ms between clicks.\n`);
const started = Date.now();
await Promise.all(seats.map((email, seat) => person(email, seat, Math.round((seat / USERS) * RAMP * 1000))));
const elapsed = (Date.now() - started) / 1000;

const rows = [...samples.entries()].sort((a, b) => b[1].n - a[1].n);
console.log(`${'route'.padEnd(40)} ${'n'.padStart(5)} ${'err'.padStart(4)}   ${'p50'.padStart(4)} ${'p95'.padStart(4)} ${'p99'.padStart(4)}   ${'db50'.padStart(4)} ${'db95'.padStart(4)} ${'calls'.padStart(5)}`);
console.log('-'.repeat(96));
const report = { base: BASE, at: new Date().toISOString(), users: USERS, seconds: SECONDS, ramp: RAMP, think: THINK_MS, elapsed, total, failed, peak, routes: {} };
for (const [key, s] of rows) {
  report.routes[key] = { n: s.n, errors: s.errors, p50: pct(s.ms, 50), p95: pct(s.ms, 95), p99: pct(s.ms, 99), db50: pct(s.db, 50), db95: pct(s.db, 95), calls: pct(s.calls, 50) };
  console.log(`${key.padEnd(40)} ${String(s.n).padStart(5)} ${String(s.errors).padStart(4)}   ${fmt(pct(s.ms, 50))} ${fmt(pct(s.ms, 95))} ${fmt(pct(s.ms, 99))}   ${fmt(pct(s.db, 50))} ${fmt(pct(s.db, 95))} ${fmt(pct(s.calls, 50)).padStart(5)}`);
}
console.log('-'.repeat(96));
console.log(`${total} requests in ${elapsed.toFixed(0)}s, ${(total / elapsed).toFixed(1)}/s, ${peak} in flight at peak, ${failed} failed. Milliseconds; db and calls from Server-Timing.\n`);
if (errors.length) { console.log('First failures:'); for (const e of errors) console.log(`  ${e}`); console.log(); }
console.log(
  'Reading it: a route whose p95 is far above its db95 is slow in the Worker or the network,\n' +
    'not the database. A route with many calls and a db95 near its p95 wants fewer round trips.\n' +
    'A db95 that climbs with --users while calls stay flat is the database itself, which is\n' +
    'what the paid plan is for. Compare two runs by their files in ' + OUT + '/.\n'
);
fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, `${report.at.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`Written to ${file}`);
process.exit(failed > total * 0.02 ? 1 : 0);
