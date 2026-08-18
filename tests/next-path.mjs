/**
 * WHERE SOMEBODY WAS TRYING TO GO, AND WHERE THEY MAY NOT BE SENT.
 *
 * A notification link clicked without a session has to survive signing in,
 * or every message we send lands somebody on the overview to hunt for the
 * thing the message named (20.10).
 *
 * The destination therefore travels in a parameter, and a redirect
 * parameter that accepts anything is an open redirect. **In a link mailed to
 * a child, from a school, that is worse than having no link**: it lends our
 * hostname to somewhere else entirely, in a message they were told to trust.
 *
 * So the hostile cases are the point of this file, and they are written out
 * one at a time rather than looped, because each one is a different trick
 * and a reader should be able to see which.
 *
 * Run: npm run test:next
 */

import assert from 'node:assert/strict';
import { setSessionHint, SESSION_HINT } from '../src/lib/session-hint.ts';
import fs from 'node:fs';
import { safeNext, signInWith, HOME } from '../src/lib/next-path.ts';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

/* ── What it is for ──────────────────────────────────────────────────────── */

test('an ordinary destination survives', () => {
  assert.equal(safeNext('/app/entry/abc/'), '/app/entry/abc/');
});

test('so does a fragment, which is the whole point of the deep link', () => {
  assert.equal(
    safeNext('/app/entry/abc/#deliverables'),
    '/app/entry/abc/#deliverables'
  );
});

test('and a query string', () => {
  assert.equal(safeNext('/app/?show=flagged'), '/app/?show=flagged');
});

test('percent encoding is decoded, since that is how a link arrives', () => {
  assert.equal(
    safeNext(encodeURIComponent('/app/entry/abc/#deadlines')),
    '/app/entry/abc/#deadlines'
  );
});

/* ── What it is against ──────────────────────────────────────────────────── */

test('an absolute URL is refused', () => {
  assert.equal(safeNext('https://evil.example/'), HOME);
  assert.equal(safeNext('http://evil.example/'), HOME);
});

test('a protocol relative URL is refused, which is the one people miss', () => {
  /* `//evil.example` starts with a slash and satisfies a naive check, and a
     browser reads it as another origin. */
  assert.equal(safeNext('//evil.example/'), HOME);
});

test('and its backslash spelling', () => {
  /* At least one browser treats `/\` as `//`. */
  assert.equal(safeNext('/\\evil.example/'), HOME);
});

test('an encoded protocol relative URL is refused', () => {
  /* The reason decoding happens before checking rather than after. */
  assert.equal(safeNext('%2f%2fevil.example%2f'), HOME);
  assert.equal(safeNext('%2F%2Fevil.example'), HOME);
});

test('a scheme hidden behind a slash is refused', () => {
  assert.equal(safeNext('/https://evil.example'), HOME);
  assert.equal(safeNext('/javascript:alert(1)'), HOME);
});

test('a newline is refused, because a header can be split with one', () => {
  assert.equal(safeNext('/app/\nLocation: https://evil.example'), HOME);
  assert.equal(safeNext('/app/\r\nSet-Cookie: a=b'), HOME);
});

test('a malformed encoding is hostile rather than empty', () => {
  assert.equal(safeNext('%'), HOME);
  assert.equal(safeNext('%zz'), HOME);
});

test('somewhere outside the working surface is refused', () => {
  /* A notification never points anywhere else, and a public page needs no
     session, so there is nothing legitimate for this to carry. */
  assert.equal(safeNext('/articles/2026/something/'), HOME);
  assert.equal(safeNext('/auth/signout/'), HOME);
  assert.equal(safeNext('/'), HOME);
});

test('a relative path with no leading slash is refused', () => {
  assert.equal(safeNext('app/entry/abc/'), HOME);
  assert.equal(safeNext('../../etc/passwd'), HOME);
});

test('nothing at all is the home page, not a crash', () => {
  assert.equal(safeNext(null), HOME);
  assert.equal(safeNext(undefined), HOME);
  assert.equal(safeNext(''), HOME);
});

/* ── Remembering the current address ─────────────────────────────────────── */

