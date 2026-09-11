#!/usr/bin/env node
/**
 * A ONE-PAGE HANDOUT FOR THE SHOWCASE (dev-151).
 *
 * The Research Club's info day wants something on paper: the journal's
 * name, the address, and two pictures of the thing itself — the top of
 * the showcase down to where the list begins, and the featured record's
 * page down through its citation. Taken from a live page rather than
 * pasted, so what is on the table is what is on the site that morning.
 *
 * Writes local-data/onepager/<slug>/handout.pdf, the two pictures beside
 * it and the HTML the PDF was printed from (edit and reprint by hand if
 * a line needs changing). Letter, portrait.
 *
 * Run:
 *   npm run onepager -- --base http://demo.localhost:4321
 *   npm run onepager -- --base https://demo.scipath.org
 *   npm run onepager -- --base … --record /projects/2026/thermal-tolerance-in-intertidal-snails/
 *   npm run onepager -- --base … --title "Monta Vista Research Journal" --sub "Showcase demo on SciPath"
 */

import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, wait } from './browser.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const base = (arg('--base') ?? '').replace(/\/$/, '');
if (!base) { console.error('\n  --base is needed: the site to photograph (http://demo.localhost:4321 or https://demo.scipath.org).\n'); process.exit(1); }
const title = arg('--title', 'Monta Vista Research Journal');
const sub = arg('--sub', 'Showcase demo on SciPath');
const shown = arg('--url', base);
let recordPath = arg('--record');
const width = 1280;

const slug = new URL(base).hostname.split('.')[0];
const out = path.join('local-data', 'onepager', slug);
fs.mkdirSync(out, { recursive: true });

/* `--chrome /path` names a browser; otherwise the usual places are tried. */
const tab = await openBrowser({ port: 9470, width, height: 900, chrome: arg('--chrome') });

/** The page from the top down to the element named, as a PNG data URI. */
async function pictureTo(file, selector, extra = 0) {
  await wait(400);
  const bottom = await tab.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return Math.ceil(r.top + window.scrollY + ${extra}); })()`);
  const h = bottom ?? (await tab.evaluate('Math.min(document.documentElement.scrollHeight, 2400)'));
  const png = await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } });
  fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
  return `data:image/png;base64,${png.data}`;
}

/* 1. The showcase, to where the list begins. */
await tab.go(`${base}/showcase/`);
const showcase = await pictureTo(path.join(out, 'showcase.png'), '.sec.featured ~ .sec:not(.browse), nav.chips', -12);

/* 2. The featured record, through its citation. */
if (!recordPath) {
  recordPath = await tab.evaluate(`(() => { const a = document.querySelector('.featured a.fcard'); return a ? a.getAttribute('href') : null; })()`);
}
if (!recordPath) { console.error('\n  No featured record on the showcase; pass --record /projects/<year>/<slug>/.\n'); process.exit(1); }
await tab.go(`${base}${recordPath}`);
const citeBottom = await tab.evaluate(`(() => { const el = document.querySelector('#cite, .cite, [data-copy]'); if (!el) return null; const box = el.closest('section') ?? el; const r = box.getBoundingClientRect(); return Math.ceil(r.bottom + window.scrollY + 16); })()`);
const recordPng = await (async () => {
  await wait(400);
  const h = citeBottom ?? (await tab.evaluate('Math.min(document.documentElement.scrollHeight, 3200)'));
  const png = await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: h, scale: 1 } });
  fs.writeFileSync(path.join(out, 'record.png'), Buffer.from(png.data, 'base64'));
  return `data:image/png;base64,${png.data}`;
})();

/* 3. The page. Two pictures side by side under the name and the address,
      each scaled to fit its column; the taller one decides the height. */
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} — handout</title>
<style>
  @page { size: Letter landscape; margin: 0.45in 0.55in; }
  html, body { margin: 0; padding: 0; }
  body { font-family: Georgia, "Times New Roman", serif; color: #1b1a17; }
  header { text-align: center; margin: 0 0 10px; }
  h1 { font-size: 24pt; margin: 0; letter-spacing: -0.01em; }
  .sub { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 12.5pt; color: #4a4640; margin: 4px 0 0; letter-spacing: 0.02em; }
  .url { font-family: ui-monospace, Menlo, monospace; font-size: 15pt; margin: 8px 0 0; }
  .url b { border-bottom: 2px solid #c9a227; padding-bottom: 1px; }
  .pics { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
  figure { margin: 0; }
  figure img { width: 100%; max-height: 5.9in; object-fit: contain; object-position: top; height: auto; display: block; border: 1px solid #cfcdc5; box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  figcaption { font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 8.5pt; color: #5b5750; margin: 5px 0 0; }
  footer { margin-top: 12px; font-family: -apple-system, Helvetica, Arial, sans-serif; font-size: 9pt; color: #5b5750; display: flex; justify-content: space-between; gap: 12px; }
</style>
</head>
<body>
<header>
  <h1>${title}</h1>
  <p class="sub">${sub}</p>
  <p class="url"><b>${shown}</b></p>
</header>
<div class="pics">
  <figure><img src="${showcase}" alt="The showcase page"><figcaption>The showcase: featured work, the archive by year and by subject, and every published record with its abstract.</figcaption></figure>
  <figure><img src="${recordPng}" alt="A published record"><figcaption>A published record: the question, the result, the pictures, the abstract, and a citation to copy.</figcaption></figure>
</div>
<footer>
  <span>Read, search and cite every published record at ${shown}.</span>
  <span>SciPath is free, open source software for student research.</span>
</footer>
</body>
</html>`;
fs.writeFileSync(path.join(out, 'handout.html'), html);

await tab.go(`file://${path.resolve(path.join(out, 'handout.html'))}`);
await wait(800);
const pdf = await tab.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
fs.writeFileSync(path.join(out, 'handout.pdf'), Buffer.from(pdf.data, 'base64'));

console.log(`\n  ${path.join(out, 'handout.pdf')}\n  ${path.join(out, 'handout.html')}  (edit and reprint by hand if a line needs changing)\n  ${path.join(out, 'showcase.png')}\n  ${path.join(out, 'record.png')}\n`);
process.exit(0);
