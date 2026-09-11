/**
 * THE DEMONSTRATION RECORDS AND THE SHOWCASE FRONT (dev-149).
 *
 * The demonstration tenant holds real papers beside invented ones, and a
 * flyer now points at it. Asserted: the invented mark is per record and
 * derived from the tenant's file; a real school never shows it; the
 * featured rule never leads with an invented record and honours the
 * school's own list; the seed dates fixtures once rather than "today";
 * the refresh refuses a real school before it reads anything; and the
 * pages carry the mark and the front.
 *
 * Run: npm run test:demo
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isDemonstration } from '../src/lib/records-store.ts';
import { featuredRecords } from '../src/lib/featured.ts';
import { FIXTURE_PUBLISHED_ON, FIXTURE_SHOTS } from '../src/config/demo-records.mjs';
import { shapeOrg } from '../src/config/org-shape.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const record = (over = {}) => ({
  recordId: 'DEMO-2026-0001', recordKind: 'article', slug: 'x', year: 2026, title: 'x', authors: [],
  abstract: '', keywords: [], discipline: 'physics', publishedOn: '2026-09-04', datePrecision: 'day',
  source: 'workbench', reviewed: true, bodyFormat: 'full-text', methods: [], dataSources: [], outputs: [],
  entries: [], figures: [], shots: [], references: [], dataLinks: [], license: 'CC-BY', status: 'published',
  ...over,
});

/* ── The mark ───────────────────────────────────────────────────────────── */

test('on a demonstration tenant, a workbench record is invented and a migrated one is not', () => {
  const demo = { demo: true };
  assert.equal(isDemonstration(demo, record()), true);
  assert.equal(isDemonstration(demo, record({ source: 'migrated' })), false);
  assert.equal(isDemonstration(demo, record({ source: 'external' })), true);
});

test('a real school never shows the mark, whatever the source', () => {
  for (const source of ['workbench', 'migrated', 'external']) {
    assert.equal(isDemonstration({ demo: false }, record({ source })), false);
    assert.equal(isDemonstration(null, record({ source })), false);
  }
});

/* ── Featured ───────────────────────────────────────────────────────────── */

const pool = [
  record({ recordId: 'A-2024-0001', publishedOn: '2024-05-01', source: 'migrated' }),
  record({ recordId: 'A-2025-0002', publishedOn: '2025-05-01', source: 'migrated', entries: [{ program: 'Fair', awards: ['Prize'], placement: null }] }),
  record({ recordId: 'A-2025-0003', publishedOn: '2025-06-01', source: 'migrated', reviewed: false }),
  record({ recordId: 'A-2026-0004', publishedOn: '2026-01-01', source: 'migrated', entries: [{ program: 'Fair', awards: [], placement: 'First' }] }),
  record({ recordId: 'DEMO-2026-0009', publishedOn: '2026-09-04', source: 'workbench', demonstration: true, entries: [{ program: 'Fair', awards: ['Big'], placement: 'First' }] }),
  record({ recordId: 'A-2023-0005', publishedOn: '2023-05-01', source: 'migrated', status: 'retracted' }),
];

test('awarded first, newest first, then reviewed, then the rest; never an invented or retracted record', () => {
  const ids = featuredRecords({ featured: [] }, pool).map((r) => r.recordId);
  assert.deepEqual(ids, ['A-2026-0004', 'A-2025-0002', 'A-2024-0001', 'A-2025-0003']);
});

test('on the demonstration tenant the invented record with pictures leads, ahead of the school\'s own list', () => {
  const withPictures = pool.map((r) => r.recordId === 'DEMO-2026-0009' ? { ...r, recordKind: 'project', shots: [{ src: '/x.png', caption: 'x', alt: 'x' }] } : r);
  const ids = featuredRecords({ demo: true, featured: ['A-2024-0001'] }, withPictures).map((r) => r.recordId);
  assert.deepEqual(ids.slice(0, 3), ['DEMO-2026-0009', 'A-2024-0001', 'A-2026-0004']);
  /* Without pictures it has nothing to show, and does not lead. */
  assert.equal(featuredRecords({ demo: true, featured: [] }, pool)[0].recordId, 'A-2026-0004');
});

test('the showcase is named by the tenant, with a word under the name', () => {
  const demo = fs.readFileSync('src/config/orgs/demo.yaml', 'utf8');
  assert.match(demo, /^showcase_title: Monta Vista Research Club Journal$/m);
  assert.match(demo, /^showcase_kicker: Demo showcase$/m);
  const page = fs.readFileSync('src/pages/showcase/index.astro', 'utf8');
  assert.match(page, /title=\{archive\.org\.showcaseTitle \?\? 'Showcase'\}/);
  assert.match(page, /sub=\{archive\.org\.showcaseKicker\}/);
});

