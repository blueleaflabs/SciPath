/**
 * UPLOAD IT INSTEAD (dev-161).
 *
 * Asserted: every shape carries the uploads section first, once, with
 * five file boxes (four on demand) taking an image or a PDF, unless it
 * opts out; a shape that names `upload_1` itself is left alone; one
 * upload makes a document complete whatever the required fields say,
 * and typing as well changes nothing; the page marks the stand-in
 * fields, says so in the strip, mirrors the rule in the browser, shrinks
 * a large photo before it goes up, and gives a teacher a way to take a
 * file off the page; the upload route caps files per document and still
 * refuses an SVG; the media route serves a removed file to nobody; the
 * report counts uploaded against typed per deliverable and never a path.
 *
 * Run: npm run test:standin
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadLibrary } from '../scripts/template-library.mjs';
import { shapeFrom, sectionsOf, askedOf, validateShape, uploadSection, UPLOAD_FIELD_IDS } from '../src/lib/template-resolve.ts';
import { progressOf } from '../src/lib/progress.ts';
import { detect } from '../src/lib/filetype.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const library = loadLibrary();
const ids = [...library.shapes.keys()];

test('every shape carries the uploads section first, once, and still validates', () => {
  assert.ok(ids.length >= 18);
  /* The one shape on file that opts out (dev-165): `photos`, whose own
     boxes are the deliverable. Held to its own rule in tests/redate.mjs. */
  assert.deepEqual(ids.filter((id) => shapeFrom(library, id).uploads === false), ['photos']);
  for (const id of ids) {
    const shape = shapeFrom(library, id);
    if (shape.uploads === false) continue;
    const sections = sectionsOf(shape);
    assert.equal(sections[0].id, 'uploads', `${id}: uploads first`);
    assert.equal(sections[0].stands_in, true);
    assert.equal(sections.filter((s) => s.id === 'uploads').length, 1, `${id}: once`);
    const files = sections[0].fields.filter((f) => f.kind === 'file');
    assert.deepEqual(files.map((f) => f.id), [...UPLOAD_FIELD_IDS]);
    for (const f of files) assert.equal(f.accept, 'any');
    assert.deepEqual(files.filter((f) => f.extra).map((f) => f.id), ['upload_2', 'upload_3', 'upload_4', 'upload_5']);
    assert.ok(files.every((f) => !f.required), 'an upload is never required');
    assert.deepEqual(validateShape(shape), [], `${id} validates with the section`);
    assert.ok(!(shape.sections ?? []).some((s) => s.fields?.some((f) => f.id === 'upload_1')), `${id}: the ids are reserved`);
  }
});

test('a shape may opt out, and one that names upload_1 itself is left alone', () => {
  assert.equal(sectionsOf({ id: 'x', sections: [{ id: 'a', fields: [{ id: 'q', kind: 'long', required: true }] }], uploads: false })[0].id, 'a');
  const own = sectionsOf({ id: 'y', sections: [{ id: 'mine', fields: [{ id: 'upload_1', kind: 'file' }] }] });
  assert.equal(own.length, 1); assert.equal(own[0].id, 'mine');
  /* The older forms get it too. */
  assert.equal(sectionsOf({ id: 'p', parts: [{ id: 'a', name: 'A' }] })[0].id, 'uploads');
  assert.equal(sectionsOf({ id: 'q', answers: ['One?'] })[0].id, 'uploads');
});

test('one upload completes a document; typing as well changes nothing; a removed upload does not count', () => {
  const shape = shapeFrom(library, 'research-question');
  const required = askedOf(shape).filter((f) => f.required);
  assert.ok(required.length >= 2, 'the research question asks for typed fields');
  const empty = progressOf(shape, {});
  assert.equal(empty.missing.length, required.length); assert.equal(empty.uploaded, 0);
  const photo = progressOf(shape, { upload_1: { path: 'projects/p/documents/d/x.jpg', name: 'x.jpg' } });
  assert.deepEqual(photo.missing, []); assert.equal(photo.uploaded, 1);
  assert.equal(photo.filled, 0, 'the typed count is still the typed count');
  const both = progressOf(shape, { upload_2: { path: 'a.pdf' }, [required[0].id]: 'Some words' });
  assert.deepEqual(both.missing, []); assert.equal(both.filled, 1);
  const blanked = progressOf(shape, { upload_1: null });
  assert.equal(blanked.missing.length, required.length);
  /* The note in the section is not an upload. */
  assert.equal(uploadSection().fields.filter((f) => f.kind !== 'note').length, 5);
});

