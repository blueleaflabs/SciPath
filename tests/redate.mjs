/**
 * THE INTERVIEWS, RESHAPED AND REDATED WITHOUT A RESET (dev-152).
 *
 * Asserted: the Empathy Interviews deliverable keeps its id and its old
 * field ids (so an opened document and a pasted Drive link survive the
 * change), its new shape is three required boxes with seven more on
 * demand and a live tally, and it has no showcase block; the two dates
 * in the file are what was asked; the redate script is dry by default,
 * writes only a date and its note, and moves a participation's copy only
 * where it still carried the program's old date.
 *
 * Run: npm run test:redate
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadLibrary } from '../scripts/template-library.mjs';
import { shapeFrom, sectionsOf, resolveProgram, datesFor, validateShape, stepApplies, deliverablesFor } from '../src/lib/template-resolve.ts';
import { tallyWords } from '../src/lib/field-values.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const library = loadLibrary();

test('the deliverable keeps its id and names the new shape', () => {
  const text = fs.readFileSync('src/config/programs/irpd-mvhs-2027.yaml', 'utf8');
  assert.match(text, /id: interview_synthesis, name: Empathy Interviews, kind: text, owner: student, requirement: required, shape: empathy-interviews/);
});

test('three boxes required, seven more on demand, the old Drive fields kept and optional, no showcase', () => {
  const shape = shapeFrom(library, 'empathy-interviews');
  assert.ok(shape);
  assert.deepEqual(validateShape ? validateShape(shape) : [], []);
  const fields = sectionsOf(shape).flatMap((s) => s.fields);
  const boxes = fields.filter((f) => /^interview_\d+$/.test(f.id));
  assert.equal(boxes.length, 10);
  assert.deepEqual(boxes.filter((f) => f.required).map((f) => f.id), ['interview_1', 'interview_2', 'interview_3']);
  assert.deepEqual(boxes.filter((f) => f.extra).map((f) => f.id), ['interview_4', 'interview_5', 'interview_6', 'interview_7', 'interview_8', 'interview_9', 'interview_10']);
  for (const b of boxes) assert.equal(b.kind, 'long');
  const url = fields.find((f) => f.id === 'url');
  const note = fields.find((f) => f.id === 'note');
  assert.ok(url && url.kind === 'link' && !url.required, 'the Drive link keeps its id and is optional');
  assert.ok(note && note.kind === 'long' && !note.required, 'the note keeps its id and is optional');
  assert.equal(shape.showcase, undefined, 'interview notes never reach the class gallery');
  const tally = sectionsOf(shape).find((s) => s.tally)?.tally;
  assert.deepEqual(tally, { singular: 'interview', plural: 'interviews', min: 3, goal: 5 });
});

test('the tally reads as asked, on the server and in the page', () => {
  const t = { singular: 'interview', plural: 'interviews', min: 3, goal: 5 };
  assert.equal(tallyWords(0, t), '0 of 3 interviews written · 5 is the goal');
  assert.equal(tallyWords(2, t), '2 of 3 interviews written · 5 is the goal');
  assert.equal(tallyWords(5, t), '5 of 3 interviews written · the goal is met');
  const page = fs.readFileSync('src/pages/app/project/[id]/doc/[deliverable].astro', 'utf8');
  assert.match(page, /data-tally=\{section\.tally \? JSON\.stringify\(section\.tally\) : undefined\}/);
  assert.match(page, /const refreshTallies = /);
  assert.match(page, /refreshTallies\(\);\n\s+const asked/);
});

test('the two dates are September 21 and October 8, resolved as the seed resolves them', () => {
  const declared = resolveProgram('irpd-mvhs-2027', library);
  const resolved = resolveProgram('irpd-mvhs-2027', library, declared.processId ?? 'science');
  const dates = new Map(datesFor(resolved).map((d) => [d.step.id, d]));
  assert.equal(dates.get('interview_protocol_handout')?.date, '2026-09-21');
  assert.equal(dates.get('interview_protocol_handout')?.source, 'absolute');
  assert.equal(dates.get('interviews')?.date, '2026-10-08');
  assert.equal(dates.get('interviews')?.source, 'absolute');
});

test('the redate is dry by default, writes a date, its note and an audit row, and leaves a copy moved by hand', () => {
  const src = fs.readFileSync('scripts/program-redate.mjs', 'utf8');
  assert.match(src, /const apply = args\.includes\('--apply'\)/);
  assert.match(src, /if \(!apply\) continue;/);
  assert.match(src, /update\(\{ due_on: w\.date, required: w\.required/);
  assert.match(src, /update\(\{ due_on: w\.date \}\)\.eq\('program_milestone_id', m\.id\)/);
  assert.match(src, /q\.eq\('due_on', m\.due_on\)/);
  assert.doesNotMatch(src, /\.delete\(/);
  assert.equal((src.match(/\.insert\(/g) ?? []).length, 1, 'one insert: the audit row');
  assert.match(src, /from\('audit_log'\)\.insert\(\{[\s\S]*action: 'milestone\.redated'/);
  assert.match(src, /Moved from \$\{/);
  assert.doesNotMatch(src, /document_fields|documents'/);
});

test('the interviews step applies to every project, facts or none, and hands out its deliverable', () => {
  /* Pilot projects were made by the roster loader and carry no facts. A
     step that applied only when `humans` was set had its date on every
     plate and its Start button on none. */
  const declared = resolveProgram('irpd-mvhs-2027', library);
  const resolved = resolveProgram('irpd-mvhs-2027', library, declared.processId ?? 'science');
  const step = resolved.steps.find((st) => st.id === 'interviews');
  assert.ok(step && !step.applies_when, 'interviews must not depend on a fact');
  assert.equal(stepApplies(step, {}), true);
  assert.ok(deliverablesFor(resolved, step, {}).some((d) => d.id === 'interview_synthesis' && d.shape === 'empathy-interviews'));
  /* And so is every other student step of this class with a deliverable
     written here: a fact nobody sets must not hide a form. */
  for (const st of resolved.steps) {
    if (st.owner === 'staff' || !st.deliverables?.length) continue;
    assert.equal(stepApplies(st, {}), true, `${st.id} depends on a fact the pilot never sets`);
  }
});

console.log(`  ${passed} passed`);
