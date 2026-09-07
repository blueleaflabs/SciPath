#!/usr/bin/env node
/**
 * EVERY PAGE, AT EVERY WIDTH, AS A PICTURE (2.8).
 *
 * The one check no source file can make: what a page looks like on a
 * phone, a tablet and a laptop. This drives a Chrome you already have
 * (no browser download, no test framework) over the DevTools protocol:
 * it signs in as each account named, opens each page, sets the viewport
 * to each width, and writes a PNG into `local-data/shots/<width>/`.
 * Look through the folder; send the ones that are wrong.
 *
 *   npm run shots                                   # the local stack, public pages
 *   npm run shots -- --as student@x --as elder@x --password 'phrase'
 *   npm run shots -- --base https://montavista.scipath.org --as you@fuhsd.org --password '…'
 *   npm run shots -- --widths 390,1280 --pages /app/,/app/live/
 *
 * `--as` may repeat; each account gets its own subfolder. Pages default
 * to the working surface a signed-in person sees (the Workbench, their
 * first project, its deadlines, its first document, the live log) plus
 * the public front door; `--pages` replaces the list. Chrome is found at
 * the usual places or named in `CHROME`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadDevVars } from './dev-vars.mjs';
import { openBrowser, wait } from './browser.mjs';

loadDevVars();

const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));

const base = (opt('--base') ?? 'http://montavista.localhost:4321').replace(/\/$/, '');
const widths = (opt('--widths') ?? '390,768,1280').split(',').map((w) => Number(w.trim())).filter(Boolean);
const accounts = all('--as');
const password = opt('--password') ?? '';
const pagesArg = opt('--pages');
const out = opt('--out') ?? 'local-data/shots';
const port = Number(opt('--port') ?? 9333);

function fail(m) { console.error(`\n  ${m}\n`); process.exit(1); }

const tab = await openBrowser({ port, chrome: process.env.CHROME });
const signIn = (email) => tab.signIn(base, email, password);
const signOut = () => tab.signOut();

/* The pages a signed-in person has: read off the Workbench rather than
   guessed, so a student's first project and its first document are the
   real ones. */
async function pagesFor() {
  if (pagesArg) return pagesArg.split(',').map((p) => p.trim()).filter(Boolean);
  await tab.go(`${base}/app/`);
  const found = await tab.evaluate(`(() => {
    const hrefs = [...document.querySelectorAll('a[href^="/app/"]')].map((a) => a.getAttribute('href'));
    const first = (re) => hrefs.find((h) => re.test(h));
    return [
      '/app/',
      first(/^\\/app\\/project\\/[^/]+\\/in\\/[^/]+\\/$/),
      first(/^\\/app\\/project\\/[^/]+\\/$/),
      first(/^\\/app\\/project\\/[^/]+\\/doc\\/[^/]+\\/$/),
      first(/^\\/app\\/program\\/[^/]+\\/class\\/$/),
      first(/^\\/app\\/program\\/[^/]+\\/tracker\\/$/),
      '/app/profile/',
      '/app/live/',
    ].filter(Boolean);
  })()`);
  /* A document, if the project page names one and the Workbench did not. */
  const proj = found.find((p) => /^\/app\/project\/[^/]+\/in\//.test(p));
  if (proj && !found.some((p) => /\/doc\//.test(p))) {
    await tab.go(`${base}${proj}`);
    const doc = await tab.evaluate(`(() => { const a = [...document.querySelectorAll('a[href*="/doc/"]')][0]; return a ? a.getAttribute('href') : null; })()`);
    if (doc) found.push(doc.split('?')[0]);
  }
  return [...new Set(found)];
}

const PUBLIC = ['/', '/about/', '/showcase/', '/feedback/'];
let total = 0;
const problems = [];

async function run(label, pages) {
  for (const w of widths) {
    await tab.size(w, w < 800);
    for (const p of pages) {
      await tab.go(`${base}${p}`);
      const name = (p === '/' ? 'home' : p.replace(/^\/|\/$/g, '').replace(/\//g, '_')) + '.png';
      const file = path.join(out, String(w), label, name);
      const over = await tab.shot(file, w);
      total += 1;
      if (over.length > 0) problems.push(`${w}px ${label} ${p}: ${over.join(', ')}`);
      console.log(`  ${String(w).padStart(5)}  ${label.padEnd(24)} ${p}${over.length ? '   ⚠ overflows: ' + over.join(', ') : ''}`);
    }
  }
}

console.log(`\nShots from ${base} into ${out}/ (${tab.chrome})\n`);
await run('public', PUBLIC);
for (const email of accounts) {
  if (!password) fail('--password is needed with --as.');
  const { ok, where } = await signIn(email);
  if (!where.startsWith('/app') || where.includes('signin')) { console.log(`  could not sign in as ${email} (${ok}; landed on ${where})`); continue; }
  const pages = await pagesFor();
  await run(email.split('@')[0], pages);
  await signOut();
}

console.log(`\n${total} pictures written to ${out}/.`);
if (problems.length) {
  console.log(`\n${problems.length} page${problems.length === 1 ? '' : 's'} with something wider than the screen (clipped, not scrolled, by the body's guard):`);
  for (const p of problems) console.log(`  ${p}`);
} else {
  console.log('Nothing wider than the screen on any page.');
}
process.exit(0);