test("the page: stand-in marker, the strip, the browser mirror, the shrink, the teacher's removal", () => {
  const page = fs.readFileSync('src/pages/app/project/[id]/doc/[deliverable].astro', 'utf8');
  assert.match(page, /data-stands-in=\{section\.stands_in && f\.kind !== 'note' \? '1' : '0'\}/);
  assert.match(page, /id="ds-upl" hidden=\{!progress\.uploaded\}/);
  assert.match(page, /const standsIn = \[\.\.\.form\.querySelectorAll<HTMLElement>\('\.field\[data-stands-in="1"\]'\)\]\.some\(filledHere\)/);
  assert.match(page, /const missing = standsIn \? \[\] : asked\.filter/);
  /* Two pickers, never one mixed accept list (dev-163: iOS opened it black). */
  assert.match(page, /<input type="file" class="ffile-in" accept="image\/\*" data-field=\{f\.id\} \/>/);
  assert.match(page, /\{f\.accept !== 'image' && <label class="fwrap fpdf">[\s\S]*accept="application\/pdf,\.pdf" data-field=\{f\.id\}/);
  assert.doesNotMatch(page, /accept="image\/\*,application\/pdf"|'image\/\*,application\/pdf'/);
  assert.match(page, /const shrink = async \(file: File\)/);
  assert.match(page, /2400 \/ longest/);
  assert.match(page, /canvas\.toBlob\(r, 'image\/jpeg', 0\.85\)/);
  assert.match(page, /const file = await shrink\(raw\)/);
  /* The upload handler refreshes the progress once the field is saved, so Submit lights up without a reload. */
  const handler = page.slice(page.indexOf("form.querySelectorAll<HTMLInputElement>('.ffile-in')"), page.indexOf('/* Generate: the picture is drawn'));
  assert.match(handler, /wrap\.dataset\.have = '1';/);
  assert.match(handler, /have\.appendChild\(a\);[\s\S]*refreshProgress\(\);/);
  assert.match(page, /loading="lazy"/);
  assert.match(page, /action === 'remove_media' && docRow/);
  assert.match(page, /if \(!me\.isAdvisor\) error = 'Only a teacher removes a file\.'/);
  assert.match(page, /removeMedia\(adminClient\(/);
  assert.match(page, /me\.isAdvisor && f\.kind === 'file' && \(/);
  assert.match(page, /name="action" value="remove_media"/);
  assert.match(page, /removedOn\[fid\] = removed\.get\(v\.path\)!\.at; values\[fid\] = null;/);
  const print = fs.readFileSync('src/pages/app/project/[id]/doc/[deliverable]/print.astro', 'utf8');
  assert.match(print, /removedMedia\(supabase/);
});

test('the routes: a ceiling per document, an SVG still refused, a removed file served to nobody', () => {
  const upload = fs.readFileSync('src/pages/app/api/upload.ts', 'utf8');
  assert.match(upload, /export const MAX_FILES_PER_DOCUMENT = 100;/);
  assert.match(upload, /if \(\(already \?\? 0\) >= MAX_FILES_PER_DOCUMENT\) return json\(\{ ok: false, error: 'this document has all the files it can hold' \}, 413\)/);
  assert.match(upload, /const ALLOWED = \['image\/', 'application\/pdf'\];/);
  assert.equal(detect(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null, 'an SVG is not a file we show');
  assert.equal(detect(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04])), null, 'an executable is not a file we show');
  /* The page may use the camera for its own file boxes (dev-164); iOS opened a black sheet with camera=(). */
  const mw = fs.readFileSync('src/middleware.ts', 'utf8');
  assert.match(mw, /'Permissions-Policy': 'camera=\(self\), microphone=\(\), geolocation=\(\), payment=\(\), usb=\(\)'/);
  const media = fs.readFileSync('src/pages/app/media/[...path].ts', 'utf8');
  assert.match(media, /const asDocumentMedia = references\[5\]\?\.data/);
  assert.match(media, /supabase\.from\('document_media'\)\.select\('id'\)\.eq\('storage_path', path\)\.maybeSingle\(\),\n  \]\);/, 'document_media is the sixth reference');
  assert.match(media, /await isRemoved\(runtime, asDocumentMedia\.id\)\)\) return new Response\('Not found', \{ status: 404 \}\)/);
  const lib = fs.readFileSync('src/lib/media-removal.ts', 'utf8');
  assert.match(lib, /export const MEDIA_REMOVED = 'media\.removed';/);
  assert.match(lib, /media\.document_id !== a\.documentId \|\| media\.org_id !== a\.orgId/);
  assert.doesNotMatch(lib, /\.delete\(|blob|remove\(/, 'nothing is deleted from storage');
});

test('the report counts uploaded against typed per deliverable and carries no path', () => {
  const src = fs.readFileSync('scripts/pilot-report.mjs', 'utf8');
  assert.match(src, /uploads: \{ total: uploadsAll, by_deliverable: uploadsBy \}/);
  for (const k of ['with_upload', 'with_typing', 'upload_only', 'typed_only']) assert.ok(src.includes(k), k);
  assert.doesNotMatch(src, /path: f\.value|storage_path/);
});

console.log(`  ${passed} passed`);
