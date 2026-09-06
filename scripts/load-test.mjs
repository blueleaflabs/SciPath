#!/usr/bin/env node
/**
 * THIRTY STUDENTS AT ONCE, AGAINST THE REAL THING.
 *
 * At the pilot's scale the risk is not throughput. It is p95 latency on
 * three or four hot routes, plus one spike when a whole class opens the
 * same page in the same minute. This signs in as the demonstration tenant's
 * fixtures, holds their cookies, and hits the routes named for a stretch of
 * time with a chosen number of people in flight, then reports per route:
 * requests, errors, p50, p95, p99, and, from the `Server-Timing` header the
 * middleware emits, how much of each was the database and how many round
 * trips that was.
 *
 * Which is the whole point of the header. Total time says a page is slow;
 * `db;dur=310;desc="8 calls"` says why, and whether the fix is fewer calls
 * (12.15's second item) or a faster database (its fifth).
 *
 * ── Why the demonstration tenant ─────────────────────────────────────────
 *
 * `demo.scipath.org` runs the same Worker, the same database and the same
 * policies as the pilot, with invented people whose passwords are known.
 * A load test against it is the pilot's load with no student in the way,
 * which is the reason that tenant is worth keeping on the pilot instance
 * (decision 70).
 *
 * ── Deliberately not a library ───────────────────────────────────────────
 *
 * `k6` and `oha` are better tools, and either is one install away. This is
 * `fetch` in a loop, so it runs on the machine that already has the
 * repository and it reads the header this codebase emits. If the numbers
 * are surprising, reach for the better tool; if they are fine, nothing was
 * installed to find out.
 *
 *   node scripts/load-test.mjs --base https://demo.scipath.org
 *   node scripts/load-test.mjs --base http://demo.localhost:4321 --users 10 --seconds 30
 *   node scripts/load-test.mjs --base ... --routes /app/,/app/project/<id>/ --password scipath!
 *
 * Reads nothing from `.dev.vars`; the target is an address and a fixture
 * password, both on the command line, so it cannot be pointed at anything
 * by a file it did not mean to read.
 */

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);

const BASE = (opt('--base', '') || '').replace(/\/$/, '');
const USERS = Number(opt('--users', 30));
const SECONDS = Number(opt('--seconds', 120));
const PASSWORD = opt('--password', 'scipath!');
/* `/app/` is the page every person opens first and most, so it is the
   default on its own. Name more with --routes; a student sent to a staff
   page is refused, and that refusal counts as an error here, so pair
   staff routes with --users at or below the number of staff fixtures. */
const ROUTES = opt('--routes', '/app/').split(',').map((r) => r.trim()).filter(Boolean);
const THINK_MS = Number(opt('--think', 500));

