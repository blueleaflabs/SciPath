/**
 * Every table that can hold a storage path is checked by the media route.
 *
 * R2 carries no row-level security, so `/app/media/` is the only way bytes
 * leave the bucket, and it decides by asking whether the path is referenced
 * by a row the caller may already read. That list of tables is maintained by
 * hand.
 *
 * `project_images` was added and the list was not, so every showcase image
 * 404'd: uploaded, stored, referenced, and unreachable. The failure is silent
 * in one direction only — nothing leaks and something legitimate disappears —
 * which is the safer half and the harder one to notice.
 *
 * Run: npm run test:media
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { migrationSql } from './migrations.mjs';

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

const ROUTE = 'src/pages/app/media/[...path].ts';
const route = fs.readFileSync(ROUTE, 'utf8');

const dir = 'supabase/migrations';
const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

/** Tables with a column that names an object in the bucket. */
const holders = new Set();
for (const m of sql.matchAll(/create table public\.(\w+)\s*\(\n([\s\S]*?)\n\);/g)) {
  if (/^\s+(storage_path|pdf_path)\s/m.test(m[2])) holders.add(m[1]);
}

/**
 * `records` holds a path and is served from the record store rather than
 * here: a published file is public and has its own route, which is the point
 * of publishing. Everything else in the working bucket comes through this
 * one.
 */
const ELSEWHERE = new Set(['records']);

test('the migration has tables holding storage paths', () => {
  assert.ok(holders.size >= 5, `only found ${holders.size}`);
});

test('the route checks every one of them', () => {
  const checked = new Set([...route.matchAll(/from\('(\w+)'\)/g)].map((m) => m[1]));
  const missing = [...holders].filter((t) => !ELSEWHERE.has(t) && !checked.has(t));

  assert.deepEqual(
    missing,
    [],
    'a table missing here means its files 404 while everything looks correct'
  );
});

