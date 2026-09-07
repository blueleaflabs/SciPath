/**
 * THE SHOWCASE THAT WRITES ITSELF (2.8).
 *
 * A submitted deliverable becomes a section by its shape's `showcase`
 * block; the tile's picture and line come from the newest section; what
 * is not yet in is "coming next". Asserted on the builder with real
 * shapes, and on the pages using it.
 *
 * Run: npm run test:showcase
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadLibrary } from '../scripts/template-library.mjs';
import { shapeFrom } from '../src/lib/template-resolve.ts';
import { showcaseSection, latestPicture, firstHeadline } from '../src/lib/showcase-sections.ts';

const library = loadLibrary();
const shape = (id) => shapeFrom(library, id);

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

test('every shape a student writes on the showcase has a showcase block, and the links do not', () => {
  for (const id of ['research-question', 'project-summary', 'impact-feasibility', 'interview-protocol', 'journey-map', 'literature-review', 'literature-review-worksheet']) {
    const sh = shape(id);
    assert.ok(sh?.showcase?.title, `${id} has no showcase block`);
    for (const item of sh.showcase.show ?? []) assert.ok(item.field || item.fields, `${id}: a show item names no field`);
  }
  for (const id of ['drive-link', 'mark-done']) assert.equal(shape(id)?.showcase, undefined, `${id} is not showcase material`);
});

test('a project summary becomes a section with the graphic as its picture and the question as its headline', () => {
  const sec = showcaseSection(shape('project-summary'), {
    question: 'Can a **cheap** sensor tell creek turbidity?',
    impact: 'Cleaner creeks.',
    data: 'Turbidity readings, twice a week.',
    users: 'The creek volunteers.',
    graphic: { path: 'docs/x/graphic.png', name: 'graphic.png' },
  }, { key: 'project_summary', deliverable: 'Research Graphic', at: '2026-09-10T17:00:00Z' });
  assert.ok(sec);
  assert.equal(sec.title, 'Research graphic');
  assert.equal(sec.headline, 'Can a cheap sensor tell creek turbidity?');
  assert.deepEqual(sec.hero, { path: 'docs/x/graphic.png', alt: 'graphic.png' });
  assert.equal(sec.blocks.length, 3);
  assert.equal(sec.blocks[0].kind, 'prose');
  assert.match(sec.blocks[0].html, /Cleaner creeks/);
});

test('a lit review lists its sources from the table\'s first column, and an empty document makes no section', () => {
  const sec = showcaseSection(shape('literature-review'), {
    introduction: 'Three papers matter.',
    sources: [['Smith 2021', 'a', 'b'], ['', '', ''], ['Lee 2023', 'c', 'd']],
  }, { key: 'lit', deliverable: 'Lit Review v2', at: null });
  assert.ok(sec);
  const list = sec.blocks.find((b) => b.kind === 'list');
  assert.deepEqual(list.items, ['Smith 2021', 'Lee 2023']);
  assert.equal(showcaseSection(shape('literature-review'), {}, { key: 'lit', deliverable: 'x', at: null }), null);
  assert.equal(showcaseSection(shape('drive-link'), { url: 'https://x' }, { key: 'd', deliverable: 'x', at: null }), null);
});

test('the interview questions come out as a list, skipping blanks; the ratings as chips', () => {
  const q = showcaseSection(shape('interview-protocol'), { q1: 'Why?', q2: '', q3: 'How often?' }, { key: 'ip', deliverable: 'Interview Protocol', at: null });
  assert.deepEqual(q.blocks.find((b) => b.kind === 'list').items, ['Why?', 'How often?']);
  const g = showcaseSection(shape('impact-feasibility'), { idea: 'A fridge sensor', feasibility: 'high', impact: 'medium', because: 'Cheap parts.' }, { key: 'if', deliverable: 'Project Idea Form', at: null });
  const chips = g.blocks.find((b) => b.kind === 'chips');
  assert.equal(chips.items.length, 2);
  assert.match(chips.items[0], /high/);
});

test('the tile takes the newest picture and the first headline', () => {
  const a = { key: 'a', title: 'A', headline: 'First', hero: { path: 'a.png', alt: '' }, blocks: [], at: '2026-09-01T00:00:00Z', deliverable: 'A' };
  const b = { key: 'b', title: 'B', headline: null, hero: null, blocks: [{ kind: 'picture', picture: { path: 'b.png', alt: '' } }], at: '2026-09-05T00:00:00Z', deliverable: 'B' };
  assert.deepEqual(latestPicture([a, b]), { path: 'b.png', alt: '' });
  assert.equal(firstHeadline([b, a]), 'First');
});

test('the pages assemble from one loader, live, with the board and the as-of picker', () => {
  const gallery = fs.readFileSync('src/pages/app/program/[id]/showcase.astro', 'utf8');
  const page = fs.readFileSync('src/pages/app/program/[id]/showcase/[project].astro', 'utf8');
  const mine = fs.readFileSync('src/pages/app/project/[id]/showcase.astro', 'utf8');
  for (const src of [gallery, page]) assert.match(src, /loadShowcases\(supabase, template, id!/);
  assert.match(gallery, /data-live="gallery"/); assert.match(gallery, /class="gstrip"/); assert.match(gallery, /\?by=phase/);
  assert.match(page, /data-live="sections"/); assert.match(page, /<ShowcaseSections /); assert.match(page, /asof=/);
  assert.match(mine, /action === 'from_summary'/, 'Use my Research Graphic');
  const loader = fs.readFileSync('src/lib/showcase-load.ts', 'utf8');
  assert.match(loader, /\.in\('status', \['submitted', 'revising'\]\)/, 'drafts are not read');
});

console.log(`${passed} showcase assertions passed.`);