function fail(message) {
  console.error(`\n  ${message.replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

if (!BASE) fail('Say where: --base https://demo.scipath.org');
if (!/^https?:\/\//.test(BASE)) fail(`--base must be an address, not ${BASE}`);

/* The demonstration tenant's people, by handle. Students first, because a
   class is mostly students; the officers and the advisor take the remaining
   seats so the staff pages are exercised as well. */
const HANDLES = [
  'student.a', 'student.b', 'student.c', 'student.d', 'student.e', 'student.f',
  'student.g', 'student.h', 'student.i', 'student.j', 'student.k', 'student.l', 'student.m',
  'officer.a', 'officer.b', 'officer.c', 'officer.d', 'advisor',
];
const tenant = new URL(BASE).hostname.split('.')[0];
const address = (handle) => `${tenant}.${handle}@scipath.org`;

/* ── Cookies, by hand ─────────────────────────────────────────────────── */

/* A cookie jar is a Map and two functions; the rules test reads functions
   and not classes, and there is nothing here a class would add. */
function takeCookies(jar, response) {
  const set = response.headers.getSetCookie?.() ?? [];
  for (const line of set) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function signIn(handle) {
  const jar = new Map();
  const body = new URLSearchParams({ email: address(handle), password: PASSWORD, next: '/app/' });
  const response = await fetch(`${BASE}/auth/password/`, {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  takeCookies(jar, response);
  const to = response.headers.get('location') ?? '';
  if (to.includes('signin=')) throw new Error(`${address(handle)}: refused (${to})`);
  if (jar.size === 0) throw new Error(`${address(handle)}: no session cookie came back`);

  /* One request to prove the session is real, before the clock starts. */
  const probe = await fetch(`${BASE}/app/`, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
  takeCookies(jar, probe);
  if (probe.status !== 200) throw new Error(`${address(handle)}: /app/ answered ${probe.status} after sign-in`);
  return jar;
}

/* ── The run ──────────────────────────────────────────────────────────── */

function timings(header) {
  const out = { db: null, calls: null, total: null };
  for (const part of (header ?? '').split(',')) {
    const name = part.trim().split(';')[0];
    const dur = Number(part.match(/dur=([\d.]+)/)?.[1] ?? NaN);
    const desc = part.match(/desc="([^"]*)"/)?.[1] ?? '';
    if (name === 'db') {
      out.db = dur;
      out.calls = Number(desc.match(/(\d+) calls/)?.[1] ?? NaN);
    }
    if (name === 'total') out.total = dur;
  }
  return out;
}

const samples = new Map(ROUTES.map((r) => [r, []]));
const errors = new Map(ROUTES.map((r) => [r, 0]));
let inFlight = 0;
let peak = 0;

async function person(jar, seat) {
  const end = Date.now() + SECONDS * 1000;
  let i = seat;
  while (Date.now() < end) {
    const route = ROUTES[i % ROUTES.length];
    i += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const started = Date.now();
    try {
      const response = await fetch(`${BASE}${route}`, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
      await response.arrayBuffer();
      const ms = Date.now() - started;
      if (response.status >= 400 || response.status === 302) errors.set(route, errors.get(route) + 1);
      samples.get(route).push({ ms, ...timings(response.headers.get('server-timing')), status: response.status });
    } catch {
      errors.set(route, errors.get(route) + 1);
    } finally {
      inFlight -= 1;
    }
    await new Promise((r) => setTimeout(r, THINK_MS));
  }
}

const pct = (xs, p) => {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const fmt = (n) => (Number.isNaN(n) || n === null ? '   -' : String(Math.round(n)).padStart(4));

console.log(`\n${BASE}: ${USERS} people, ${SECONDS}s, ${ROUTES.length} routes, ${THINK_MS}ms between requests.\n`);

console.log('Signing in');
const jars = [];
for (let seat = 0; seat < USERS; seat += 1) {
  const handle = HANDLES[seat % HANDLES.length];
  try {
    jars.push(await signIn(handle));
    process.stdout.write(`  ${address(handle)}\r`);
  } catch (e) {
    fail(`${e.message}${e.cause ? ` (${e.cause.message ?? e.cause})` : ""}\n\nThe fixtures come from npm run reset:cloud (or npm run reset locally), password ${PASSWORD}.`);
  }
}
console.log(`  ${jars.length} sessions, ${Math.min(USERS, HANDLES.length)} distinct people.\n`);

console.log('Running');
const started = Date.now();
await Promise.all(jars.map((jar, seat) => person(jar, seat)));
const elapsed = (Date.now() - started) / 1000;

/* ── The table ────────────────────────────────────────────────────────── */

console.log(`\n${'route'.padEnd(28)} ${'n'.padStart(5)} ${'err'.padStart(4)}   ${'p50'.padStart(4)} ${'p95'.padStart(4)} ${'p99'.padStart(4)}   ${'db50'.padStart(4)} ${'db95'.padStart(4)} ${'calls'.padStart(5)}`);
console.log('-'.repeat(84));
let all = 0;
for (const route of ROUTES) {
  const s = samples.get(route);
  all += s.length;
  const ms = s.map((x) => x.ms);
  const db = s.map((x) => x.db).filter((x) => x !== null && !Number.isNaN(x));
  const calls = s.map((x) => x.calls).filter((x) => x !== null && !Number.isNaN(x));
  console.log(
    `${route.padEnd(28)} ${String(s.length).padStart(5)} ${String(errors.get(route)).padStart(4)}   ` +
      `${fmt(pct(ms, 50))} ${fmt(pct(ms, 95))} ${fmt(pct(ms, 99))}   ` +
      `${fmt(pct(db, 50))} ${fmt(pct(db, 95))} ${fmt(pct(calls, 50)).padStart(5)}`
  );
}
console.log('-'.repeat(84));
console.log(
  `${all} requests in ${elapsed.toFixed(0)}s, ${(all / elapsed).toFixed(1)}/s, ${peak} in flight at peak. ` +
    `Milliseconds; db and calls from Server-Timing.\n`
);

const noHeader = [...samples.values()].flat().filter((x) => x.total === null).length;
if (noHeader) {
  console.log(
    `${noHeader} responses carried no Server-Timing header. A cached or static response has none;\n` +
      'an /app/ page without one is a build older than the middleware that writes it.\n'
  );
}
console.log(
  'Reading it: a route whose p95 is far above its db95 is slow in the Worker or the network,\n' +
    'not the database. A route with many calls and a db95 near its p95 wants fewer round trips\n' +
    '(12.15, item 2). A db95 that climbs with --users while calls stay flat is the database\n' +
    'itself (item 5).\n'
);
