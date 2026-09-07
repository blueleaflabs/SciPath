/**
 * The plate's order is one rule for every kind of row (2.9): late first,
 * then the nearest date, a question as due today, no date last. The rows
 * come from three assemblies (questions, the Elder's tasks, the reader's
 * own work) and not every one carries every property: the reader's own
 * rows have no `id`. The key is read out of the page and run against a
 * plate of mixed rows, so a property one assembly lacks cannot bring the
 * Workbench down again (v99 did, on `id`).
 *
 * Run: npm run test:plate
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync('src/pages/app/index.astro', 'utf8');
const m = /const key = \(r: any\) => (\(.+\));\n\s+return key\(a\) - key\(b\);/.exec(page);
assert.ok(m, 'the plate sort key was not found in src/pages/app/index.astro');
const key = new Function('r', `return ${m[1]};`);

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

test('rows without an id, a number or a late flag still sort', () => {
  const rows = [
    { id: 'task-1', kick: 'Yours to do', n: 8, late: false },
    { kick: 'Next up', n: 2, late: false },
    { id: 'q-1', kick: 'Question', n: -1 },
    { kick: 'Overdue', n: -3, late: true },
    { kick: 'Next up', n: null },
    { kick: 'Notebook' },
  ].sort((a, b) => key(a) - key(b));
  assert.deepEqual(rows.map((r) => r.kick), ['Overdue', 'Question', 'Next up', 'Yours to do', 'Next up', 'Notebook']);
});

test('the gold goes to the most urgent row whatever its kind', () => {
  const rows = [
    { id: 'task-1', kick: 'Yours to do', n: 8, late: false },
    { kick: 'Next up', n: 2, late: false },
  ].sort((a, b) => key(a) - key(b));
  assert.equal(rows[0].kick, 'Next up');
});

if (process.exitCode) console.error(`\n${passed} passed, with failures.`);
else console.log(`${passed} plate assertions passed.`);
