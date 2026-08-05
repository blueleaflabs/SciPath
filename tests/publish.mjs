/**
 * Tests for what gets committed.
 *
 * A slug and a published file are both permanent. The slug becomes a URL that
 * must never change, and the file has to satisfy the content collection
 * schema or the archive build fails after somebody has already committed it.
 *
 * Run: npm run test:publish
 */

import assert from 'node:assert/strict';
import { slugify, toMarkdown, repoPaths } from '../src/lib/publish.ts';

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

/* ── Slugs ──────────────────────────────────────────────────────────────── */

test('an ordinary title', () => {
  assert.equal(slugify('Thermal tolerance in intertidal snails'), 'thermal-tolerance-in-intertidal-snails');
});

test('punctuation collapses rather than doubling hyphens', () => {
  assert.equal(slugify('QViSTA: a quantum vision transformer'), 'qvista-a-quantum-vision-transformer');
  assert.equal(slugify('Nitrogen  --  fixing?'), 'nitrogen-fixing');
});

test('accents are transliterated, not dropped', () => {
  assert.equal(slugify('Étude of Ångström films'), 'etude-of-angstrom-films');
  assert.equal(slugify('Ferreira Peña'), 'ferreira-pena');
});

test('a very long title is cut on a word boundary', () => {
  const long =
    'A comprehensive investigation into the thermal tolerance of intertidal gastropods across a vertical shore gradient in northern California';
  const slug = slugify(long);
  assert.ok(slug.length <= 72, `${slug.length} characters`);
  assert.ok(!slug.endsWith('-'));
  /* Cut between words, so the last segment is a whole one. */
  assert.ok(long.toLowerCase().replace(/[^a-z0-9]+/g, '-').startsWith(slug));
});

test('a slug never starts or ends with a hyphen', () => {
  assert.equal(slugify('  ...Leading and trailing...  '), 'leading-and-trailing');
});

test('the same title gives the same slug every time', () => {
  const t = 'Low-cost turbidity sensing for creek monitoring';
  assert.equal(slugify(t), slugify(t));
});

/* ── The file ───────────────────────────────────────────────────────────── */

const record = {
  id: 'MVRJ-2027-0003',
  record_kind: 'article',
  slug: 'thermal-tolerance-in-intertidal-snails',
  year: 2027,
  title: 'Thermal tolerance in intertidal snails',
  abstract: 'Intertidal gastropods experience a steep thermal gradient.',
  keywords: ['thermal tolerance', 'intertidal'],
  discipline: 'biology-biomedicine',
  contributions: 'B. Adeyemi did everything.',
  published_on: '2027-05-14',
  date_precision: 'day',
  source: 'workbench',
  reviewed: true,
  body_format: 'full-text',
  external_url: null,
  pdf_path: null,
  license: 'CC BY 4.0',
};

const base = {
  record,
  authors: [{ display_name: 'B. Adeyemi', grad_year: 2028, affiliation_verified: true }],
  sections: [{ key: 'methods', label: 'Methods', body: 'Animals were collected.' }],
  figures: [],
  references: ['Somero, G. N. (2010).'],
  entries: [],
};

const frontmatter = (md) => md.split('---')[1];

test('the file opens and closes its frontmatter', () => {
  const md = toMarkdown(base);
  assert.ok(md.startsWith('---\n'));
  assert.equal((md.match(/^---$/gm) ?? []).length, 2);
});

test('every field the schema requires is present', () => {
  const fm = frontmatter(toMarkdown(base));
  for (const key of ['recordId', 'slug', 'title', 'authors', 'discipline', 'publishedOn', 'license', 'status']) {
    assert.match(fm, new RegExp(`^${key}:`, 'm'), key);
  }
});

test('a title with a colon is quoted, because YAML would read it as a mapping', () => {
  const md = toMarkdown({ ...base, record: { ...record, title: 'QViSTA: a transformer' } });
  assert.match(md, /title: "QViSTA: a transformer"/);
});

test('a byline-only author gets a null slug and therefore no author page', () => {
  const md = toMarkdown({
    ...base,
    authors: [{ display_name: 'An Outsider', byline_only: true }],
  });
  assert.match(md, /authorSlug: null/);
});

test('an absent abstract is empty rather than invented', () => {
  const md = toMarkdown({ ...base, record: { ...record, abstract: null } });
  assert.match(md, /^abstract: ''$/m);
});

test('a PDF record points at the repo path, never at storage', () => {
  const md = toMarkdown({
    ...base,
    record: { ...record, body_format: 'pdf-only', pdf_path: 'manuscripts/x/paper/y.pdf' },
  });
  assert.match(md, /^pdf: \/articles\/2027\/thermal-tolerance-in-intertidal-snails\/thermal-tolerance-in-intertidal-snails\.pdf$/m);
  assert.doesNotMatch(md, /manuscripts\/x/);
});

test('a PDF record has no body', () => {
  const md = toMarkdown({
    ...base,
    record: { ...record, body_format: 'pdf-only', pdf_path: 'x.pdf' },
  });
  assert.doesNotMatch(md, /## Methods/);
});

test('a full-text record writes its sections as level two headings', () => {
  const md = toMarkdown(base);
  assert.match(md, /^## Methods$/m);
  assert.match(md, /Animals were collected\./);
});

test('an empty section is skipped rather than left as a bare heading', () => {
  const md = toMarkdown({
    ...base,
    sections: [
      { key: 'methods', label: 'Methods', body: 'Something.' },
      { key: 'results', label: 'Results', body: '   ' },
    ],
  });
  assert.doesNotMatch(md, /## Results/);
});

test('figures carry caption and alt and point at the repo', () => {
  const md = toMarkdown({
    ...base,
    figures: [{ number: 1, caption: 'Survival by shore height.', alt: 'A bar chart.', ext: 'png' }],
  });
  assert.match(md, /src: \/articles\/2027\/[^/]+\/fig-1\.png/);
  assert.match(md, /alt: A bar chart\./);
});

test('a competition record is written when there is one', () => {
  const md = toMarkdown({
    ...base,
    entries: [{
      program: 'SCVSEFA Science Fair', season: '2027', category: 'Animal Sciences',
      entry_code: 'ANIM031', placement: 'First Award',
      awards: ['Society for In Vitro Biology Award'], advanced_to: 'CSEF',
    }],
  });
  assert.match(md, /entryCode: ANIM031/);
  assert.match(md, /advancedTo: CSEF/);
});

test('reviewed is false for a record that did not go through review here', () => {
  const md = toMarkdown({ ...base, record: { ...record, reviewed: false, source: 'migrated' } });
  assert.match(md, /^reviewed: false$/m);
  assert.match(md, /^source: migrated$/m);
});

test('a project entry lands under projects, an article under articles', () => {
  assert.match(repoPaths({ record_kind: 'project', year: 2027, slug: 's' }).markdown, /content\/projects\//);
  assert.match(repoPaths({ record_kind: 'article', year: 2027, slug: 's' }).markdown, /content\/articles\//);
});

test('asset paths sit beside the record they belong to', () => {
  const p = repoPaths({ record_kind: 'article', year: 2027, slug: 'snails' });
  assert.equal(p.pdf, 'public/articles/2027/snails/snails.pdf');
  assert.equal(p.figure(2, 'jpg'), 'public/articles/2027/snails/fig-2.jpg');
});

console.log(`${passed} publish assertions passed.`);