test('a path referenced by nothing is a 404, not an error', () => {
  /* Both answers are 404 on purpose: "this is not ours" and "you may not see
     it" should be indistinguishable from outside. */
  assert.match(route, /if \(!references\.some/);
  assert.match(route, /status: 404/);
});

test('the response is never publicly cached', () => {
  /* A cached copy in a shared cache would outlive the permission that
     allowed it. */
  const headers = route.slice(route.indexOf('headers:'));
  assert.match(headers, /'Cache-Control': 'private/);
  assert.doesNotMatch(headers, /public/);
});

test('the browser is told not to guess the type', () => {
  assert.match(route, /X-Content-Type-Options.*nosniff/);
});

/* ── What the export contains ────────────────────────────────────────────── */

test('the exported notebook carries everything the project has', () => {
  /* This is what a judge is handed. It carried the entries and the paperwork
     and nothing else, so a project's calendar, its showcase, and its video
     existed only on a screen the judge will never see. */
  const notebook = fs.readFileSync('src/pages/app/project/[id]/notebook.astro', 'utf8');

  for (const [what, marker] of [
    ['the deadlines', /from\('entry_milestones'\)/],
    ['the showcase images', /from\('project_images'\)/],
    ['the video', /parseVideo/],
    ['the notebook entries', /from\('field_notes'\)/],
    ['the paperwork', /from\('deliverables'\)/],
  ]) {
    assert.match(notebook, marker, `the export is missing ${what}`);
  }
});

test('the printed page has a margin of its own', () => {
  /* Without an @page rule the browser uses its default, which puts the first
     line against the edge and leaves a judge nowhere to write. */
  const notebook = fs.readFileSync('src/pages/app/project/[id]/notebook.astro', 'utf8');
  assert.match(notebook, /@page\s*\{[^}]*margin/);
});

test('and prints the address behind a link', () => {
  /* A link is useless on paper unless the address is on the paper. */
  const notebook = fs.readFileSync('src/pages/app/project/[id]/notebook.astro', 'utf8');
  assert.match(notebook, /a\[href\^='http'\]::after/);
});

/* ── Deadlines are grouped by phase ──────────────────────────────────────── */

test('a phase reaches the database', () => {
  /* Phases existed in the templates and stopped at the seed. A grouping
     nothing can query is a grouping that only exists in a YAML file. */
  const sql = migrationSql();

  assert.match(sql, /phases\s+jsonb/, 'the program should carry its phase list');

  for (const table of ['program_milestones', 'entry_milestones']) {
    const create = sql.slice(sql.indexOf(`create table public.${table}`));
    assert.match(create.slice(0, create.indexOf('\n);')), /^\s+phase\s/m, `${table} has no phase`);
  }
});

test('every copy of a milestone carries the phase', () => {
  /* Four functions copy these, and the last time a column was added two of
     them were missed. */
  const sql = migrationSql();
  const starts = [...sql.matchAll(/insert into public\.entry_milestones\b/g)].map((m) => m.index);

  const missing = starts.filter((at) => !/\bphase\b/.test(sql.slice(at, sql.indexOf(';', at))));
  assert.equal(missing.length, 0, `${missing.length} copies drop the phase`);
});

test('both the page and the printout group by it', () => {
  for (const file of [
    'src/pages/app/project/[id]/in/[program].astro',
    'src/pages/app/project/[id]/notebook.astro',
  ]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /phase-row/, `${file} lists deadlines flat`);
    assert.match(text, /phases/, `${file} does not read the phase list`);
  }
});

test('a milestone whose phase is unknown still appears', () => {
  /* A template edited after a season started can leave a milestone naming a
     phase nobody declares. Vanishing quietly is worse than an untidy
     heading. */
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  assert.match(entry, /Everything else/);
});

/* ── A published file is served as something a browser can render ────────── */

test('every type the app accepts is a type the record store can serve', () => {
  /* `svg` was missing from the map in `record-files.ts`, so a seeded
     showcase image was written correctly and served as
     `application/octet-stream` — which a browser answers with the broken
     icon and the alt text. Every seeded project failed on every published
     page while a PNG upload worked, which is why nothing noticed. */
  const files = fs.readFileSync('src/lib/record-files.ts', 'utf8');
  const block = files.slice(files.indexOf('const MIME'), files.indexOf('};', files.indexOf('const MIME')));

  const served = new Set([...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));

  /* What the seed writes and what an upload accepts. */
  const accepted = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf'];

  const missing = accepted.filter((ext) => !served.has(ext));
  assert.deepEqual(missing, [], 'these would be served as octet-stream');
});

test('a video with no still shows something deliberate', () => {
  /* YouTube publishes a still at a predictable address and Vimeo's needs an
     API call, which is a request made on a reader's behalf for something
     they did not ask for. The fallback was an empty box, which reads as a
     broken page rather than a video waiting to be played. */
  const record = fs.readFileSync('src/components/RecordDetail.astro', 'utf8');
  assert.match(record, /poster drawn/);
  assert.match(record, /\.video \.drawn/, 'and it should be styled');
});

/* ── A paper and a fair entry are siblings, not duplicates ───────────────── */

test('the publish screen says which kind each record is', () => {
  /* A project can have both. The published pages already link to one
     another; this screen listed two rows with the same title and nothing to
     tell them apart, which reads as a duplicate somebody made by mistake. */
  const publish = fs.readFileSync('src/pages/app/publish/index.astro', 'utf8');

  assert.match(publish, /<th>Kind<\/th>/, 'the kind should be a column');
  assert.match(publish, /'Fair entry' : 'Paper'/);
  assert.match(publish, /companionCount/, 'a paired record should say so');
});

test('and warns before a second record is made, not after', () => {
  const publish = fs.readFileSync('src/pages/app/publish/index.astro', 'utf8');
  assert.match(publish, /paperFor\.has/, 'the entry queue should know about the paper');
});

console.log(`${passed} media assertions passed. ${holders.size} tables hold paths.`);
