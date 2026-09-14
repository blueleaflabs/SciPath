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
import { redate } from '../scripts/program-redate.mjs';
import { milestoneRow } from '../scripts/milestone-rows.mjs';
import { fakeDb, id } from './fake-db.mjs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}
async function atest(name, fn) {
  try { await fn(); passed += 1; }
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

test('the dates are September 21, October 8 and September 14, resolved as the seed resolves them', () => {
  const declared = resolveProgram('irpd-mvhs-2027', library);
  const resolved = resolveProgram('irpd-mvhs-2027', library, declared.processId ?? 'science');
  const dates = new Map(datesFor(resolved).map((d) => [d.step.id, d]));
  assert.equal(dates.get('interview_protocol_handout')?.date, '2026-09-21');
  assert.equal(dates.get('interview_protocol_handout')?.source, 'absolute');
  assert.equal(dates.get('interviews')?.date, '2026-10-08');
  assert.equal(dates.get('interviews')?.source, 'absolute');
  /* dev-159: the research question to the 14th, from the 10th. */
  assert.equal(dates.get('research_question')?.date, '2026-09-14');
  assert.equal(dates.get('research_question')?.source, 'absolute');
});

test('the redate is dry by default, writes the date, the shape and an audit row, adds a missing step with its copies, and never deletes', () => {
  const src = fs.readFileSync('scripts/program-redate.mjs', 'utf8');
  assert.match(src, /const apply = args\.includes\('--apply'\)/);
  assert.equal((src.match(/if \(!apply\) continue;/g) ?? []).length, 2, 'dry on both paths');
  assert.ok(src.includes("import { milestoneRow, entryCopy, noteFor } from './milestone-rows.mjs'"), 'the one row builder the seed uses');
  assert.match(src, /const SHAPE = \['name', 'required', 'requires_step', 'requires_steps', 'sort_order', 'phase', 'owner', 'feedback_on', 'kind'\]/);
  assert.match(src, /update\(\{ due_on: w\.row\.due_on \}\)\.eq\('program_milestone_id', m\.id\)/);
  assert.match(src, /q\.eq\('due_on', m\.due_on\)/, 'a copy moved by hand is left');
  assert.doesNotMatch(src, /\.delete\(/);
  assert.match(src, /action: 'milestone\.redated'/);
  assert.match(src, /action: 'milestone\.added'/);
  assert.match(src, /from\('program_milestones'\)\.insert\(row\)/);
  assert.match(src, /from\('entry_milestones'\)\.insert\(toCopy\)/);
  assert.match(src, /in the database and not in the file; left as it is/);
  assert.match(src, /Moved from \$\{/);
  assert.doesNotMatch(src, /document_fields|documents'/);
  const seed = fs.readFileSync('scripts/seed-programs.mjs', 'utf8');
  assert.ok(seed.includes("import { milestoneRow } from './milestone-rows.mjs'"));
  assert.doesNotMatch(seed, /function kindOf|function deliverableRef/, 'one builder, in one file');
  const report = fs.readFileSync('scripts/pilot-report.mjs', 'utf8');
  assert.match(report, /\.in\('action', \['milestone\.redated', 'milestone\.added'\]\)/);
});

test('the work breakdown structure (dev-160): September 15, open, three promises, three tasks', () => {
  const text = fs.readFileSync('src/config/programs/irpd-mvhs-2027.yaml', 'utf8');
  assert.match(text, /id: wbs, name: Work Breakdown Structure, kind: text, owner: student, requirement: required, shape: wbs \}/);
  for (const n of [1, 2, 3]) assert.match(text, new RegExp(`id: wbs_deliverable_${n}, name: WBS Deliverable ${n}, kind: text, owner: student, requirement: required, shape: wbs-deliverable`));
  const declared = resolveProgram('irpd-mvhs-2027', library);
  const resolved = resolveProgram('irpd-mvhs-2027', library, declared.processId ?? 'science');
  const dates = new Map(datesFor(resolved).map((d) => [d.step.id, d]));
  assert.equal(dates.get('wbs')?.date, '2026-09-15');
  assert.deepEqual(dates.get('wbs')?.step.requires ?? [], [], 'the breakdown waits on nothing');
  assert.equal(dates.get('wbs_deliverable_1')?.date, '2026-10-15');
  assert.equal(dates.get('wbs_deliverable_2')?.date, '2026-11-15');
  assert.equal(dates.get('wbs_deliverable_3')?.date, '2026-12-15');
  for (const n of [1, 2, 3]) assert.deepEqual(dates.get(`wbs_deliverable_${n}`)?.step.requires, ['wbs'], 'each promise waits on the breakdown');
  const shape = shapeFrom(library, 'wbs');
  assert.deepEqual(validateShape ? validateShape(shape) : [], []);
  const fields = sectionsOf(shape).flatMap((s) => s.fields);
  assert.deepEqual(fields.filter((f) => f.required).map((f) => f.id), ['deliverable_1', 'deliverable_2', 'deliverable_3']);
  assert.ok(fields.some((f) => f.id === 'url' && f.kind === 'link' && !f.required), 'the Drive link it was keeps its id');
  assert.ok(fields.some((f) => f.id === 'note' && !f.required));
  const child = shapeFrom(library, 'wbs-deliverable');
  assert.deepEqual(validateShape ? validateShape(child) : [], []);
  assert.deepEqual(sectionsOf(child).flatMap((s) => s.fields).filter((f) => f.required).map((f) => f.id), ['summary']);
  /* No student step waits on a staff step (dev-160): an Elder behind on
     feedback holds nobody. Every gate names a student's own step. */
  const staff = new Set(resolved.steps.filter((st) => st.owner === 'staff').map((st) => st.id));
  for (const st of resolved.steps) {
    if (st.owner === 'staff') continue;
    for (const req of st.requires ?? []) assert.ok(!staff.has(req), `${st.id} waits on the Elder's ${req}`);
  }
  assert.deepEqual(dates.get('journey_map')?.step.requires, ['journey_map_draft']);
  /* And the Elder has somewhere to give the feedback on the first draft
     (dev-160): a staff field on the journey map, which is what puts "Give
     the feedback" on the page and completes the Elder's task. */
  const jm = shapeFrom(library, 'journey-map');
  const jmFields = sectionsOf(jm).flatMap((s) => s.fields);
  assert.ok(jmFields.some((f) => f.id === 'elder_feedback' && f.owner === 'staff' && f.kind === 'long'));
  assert.equal(dates.get('elder_journey_map_feedback')?.step.feedback_on, 'journey_map');
  assert.deepEqual(dates.get('elder_journey_map_feedback')?.step.requires, ['journey_map_draft']);
  /* The project plan still waits on the breakdown; the breakdown comes first in its phase. */
  assert.ok(dates.get('project_plan')?.step.requires?.includes('wbs'));
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


/* ── The redate, run for real over a fake database ───────────────────── */

/* A class as the seed left it on a previous version of the file: the
   breakdown still on the 30th and gated, the three promises absent, and
   one student whose copy of the breakdown a teacher moved by hand. */
function seededClass() {
  const orgId = id(), programId = id();
  const declared = resolveProgram('irpd-mvhs-2027', library);
  const resolved = resolveProgram('irpd-mvhs-2027', library, declared.processId ?? 'science');
  const dated = datesFor(resolved).filter((d) => d.date && d.step.id);
  const program_milestones = dated
    .filter((d) => !/^wbs_deliverable_/.test(d.step.id))
    .map((d, i) => ({ id: id(), ...milestoneRow(d, i, { programId, orgId }) }));
  const wbs = program_milestones.find((m) => m.step_id === 'wbs');
  wbs.due_on = '2026-09-30'; wbs.requires_steps = ['journey_map']; wbs.sort_order = 500; wbs.deliverable_ref = 'wbs'; wbs.notes = null;
  const participations = [1, 2, 3].map(() => ({ id: id(), org_id: orgId, program_id: programId }));
  const entry_milestones = [];
  for (const p of participations) for (const m of program_milestones) {
    entry_milestones.push({ id: id(), org_id: orgId, participation_id: p.id, program_milestone_id: m.id, name: m.name, kind: m.kind, due_on: m.due_on, required: m.required, sort_order: m.sort_order, phase: m.phase, owner: m.owner, step_id: m.step_id, requires_step: m.requires_step, requires_steps: m.requires_steps, feedback_on: m.feedback_on, completed_on: null });
  }
  /* One copy moved by hand, to October 2. */
  const byHand = entry_milestones.find((e) => e.step_id === 'wbs' && e.participation_id === participations[2].id);
  byHand.due_on = '2026-10-02';
  return fakeDb({
    organizations: [{ id: orgId, slug: 'montavista' }],
    programs: [{ id: programId, org_id: orgId, template_id: 'irpd-mvhs-2027' }],
    program_milestones, participations, entry_milestones, audit_log: [],
  });
}

await atest('dry: the redate names the moves and writes nothing', async () => {
  const db = seededClass();
  const before = JSON.stringify(db.tables);
  const lines = [];
  const r = await redate(db, { template: 'irpd-mvhs-2027', today: '2026-09-13', log: (l) => lines.push(l) });
  assert.equal(JSON.stringify(db.tables), before, 'nothing written on a dry run');
  assert.deepEqual(r, { changed: 0, added: 0, copies: 0 });
  const out = lines.join('\n');
  assert.match(out, /wbs\s+2026-09-30 → 2026-09-15; requires_steps: \["journey_map"\] → \[\]; sort_order: 500 → 50/);
  assert.match(out, /2 participations follow, 1 moved by hand and left/);
  for (const n of [1, 2, 3]) assert.match(out, new RegExp(`wbs_deliverable_${n}\\s+new: WBS Deliverable ${n}, due 2026-1[012]-15, waits on wbs   3 copies to make`));
  assert.match(out, /Nothing changed\. Add --apply to do it\./);
});

await atest('apply: the date, the gate and the order move; the hand-moved copy stays; three steps are added with a copy each; every change is on the record; a second run is silent', async () => {
  const db = seededClass();
  const T = db.tables;
  const r = await redate(db, { template: 'irpd-mvhs-2027', apply: true, today: '2026-09-13', log: () => {} });
  assert.deepEqual(r, { changed: 1, added: 3, copies: 2 + 9 });
  const wbs = T.program_milestones.find((m) => m.step_id === 'wbs');
  assert.equal(wbs.due_on, '2026-09-15');
  assert.deepEqual(wbs.requires_steps, []);
  assert.equal(wbs.sort_order, 50);
  assert.match(wbs.notes, /Moved from September 30, 2026 on September 13, 2026\./);
  const copies = T.entry_milestones.filter((e) => e.step_id === 'wbs');
  assert.deepEqual(copies.map((e) => e.due_on).sort(), ['2026-09-15', '2026-09-15', '2026-10-02'], 'two follow, one stays by hand');
  for (const e of copies) { assert.deepEqual(e.requires_steps, [], 'the gate lifts on every copy, moved by hand or not'); assert.equal(e.sort_order, 50); }
  for (const n of [1, 2, 3]) {
    const row = T.program_milestones.find((m) => m.step_id === `wbs_deliverable_${n}`);
    assert.ok(row, `wbs_deliverable_${n} added`);
    assert.equal(row.due_on, `2026-${['10', '11', '12'][n - 1]}-15`);
    assert.deepEqual(row.requires_steps, ['wbs']);
    assert.equal(row.deliverable_ref, `wbs_deliverable_${n}`);
    assert.equal(row.kind, 'submission');
    const made = T.entry_milestones.filter((e) => e.program_milestone_id === row.id);
    assert.equal(made.length, 3, 'one copy per participation');
    for (const e of made) { assert.equal(e.due_on, row.due_on); assert.equal(e.step_id, row.step_id); assert.deepEqual(e.requires_steps, ['wbs']); assert.equal(e.org_id, row.org_id ?? e.org_id); }
  }
  assert.equal(T.audit_log.filter((a) => a.action === 'milestone.redated').length, 1);
  assert.equal(T.audit_log.filter((a) => a.action === 'milestone.added').length, 3);
  const trail = T.audit_log.find((a) => a.action === 'milestone.redated');
  assert.deepEqual(trail.before, { due_on: '2026-09-30', requires_steps: ['journey_map'], sort_order: 500 });
  assert.deepEqual(trail.after, { due_on: '2026-09-15', requires_steps: [], sort_order: 50 });
  assert.match(trail.reason, /2 participation copies moved, 1 left as set by hand/);
  /* Nothing else moved, and nothing was removed. */
  const untouched = T.program_milestones.filter((m) => m.step_id !== 'wbs' && !/^wbs_deliverable_/.test(m.step_id));
  assert.ok(untouched.length > 20);
  assert.equal(T.entry_milestones.length, 3 * untouched.length + 3 + 9);
  /* Idempotent. */
  const again = await redate(db, { template: 'irpd-mvhs-2027', apply: true, today: '2026-09-14', log: () => {} });
  assert.deepEqual(again, { changed: 0, added: 0, copies: 0 });
  assert.equal(T.audit_log.length, 4);
});

console.log(`  ${passed} passed`);