test('one hue per discipline, worn by the cover, the topic page, the card and the record page', () => {
  const site = fs.readFileSync('src/config/site.ts', 'utf8');
  assert.match(site, /export function disciplineHue/);
  for (const file of ['src/components/RecordCover.astro', 'src/pages/topics/[slug].astro', 'src/components/RecordCard.astro', 'src/components/RecordDetail.astro']) {
    assert.match(fs.readFileSync(file, 'utf8'), /disciplineHue\(|toneStyle\(/, `${file} does not use the tone`);
  }
  assert.doesNotMatch(fs.readFileSync('src/components/RecordCover.astro', 'utf8'), /const HUES/);
});

test("the school's own list leads, in its order, and unknown ids are ignored", () => {
  const ids = featuredRecords({ featured: ['A-2025-0003', 'NOPE-1', 'A-2024-0001'] }, pool).map((r) => r.recordId);
  assert.deepEqual(ids.slice(0, 2), ['A-2025-0003', 'A-2024-0001']);
  assert.equal(ids.length, 4);
});

test('the list is capped', () => {
  assert.equal(featuredRecords({ featured: [] }, pool, 2).length, 2);
});

/* ── The org file ───────────────────────────────────────────────────────── */

test('front_door and featured shape from the document, and only showcase is understood', () => {
  const base = { slug: 'x', name: 'X', mark: 'X', theme: 'proceedings', record_prefix: 'X', timezone: 'UTC', contact_email: 'a@b.c', showcase_note: '' };
  assert.equal(shapeOrg({ ...base, front_door: 'showcase' }).frontDoor, 'showcase');
  assert.equal(shapeOrg({ ...base, front_door: 'pitch' }).frontDoor, undefined);
  assert.deepEqual(shapeOrg({ ...base, featured: ['A-1', 2] }).featured, ['A-1', '2']);
  assert.deepEqual(shapeOrg(base).featured, []);
});

test('the demonstration tenant opens on its showcase; no real school does', () => {
  const demo = fs.readFileSync('src/config/orgs/demo.yaml', 'utf8');
  assert.match(demo, /^front_door: showcase$/m);
  for (const file of fs.readdirSync('src/config/orgs').filter((f) => f.endsWith('.yaml') && f !== 'demo.yaml')) {
    const text = fs.readFileSync(`src/config/orgs/${file}`, 'utf8');
    if (!/^demo: true$/m.test(text)) assert.doesNotMatch(text, /^front_door:/m, `${file} names a front door`);
  }
});

/* ── The seed and the refresh ───────────────────────────────────────────── */

test('the fixture dates are fixed, in the past, and the seed uses them rather than today', () => {
  for (const kind of ['article', 'project']) {
    assert.match(FIXTURE_PUBLISHED_ON[kind], /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(FIXTURE_PUBLISHED_ON[kind] < new Date().toISOString().slice(0, 10));
  }
  const seed = fs.readFileSync('scripts/seed-publish.mjs', 'utf8');
  assert.doesNotMatch(seed, /p_published_on: new Date\(\)/);
  assert.match(seed, /FIXTURE_PUBLISHED_ON\.article/);
  assert.match(seed, /FIXTURE_PUBLISHED_ON\.project/);
});

test('four drawn pictures, each present, each with alt and caption', () => {
  assert.equal(FIXTURE_SHOTS.length, 4);
  for (const s of FIXTURE_SHOTS) {
    assert.ok(fs.existsSync(`scripts/fixtures/shots/${s.file}`), `${s.file} is missing`);
    assert.ok(s.alt.length > 20 && s.caption.length > 20);
    assert.match(s.caption, /Illustration/);
  }
});

test('the refresh refuses a real school before touching the database, and never deletes', () => {
  const src = fs.readFileSync('scripts/demo-refresh.mjs', 'utf8');
  assert.match(src, /fixtureTarget\(/);
  assert.match(src, /orgs\[ORG_SLUG\]\?\.demo/);
  assert.ok(src.indexOf('orgs[ORG_SLUG]?.demo') < src.indexOf('createClient('), 'the guard must come before the client');
  assert.doesNotMatch(src, /\.delete\(/);
  assert.match(src, /\.eq\('source', 'workbench'\)/);
  assert.match(src, /index-records\.mjs/);
});

/* ── The pages ──────────────────────────────────────────────────────────── */

test('the card and the detail page carry the mark; the detail page says it once in words', () => {
  assert.match(fs.readFileSync('src/components/RecordCard.astro', 'utf8'), /d\.demonstration &&/);
  const detail = fs.readFileSync('src/components/RecordDetail.astro', 'utf8');
  assert.match(detail, /isDemonstration\(org, d\)/);
  assert.match(detail, /class="demo-note"/);
});

test('the showcase opens with featured, then year and subject, then the list; search stays in the masthead; nothing rotates', () => {
  const page = fs.readFileSync('src/pages/showcase/index.astro', 'utf8');
  const at = (s) => { const i = page.indexOf(s); assert.ok(i >= 0, `missing ${s}`); return i; };
  assert.doesNotMatch(page, /<form/);
  assert.match(fs.readFileSync('src/components/Masthead.astro', 'utf8'), /action="\/search\/"/);
  assert.ok(at('class="sec featured"') < at('By year'));
  assert.ok(at('By year') < at('By subject'));
  assert.ok(at('By subject') < at('<RecordCard record={r} />'));
  assert.match(page, /featuredRecords\(archive\.org, archive\.all\)/);
  assert.doesNotMatch(page, /setInterval|autoplay|<script/i);
});

test('the home page sends a visitor through the front door and a session past it', () => {
  const home = fs.readFileSync('src/pages/index.astro', 'utf8');
  assert.match(home, /org\.frontDoor === 'showcase' && !\(Astro\.locals as any\)\.session/);
  assert.match(home, /Astro\.redirect\('\/showcase\/', 302\)/);
});

console.log(`  ${passed} passed`);
