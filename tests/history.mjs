/**
 * EVERY DRAFT, KEPT (2.8).
 *
 * `save_field` appends a row to `document_field_history` when a value
 * changes, the document page offers each box its earlier drafts with
 * "Use this", and the Worker's clock thins drafts older than thirty days
 * to the last before each submitted version. The database suite proves
 * the function; this holds the pieces around it in place.
 *
 * Run: npm run test:history
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');
const page = fs.readFileSync('src/pages/app/project/[id]/doc/[deliverable].astro', 'utf8');
const worker = fs.readFileSync('src/worker.js', 'utf8');

test('the table, the write and the prune are in the migration', () => {
  assert.match(sql, /create table public\.document_field_history \(/);
  assert.match(sql, /references public\.documents on delete cascade/, 'a draft has no life apart from its document');
  assert.match(sql, /if v_row\.value is not distinct from coalesce\(p_value, 'null'::jsonb\) then\s*return jsonb_build_object\('ok', true, 'version', v_row\.version, 'at', v_row\.updated_at, 'same', true\);/, 'the same text again is not a draft');
  assert.match(sql, /insert into public\.document_field_history \(org_id, document_id, field_id, value, version, saved_by, saved_at\)/);
  assert.match(sql, /create or replace function public\.prune_field_history\(p_days int default 30\)/);
  assert.match(sql, /grant execute on function public\.prune_field_history\(int\) to service_role;/, 'only the clock prunes');
});

test('the page offers each box its earlier drafts, and Use this puts one back', () => {
  assert.match(page, /from\('document_field_history'\)/);
  assert.match(page, /class="fdrafts"/);
  assert.match(page, /class="btn btn-sm btn-2 fdraft-use"/);
  assert.match(page, /\.closest<HTMLButtonElement>\('\.fdraft-use'\)/);
  assert.match(page, /writeValue\(wrap, value\);[\s\S]*?save\(wrap\);/, 'the draft is written into the box and saved as a new draft');
  assert.match(page, /f\.kind !== 'file' && f\.kind !== 'graphic'/, 'pictures are not drafts to put back');
});

test('the clock prunes', () => {
  assert.match(worker, /db\.rpc\('prune_field_history', \{ p_days: 30 \}\)/);
});

console.log(`${passed} history assertions passed.`);
