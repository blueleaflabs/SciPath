/**
 * THE SUITE THAT READS RESPONSES RATHER THAN SOURCES.
 *
 * Every other suite here reads a file. That is why the worst fault this
 * project has had was invisible to all of them: the middleware stamped five
 * security headers onto every response, a `Response` handed back by the
 * assets binding has immutable headers, and `set` on one throws. Every
 * prerendered public page on every tenant answered 404 for six weeks. The
 * sources were all correct. The join between them was not.
 *
 * 19.9 has argued four times for a check against a served site and each time
 * it was deferred as needing a deployment. It does not. `wrangler pages dev`
 * runs the real worker against the real `dist`, with the assets binding the
 * middleware depends on, which is the exact seam that keeps breaking.
 *
 * **What this asserts is deliberately not the content of a page.** Whether
 * `/about/` says the right thing is `tests/ordering.mjs`'s business. This
 * asks the two questions no source can answer: did the response arrive, and
 * did the middleware survive producing it.
 *
 * `X-Astro-Noop` is the second of those. Astro sets it only when it has
 * already tried to render an error page with the real middleware and that
 * attempt threw, so its presence is a report that the middleware died, and it
 * is worth failing on even where the status looks fine.
 *
 * Run: npm run test:serve   (requires a build first)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * A PORT NOBODY ELSE IS ON, AND A CLOCK ON EVERY REQUEST.
 *
 * The first version fixed the port and waited for the server without a
 * deadline. A `workerd` orphaned by an earlier interrupted run was still
 * bound to it and no longer answering, so the new server could not take the
 * port, every request went to the corpse, and the suite hung indefinitely
 * with no output. **A suite that hangs is worse than one that fails**: a
 * failure names something, and a hang looks exactly like slow.
 *
 * The port is chosen from a range and the run gives up on a clock.
 */
const PORT = 8700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const REQUEST_TIMEOUT = 15_000;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push([name, e.message]);
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
  }
}

if (!fs.existsSync('dist/_routes.json')) {
  console.error('No build to serve. Run `npm run build` first.');
  process.exit(1);
}

/* Read rather than listed. A tenant added to the directory and not to this
   file would otherwise be a tenant nobody ever requested. */
const tenants = fs
  .readdirSync('src/config/orgs')
  .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
  .map((f) => f.replace(/\.ya?ml$/, ''));

/* Likewise the pages: every prerendered public route, taken from what the
   build actually emitted for one tenant. An enumerated list here is a page
   inventory maintained by hand, which is the thing that went wrong in
   `tests/ordering.mjs`. */
function pagesOf(tenant) {
  const root = `dist/${tenant}`;
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'pagefind') continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else if (entry.name === 'index.html') found.push(prefix);
    }
  };
  walk(root, '/');
  return found;
}

const server = spawn(
  'npx',
  [
    'wrangler',
    'pages',
    'dev',
    'dist',
    '--port',
    String(PORT),
    '--ip',
    '127.0.0.1',
    '--compatibility-flags',
    'nodejs_compat',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);

/** Every request carries a deadline, including the ones that establish the
    server is up. Without one, an unresponsive listener is indistinguishable
    from a server still starting. */
function get(path, host) {
  return fetch(`${BASE}${path}`, {
    headers: { Host: host },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
}

async function waitForServer() {
  for (let i = 0; i < 45; i += 1) {
    if (server.exitCode !== null) return false;
    try {
      await get('/', `${tenants[0]}.scipath.org`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

const results = [];

try {
  if (!(await waitForServer())) {
    console.error(`wrangler pages dev did not answer on ${BASE} within 45s.`);
    server.kill('SIGKILL');
    process.exit(1);
  }

  for (const tenant of tenants) {
    const host = `${tenant}.scipath.org`;
    /* Every tenant's own pages, plus the home page, which is the one route
       that is rendered rather than served and therefore the one that kept
       working while everything else was broken. Both, because a check that
       only reads the working one is how this went unnoticed. */
    for (const path of ['/', ...pagesOf(tenant)]) {
      const res = await get(path, host);
      results.push({
        host,
        path,
        status: res.status,
        noop: res.headers.get('x-astro-noop'),
        frame: res.headers.get('x-frame-options'),
        csp: res.headers.get('content-security-policy-report-only'),
      });
    }
  }
} finally {
  /* SIGKILL rather than SIGTERM. The runtime this spawns has been seen to
     survive the polite signal and keep a port, which is the fault above. */
  server.kill('SIGKILL');
}

test('every public page answers', () => {
  const bad = results.filter((r) => r.status !== 200);
  assert.deepEqual(
    bad.map((r) => `${r.host}${r.path} -> ${r.status}`),
    []
  );
});

test('the middleware survives producing every one of them', () => {
  /* `X-Astro-Noop` means Astro fell back to a middleware that does nothing,
     which it only does after the real one has thrown. */
  const died = results.filter((r) => r.noop);
  assert.deepEqual(
    died.map((r) => `${r.host}${r.path}`),
    []
  );
});

test('every response carries the security headers', () => {
  /* The headers are the point, and they are also the evidence. A page served
     from the assets binding gets them only because the response is rebuilt
     when the original refuses to be written to. */
  const bare = results.filter((r) => !r.frame || !r.csp);
  assert.deepEqual(
    bare.map((r) => `${r.host}${r.path}`),
    []
  );
});

if (failures.length) {
  console.error(`\n${failures.length} failed of ${passed + failures.length}.`);
  process.exit(1);
}

console.log(
  `${passed} serve assertions passed. ` +
    `${results.length} responses across ${tenants.length} tenants.`
);
