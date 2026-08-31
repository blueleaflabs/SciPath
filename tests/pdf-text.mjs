/**
 * Tests for pulling text out of a PDF.
 *
 * The extractor is rough by design, so the assertions are about the two
 * things that matter: it finds the words that are there, and it declines to
 * index the noise it produces when they are not. A scanned page with no text
 * layer yields stray characters, and putting those in a search index makes a
 * record appear for queries it has no bearing on, which is worse than being
 * absent.
 *
 * Run: npm run test:pdftext
 */

import assert from 'node:assert/strict';
import { textFromContentStream, tidy, worthIndexing } from '../src/lib/pdf-text.ts';

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

test('a literal string is read', () => {
  assert.match(textFromContentStream('BT (Thermal tolerance) Tj ET'), /Thermal tolerance/);
});

test('several show operators join in drawing order', () => {
  const out = textFromContentStream('BT (Intertidal) Tj (gastropods) Tj ET');
  assert.match(out, /Intertidal.*gastropods/s);
});

test('escapes inside a string survive', () => {
  assert.match(textFromContentStream('BT (a \\(parenthetical\\) aside) Tj ET'), /\(parenthetical\)/);
  assert.match(textFromContentStream('BT (line\\nbreak) Tj ET'), /line\s*break/);
});

test('an octal escape becomes its character', () => {
  assert.match(textFromContentStream('BT (caf\\351) Tj ET'), /caf/);
});

test('a hex string is read', () => {
  /* "Snails" in plain bytes. */
  assert.match(textFromContentStream('BT <536E61696C73> Tj ET'), /Snails/);
});

test('a line-positioning operator becomes a break rather than a join', () => {
  const out = textFromContentStream('BT (first) Tj 0 -12 Td (second) Tj ET');
  assert.doesNotMatch(out, /firstsecond/);
});

test('content outside BT and ET is ignored', () => {
  const out = textFromContentStream('/Image1 Do (not text) Tj BT (real) Tj ET');
  assert.match(out, /real/);
  assert.doesNotMatch(out, /not text/);
});

test('hyphenation across a line break is rejoined', () => {
  assert.match(tidy('gastro-\npods experience'), /gastropods experience/);
});

test('whitespace collapses without words running together', () => {
  assert.equal(tidy('one   two\n\n\nthree'), 'one two three');
});

test('a real paragraph is worth indexing', () => {
  const text = (
    'Intertidal gastropods experience a steep thermal gradient across a few ' +
    'vertical meters of shore and their upper thermal limits are known to ' +
    'shift with acclimation history which this study tested directly. '
  ).repeat(3);
  assert.equal(worthIndexing({ text, streams: 1, skipped: 0 }), true);
});

test('numbers and units do not make prose look like noise', () => {
  const text = (
    'Survival at 32 degrees fell from 88 percent at the high shore to 41 ' +
    'percent at the low shore with 240 animals across three bands. '
  ).repeat(4);
  assert.equal(worthIndexing({ text, streams: 1, skipped: 0 }), true);
});

test('a handful of characters from a scanned page is not', () => {
  assert.equal(worthIndexing({ text: 'a b c ~~ %', streams: 4, skipped: 4 }), false);
});

test('a long string of symbols is not, however long', () => {
  const noise = '\\/#$%^&*()_+{}|:<>?'.repeat(200);
  assert.equal(worthIndexing({ text: noise, streams: 2, skipped: 0 }), false);
});

/* ── What a database can actually hold ──────────────────────────────────── */

/**
 * The one that stopped a seed.
 *
 * Postgres cannot store a NUL in a `text` column, so a JSON body carrying
 * `\u0000` is refused with *unsupported Unicode escape sequence* — an error
 * about the encoding that says nothing about the file. Eight of the twenty
 * three papers in the back catalogue carry NULs and all twenty three carry
 * some C0 byte, because a subset font's glyph indices are small integers and
 * the extractor decodes streams as latin1.
 *
 * Removed in `tidy` rather than in the caller that hit it: `manuscript.astro`
 * stores this same text when a student uploads a paper, and would have met
 * the same refusal with less to go on.
 */
test('a NUL never survives, because a text column cannot hold one', () => {
  const withNul = 'Survival at thirty two degrees\u0000 fell to forty one percent.';
  const cleaned = tidy(withNul);

  assert.ok(!cleaned.includes('\u0000'), 'a NUL survived tidying');
  assert.equal(cleaned, 'Survival at thirty two degrees fell to forty one percent.');
});

test('the other C0 debris goes with it, and tab and newline stay', () => {
  const raw = 'one\u0001two\u0008three\u000Bfour\u001Ffive\u007Fsix';
  assert.equal(tidy(raw), 'onetwothreefourfivesix');

  /* Kept, because every rule after the strip is about them. */
  assert.equal(tidy('a\tb'), 'a b');
  assert.equal(tidy('a\nb'), 'a b');
});

/**
 * The strip must not rescue a failed extraction into the index.
 *
 * Taking control characters out raises the letter ratio `worthIndexing`
 * measures, so a font program full of binary could in principle cross the
 * threshold by being cleaned. Measured against the real archive rather than
 * reasoned about: the split before and after the change is the same seventeen
 * and six, and the six sit at 0.18 to 0.47 rather than near the 0.6 line.
 */
test('cleaning does not turn a failed extraction into an indexable one', () => {
  const binary = Array.from({ length: 400 }, (_, i) => String.fromCharCode(i % 32)).join('');
  const noise = tidy(binary + 'X++?+?+?'.repeat(60));

  assert.equal(worthIndexing({ text: noise, streams: 8, skipped: 0 }), false);
});

console.log(`${passed} pdf text assertions passed.`);
