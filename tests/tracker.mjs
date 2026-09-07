/**
 * THE TRACKER: THREE VIEWS, ONE CELL AT A TIME, HANDS ON THE KEYS (2.8).
 *
 * What is asserted: the arithmetic the server and the browser share; the
 * three views over one grid; the key map (so a later change cannot drop
 * a key quietly); saving one cell through the API with the id it opened
 * on; the broadcast updating a cell; the Elder and the teacher on the
 * same page, the Elder writing their family and the teacher reading.
 *
 * Run: npm run test:tracker
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { meanOf, meanWord, scoreWord, LEVELS } from '../src/lib/tracker-math.ts';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

test('the arithmetic', () => {
  assert.equal(meanOf([4, 3, '3.5', null, '']), 3.5);
  assert.equal(meanOf([]), null);
  assert.equal(meanWord([null, '']), '—');
  assert.equal(meanWord([4, 3]), '3.5');
  assert.equal(scoreWord(3), '3');
  assert.equal(scoreWord('3.50'), '3.5');
  assert.equal(scoreWord(null), '');
  assert.deepEqual([...LEVELS], ['1', '1.5', '2', '2.5', '3', '3.5', '4']);
});

const page = fs.readFileSync('src/pages/app/program/[id]/tracker.astro', 'utf8');
const api = fs.readFileSync('src/pages/app/api/score.ts', 'utf8');
const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');

test('three views over one grid, drawn from its cells', () => {
  for (const v of ['grid', 'assignment', 'student']) assert.match(page, new RegExp(`data-view="${v}"`));
  assert.match(page, /<table class="g" role="grid"/);
  assert.match(page, /data-list-assignment/); assert.match(page, /data-list-student/);
  assert.match(page, /const cellAt = \(sid: string, col: string\) => grid\.querySelector/, 'the lists read the grid');
  assert.match(page, /recall\('view'\) \?\? \(window\.innerWidth < 800 \? 'assignment' : 'grid'\)/, 'a phone opens by assignment');
});

test('the cell carries its facts and the averages use the shared arithmetic', () => {
  for (const a of ['data-mid', 'data-sid', 'data-aid', 'data-score', 'data-cmt', 'data-state', 'data-w', 'data-doc']) assert.match(page, new RegExp(a));
  const uses = page.split("lib/tracker-math'").length - 1;
  assert.equal(uses, 2, 'the page imports the arithmetic once for the server and once for the browser');
});

test('the key map', () => {
  const keys = [
    ["ArrowRight", /k === 'ArrowRight'/], ["ArrowLeft", /k === 'ArrowLeft'/], ["ArrowDown", /k === 'ArrowDown'/], ["ArrowUp", /k === 'ArrowUp'/],
    ["Home", /k === 'Home'/], ["End", /k === 'End'/], ["PageDown", /k === 'PageDown'/], ["PageUp", /k === 'PageUp'/],
    ["Tab to the next of mine", /k === 'Tab'\) \{ if \(nextMine/], ["Enter opens", /k === 'Enter'\) \{ openPanel\(c, true\)/],
    ["1-4 score", /\^\[1-4\]\$\/\.test\(k\)/], ["h half", /k === 'h'/], ["0/Backspace clear", /k === '0' \|\| k === 'Backspace'/],
    ["Escape back", /ev\.key === 'Escape' && panelCell\) \{ closePanel\(\)/], ["Ctrl+Enter next", /ev\.key === 'Enter' && \(ev\.ctrlKey \|\| ev\.metaKey\) && panelCell\) \{ step\(0, 1, true\)/],
    ["g a s views", /ev\.key === 'g'\) setView\('grid'\)/], ["/ picker", /ev\.key === '\/'\)/], ["? help", /ev\.key === '\?'\)/],
  ];
  for (const [name, re] of keys) assert.match(page, re, `${name} is missing`);
  assert.match(page, /<dialog id="keys"/, 'the keys are listed for the reader');
  assert.match(page, /tabindex="-1"/, 'cells are a roving tabindex grid');
});

test('the columns are the template\'s tracked steps, keyed by step id', () => {
  assert.match(page, /\.filter\(\(st: any\) => st\.tracker\?\.column\)/);
  assert.match(page, /\.in\('step_id', \[\.\.\.trackedIds\]\)/, 'only tracked milestones are read');
  assert.match(page, /m\.step_id === col\.key/);
  assert.match(page, /seen by students/, 'a column open to students says so in its head');
  const project = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  assert.match(project, /const scoreShown = \(m: any\) => platform\.familyScoresToStudents \|\| Boolean\(/, 'the platform switch or the step\'s own say-so');
  const loader = fs.readFileSync('scripts/pilot-load.mjs', 'utf8');
  assert.match(loader, /the template does not track/, 'the loader refuses a score on an untracked step');
});

test('saving is one cell at a time, guarded by the id it opened on', () => {
  assert.match(page, /fetch\('\/app\/api\/score\/'/);
  assert.match(page, /was: c\.dataset\.aid/);
  assert.match(api, /\.is\('superseded_by', null\)/);
  assert.match(api, /if \(\(now\?\.id \?\? ''\) !== was\) \{\s*return json\(\{ ok: false, conflict: true/);
  assert.match(api, /supabase\.rpc\('grade_milestone'/);
  assert.doesNotMatch(page, /score_all/, 'no Save all');
});

test('a score arriving over the socket updates its cell, and never the one being typed in', () => {
  assert.match(page, /m\.event !== 'assessment' \|\| !m\.payload \|\| m\.payload\.kind !== 'elder'/);
  assert.match(page, /if \(p\.by_id === \(liveMe\(\) \|\| me\)\) return;/);
  assert.match(page, /document\.activeElement === pEdit/);
  assert.match(sql, /'student_id', new\.student_id,\s*'kind', new\.kind,\s*'score', new\.score/, 'the broadcast carries the cell');
  assert.match(sql, /if new\.superseded_by is not null then return null; end if;/, 'the superseded row is not news');
});

test('the Elder and the teacher see one page; the Elder writes their family', () => {
  assert.match(page, /if \(!\(me\.isAdvisor && runsThis\) && !elderHere\) return Astro\.redirect/);
  assert.match(page, /const canWriteRow = \(r: Row\) => r\.mine;/);
  assert.doesNotMatch(page, /me\.isAdvisor && r\.elders\.length === 0/, 'the teacher does not write family scores here (decision 78)');
});

console.log(`${passed} tracker assertions passed.`);
