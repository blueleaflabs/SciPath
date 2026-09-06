/**
 * A DRIVE LINK RENDERS, AND NOTHING ELSE DOES.
 *
 * The preview address is built only for the Google hosts and shapes we
 * know; any other address stays a link, so a pasted `javascript:` or a
 * look-alike host never becomes an iframe source.
 *
 *   node --experimental-strip-types tests/drive.mjs
 */

import assert from 'node:assert/strict';
import { drivePreviewUrl, driveKind } from '../src/lib/gdrive.ts';

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

test('a Google Doc edit link becomes its preview', () => {
  assert.equal(drivePreviewUrl('https://docs.google.com/document/d/1AbC_d-9/edit?usp=sharing'), 'https://docs.google.com/document/d/1AbC_d-9/preview');
  assert.equal(driveKind('https://docs.google.com/document/d/1AbC/edit'), 'Google Doc');
});

test('sheets, slides, forms and drive files too', () => {
  assert.match(drivePreviewUrl('https://docs.google.com/spreadsheets/d/xyz/edit#gid=0'), /spreadsheets\/d\/xyz\/preview$/);
  assert.match(drivePreviewUrl('https://docs.google.com/presentation/d/xyz/edit'), /presentation\/d\/xyz\/preview$/);
  assert.match(drivePreviewUrl('https://drive.google.com/file/d/xyz/view?usp=drive_link'), /file\/d\/xyz\/preview$/);
  assert.match(drivePreviewUrl('https://drive.google.com/open?id=xyz'), /file\/d\/xyz\/preview$/);
});

test('anything else stays a link', () => {
  assert.equal(drivePreviewUrl('https://example.com/doc'), null);
  assert.equal(drivePreviewUrl('http://docs.google.com/document/d/x/edit'), null);
  assert.equal(drivePreviewUrl('https://docs.google.com.evil.example/document/d/x/edit'), null);
  assert.equal(drivePreviewUrl('javascript:alert(1)'), null);
  assert.equal(drivePreviewUrl(''), null);
  assert.equal(drivePreviewUrl(null), null);
});

if (process.exitCode) console.error(`\n${passed} passed, with failures.`);
else console.log(`${passed} drive link assertions passed.`);