test('signInWith keeps the path and the query', () => {
  /* Not the fragment, and this test used to claim otherwise by handing the
     function a URL object built with a hash in it. **A server never sees a
     fragment**: the browser keeps `#deadlines` to itself and sends
     `GET /app/entry/abc/`. The function would carry one if it were given
     one, and the flow cannot give it one, so asserting on it proved
     something unreachable.
   
     This is why a notification's anchor has to travel as a query parameter
     rather than a fragment. Recorded in 20.10. */
  const url = new URL('https://montavista.example/app/entry/abc/?x=1');
  assert.equal(
    signInWith(url),
    `/app/?next=${encodeURIComponent('/app/entry/abc/?x=1')}`
  );
});

test('and does not send somebody to sign in in order to reach sign in', () => {
  /* The overview is where a person without a session lands anyway, so
     carrying it as a destination is a loop with extra steps. */
  const url = new URL('https://montavista.example/app/');
  assert.equal(signInWith(url), HOME);
});

test('what signInWith produces is something safeNext accepts', () => {
  /* The two halves have to agree, and the encoding is where they would
     stop agreeing. */
  const url = new URL('https://montavista.example/app/entry/abc/?at=deliverables');
  const carried = new URL(`https://x.example${signInWith(url)}`);
  assert.equal(
    safeNext(carried.searchParams.get('next')),
    '/app/entry/abc/?at=deliverables'
  );
});

test('the middleware is what remembers, not the pages', () => {
  /* The bug this file was written for and did not catch.
   
     Fourteen pages got a guard that remembered the destination, and not one
     of them ever ran: the middleware redirects an unauthenticated request
     before any page is reached, and it sent a bare `/app/`. Every test here
     passed, because every one of them tested the function rather than the
     path a request actually takes.
   
     So this reads the file that does the redirecting. */
  const middleware = fs.readFileSync('src/middleware.ts', 'utf8');

  assert.match(
    middleware,
    /return context\.redirect\(signInWith\(url\)\)/,
    'the unauthenticated redirect has to carry where they were going'
  );
});

/* ── The cookies these routes set ────────────────────────────────────────── */

test('nothing sets a Secure cookie without checking the connection', () => {
  /* A browser drops a Secure cookie on plain http, so on a local
     `http://montavista.localhost` the destination would vanish and the
     person would land on the overview: the exact failure this route exists
     to prevent, arriving silently.
   
     Chromium treats *.localhost as trustworthy and other browsers do not,
     so it works for one developer and not the next, which is worse than
     failing for everybody. */
  const problems = [];

  for (const file of [
    'src/pages/auth/signin.ts',
    'src/pages/auth/password.ts',
    'src/pages/auth/callback.ts',
    'src/lib/session-hint.ts',
  ]) {
    const text = fs.readFileSync(file, 'utf8');
    if (/secure:\s*true/.test(text)) problems.push(file);
  }

  assert.deepEqual(problems, [], "secure follows url.protocol, it is not a constant");
});

test('the session hint survives a round trip through a cookie', () => {
  /* The masthead on every public page read this and printed
     `Rohan%20Agarwal`. The name was encoded in `setSessionHint` and encoded
     again by Astro's cookie writer, whose default encoder is
     `encodeURIComponent`, so the reader's single decode left one layer on —
     and it read as a bug in somebody's name rather than in ours.

     The function is called for real, against a jar that serializes the way
     Astro's does, and the assertion is on the string a browser would hold.
     An earlier version of this read the source for the word `encode` and
     shaped its own expectation around what it found, which is a test that
     agrees with whatever it is looking at: reverting the fix left it green.
     19.9 — a check that cannot fail is worse than no check, because it is
     counted.

     A space is the character that exposes it, and every display name with two
     words has one. */
  /* A jar that behaves the way Astro's does: it encodes the value unless the
     caller supplies an encoder. Modelled here rather than imported, because
     `cookie` is a transitive dependency of the framework and this suite
     refuses those a few tests above — a promise nobody made is not a promise.
     One line of behavior is a fair thing to restate; the line is the whole
     contract being tested. */
  let stored = '';
  setSessionHint(
    {
      set: (_name, value, options = {}) => {
        const encode = options.encode ?? encodeURIComponent;
        stored = encode(value);
      },
      delete: () => {},
    },
    'Rohan Agarwal',
    false
  );

  assert.ok(SESSION_HINT, 'the cookie should have a name');
  assert.equal(
    decodeURIComponent(stored),
    'Rohan Agarwal',
    `one decode should give the name back, got "${decodeURIComponent(stored)}"`
  );
});

if (process.exitCode) {
  console.error('\nAn open redirect in a link we mailed is worse than no link.\n');
} else {
  console.log(`\n${passed} destination assertions passed.`);
}
