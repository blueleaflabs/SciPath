/**
 * WHAT AN UPLOAD IS ALLOWED TO BE.
 *
 * Upload handlers checked the size and trusted `file.type` and the name, both
 * of which are whatever the person posting chose to put in the multipart
 * body. An HTML page named `figure.png` and declared `image/png` was stored
 * as an image and served from our origin.
 *
 * These are the inputs that mattered: a renamed document, a polyglot that
 * begins correctly and continues as markup, and an SVG — which was not a gap
 * but a permission, listed in the served MIME map under a comment saying that
 * list was the allowlist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detect, looksLikeMarkup } from '../src/lib/filetype.ts';

let passed = 0;
const check = (name, fn) => test(name, () => { fn(); passed += 1; });

const bytes = (...parts) => {
  const out = [];
  for (const p of parts) {
    if (typeof p === 'string') out.push(...[...p].map((c) => c.charCodeAt(0)));
    else out.push(...p);
  }
  return new Uint8Array(out);
};

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = 'GIF89a';
const PDF = '%PDF-1.7';

check('a real image is recognized by its bytes', () => {
  assert.equal(detect(bytes(PNG)).mime, 'image/png');
  assert.equal(detect(bytes(JPEG)).mime, 'image/jpeg');
  assert.equal(detect(bytes(GIF)).mime, 'image/gif');
  assert.equal(detect(bytes('RIFF', [0, 0, 0, 0], 'WEBP')).mime, 'image/webp');
  assert.equal(detect(bytes(PDF)).mime, 'application/pdf');
});

check('the extension comes from the bytes, not the name', () => {
  /* The whole point. A caller passes this to the path builder, so a file
     named `.png` holding a JPEG is stored as `.jpg` and served as one. */
  assert.equal(detect(bytes(JPEG)).ext, 'jpg');
  assert.equal(detect(bytes(PDF)).ext, 'pdf');
});

const refused = [
  ['an SVG', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ['an HTML page', '<!doctype html><html><body><script>alert(1)</script>'],
  ['a bare script', '<script>alert(1)</script>'],
  ['an XML document', '<?xml version="1.0"?><root/>'],
  ['plain text', 'just some text'],
  ['an empty file', ''],
];

for (const [what, body] of refused) {
  check(`${what} is refused whatever it is called`, () => {
    const head = bytes(body);
    assert.ok(
      looksLikeMarkup(head) || detect(head) === null,
      `${what} was accepted`
    );
  });
}

check('a polyglot that begins as a GIF is still refused', () => {
  /* `GIF89a` followed by a script is a real technique: it satisfies the
     signature and a browser sniffing the first kilobyte finds the tag.
     Signature matching answers "does it begin correctly", which is not the
     same question as "is it only this". */
  const polyglot = bytes(GIF, '<script>alert(1)</script>');

  assert.notEqual(detect(polyglot), null, 'it does satisfy the signature');
  assert.ok(looksLikeMarkup(polyglot), 'and has to be refused anyway');
});

check('a PDF with HTML appended in the first kilobyte is refused', () => {
  const polyglot = bytes(PDF, ' ', '<html><script>alert(1)</script></html>');
  assert.ok(looksLikeMarkup(polyglot));
});

check('svg is not in the served MIME map', () => {
  /* It was, under a comment saying the map is the allowlist as well as the
     lookup — so it was permitted deliberately rather than overlooked. */
  const files = readFileSync('src/lib/record-files.ts', 'utf8');
  const map = files.slice(files.indexOf('const MIME'), files.indexOf('};', files.indexOf('const MIME')));

  assert.doesNotMatch(map, /svg/, 'an SVG served same-origin is a script that runs');
});

import { readFileSync } from 'node:fs';

process.on('exit', () => {
  console.log(`\n${passed} upload assertions passed. ${refused.length} disguised files.`);
});
