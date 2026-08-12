/**
 * Every policy on a project-owned table goes through one function.
 *
 * There are forty-eight of them, and nearly all said the same thing twice:
 * authors of this project, or staff of this school. Once staff belong to a
 * program rather than to the school, that predicate becomes a four-table
 * join, and forty-eight hand-written copies of a four-table join is how an
 * access model becomes slow and quietly wrong.
 *
 * **The risk is not the volume. It is that a mistake is invisible** until
 * somebody sees a project they should not, which is the same failure class as
 * the shared search index and the `records/undefined/` prefix, both of which
 * shipped.
 *
 * So: `app.can_see_project()` and `app.can_edit_project()` are the predicate,
 * and this fails if any policy reaches around them.
 *
 * Run: npm run test:visibility
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

const dir = 'supabase/migrations';
const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

/** Tables whose rows belong to a project, directly or through one hop. */
const PROJECT_OWNED = new Set([
  'projects', 'project_authors', 'project_links', 'project_images',
  'project_sponsors', 'field_notes', 'note_media', 'entries',
  'entry_milestones', 'deliverables', 'manuscripts', 'manuscript_sections',
  'manuscript_figures', 'manuscript_references', 'submissions', 'state_events',
]);

/**
 * Reviews are deliberately outside that set.
 *
 * Reviewer names and comments written to the editor were given on a promise
 * of confidentiality that does not expire when a season does, and they must
 * not travel with project visibility. A fair officer who gains historical
 * access to a project does not thereby gain the reviewer's identity. 6.6.
 */
const CONFIDENTIAL = new Set(['reviews', 'review_findings']);

/** Every policy body in the migration, with its table and operation. */
function policies() {
  const out = [];
  const pattern =
    /create policy (\w+) on public\.(\w+)\s*\n\s*for (\w+)[^\n]*\n((?:\s*(?:using|with check)\s*\([\s\S]*?\);))/g;

  for (const m of sql.matchAll(pattern)) {
    out.push({ name: m[1], table: m[2], op: m[3], body: m[4] });
  }
  return out;
}

const all = policies();

test('the migration parses into policies at all', () => {
  assert.ok(all.length > 50, `only found ${all.length}`);
});

test('every read of a project-owned table calls can_see_project', () => {
  const wrong = all
    .filter((p) => PROJECT_OWNED.has(p.table) && p.op === 'select')
    .filter((p) => !/can_see_project/.test(p.body))
    .map((p) => `${p.name} on ${p.table}`);

  assert.deepEqual(wrong, [], 'these reimplement the visibility rule');
});

test('every write to a project-owned table calls can_edit_project', () => {
  const wrong = all
    .filter((p) => PROJECT_OWNED.has(p.table) && ['update', 'delete'].includes(p.op))
    .filter((p) => !/can_edit_project/.test(p.body))
    .map((p) => `${p.name} on ${p.table}`);

  assert.deepEqual(wrong, [], 'these reimplement the edit rule');
});

test('no project policy hand-rolls the author join', () => {
  /* The signature of a copy is a subquery over project_authors. A policy ON
     project_authors naming its own column is not that, which is why the test
     looks for the select rather than for the word. */
  const wrong = all
    .filter((p) => PROJECT_OWNED.has(p.table))
    .filter((p) => p.op !== 'insert')
    .filter((p) => /from\s+public\.project_authors/.test(p.body))
    .map((p) => `${p.name} on ${p.table}`);

  assert.deepEqual(wrong, [], 'a copy of the predicate will drift from the original');
});

test('no project policy reads the old school-wide staff check', () => {
  /* `is_staff()` is school-wide, which is exactly what stopped being true
     when a school gained a second program. */
  const wrong = all
    .filter((p) => PROJECT_OWNED.has(p.table) && p.op === 'select')
    .filter((p) => /app\.is_staff\(\)/.test(p.body))
    .map((p) => `${p.name} on ${p.table}`);

  assert.deepEqual(wrong, [], 'school-wide staff visibility is the thing being removed');
});

test('an insert may not call can_edit_project on its own new row', () => {
  /* On INSERT the row does not exist, so nothing about it can be looked up.
     A policy that tries produces a table nobody can write to, which is a
     failure that only appears the first time somebody creates something. */
  const suspect = all
    .filter((p) => p.op === 'insert' && p.table === 'projects')
    .filter((p) => /can_edit_project\(\s*projects\.id/.test(p.body))
    .map((p) => p.name);

  assert.deepEqual(suspect, [], 'this makes creating a project impossible');
});

test('reviewer confidentiality does not travel with project visibility', () => {
  const leaking = all
    .filter((p) => CONFIDENTIAL.has(p.table))
    .filter((p) => /can_see_project/.test(p.body))
    .map((p) => `${p.name} on ${p.table}`);

  assert.deepEqual(
    leaking,
    [],
    'a review must not become visible because somebody can see the project'
  );
});

test('the visibility function exists and is security definer', () => {
  const fn = sql.slice(sql.indexOf('function app.can_see_project'));
  assert.match(fn.slice(0, 400), /security definer/);
  assert.match(fn.slice(0, 400), /set search_path = ''/);
});

test('it matches on family rather than on the exact program', () => {
  /* This year's officers see the club's history; IRPD's elders do not see the
     fair's. Matching the edition would lose the first. */
  const fn = sql.slice(sql.indexOf('function app.can_see_project'), sql.indexOf('grant execute on function app.can_see_project'));
  assert.match(fn, /family/);
  assert.match(fn, /theirs\.current/, 'a lapsed edition must grant nothing');
});

test('an author sees their own project regardless of any role', () => {
  const fn = sql.slice(sql.indexOf('function app.can_see_project'), sql.indexOf('grant execute on function app.can_see_project'));
  assert.match(fn, /project_authors/, 'authorship is independent of every role');
});

test('the privacy setting cannot hide a project from the people running it', () => {
  /* A student who could conceal a missing approval from the person who signs
     it is exactly the failure the experimentation gate exists to prevent. */
  const fn = sql.slice(sql.indexOf('function app.can_see_project'), sql.indexOf('grant execute on function app.can_see_project'));
  assert.match(fn, /is_private/);
  assert.match(fn, /theirs\.id = mine\.id/, 'the current program keeps access');
});

console.log(`${passed} visibility assertions passed. ${all.length} policies read.`);
