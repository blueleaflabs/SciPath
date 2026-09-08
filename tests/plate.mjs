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

test('the teacher works from the Workbench, the cards by Elder (2.9)', () => {
  const page = fs.readFileSync('src/pages/app/index.astro', 'utf8');
  const shell = fs.readFileSync('src/components/AppShell.astro', 'utf8');
  const site = fs.readFileSync('src/config/site.ts', 'utf8');
  assert.match(site, /teacherWorkbench: true/, 'on for the pilot');
  assert.match(page, /if \(!platform\.teacherWorkbench && Astro\.request\.method === 'GET' && account && classesRun\.length === 1/, 'no redirect to the class page while it is on');
  assert.match(page, /const careGroups = me\.isAdvisor && platform\.teacherWorkbench\s*\? byElder\(/, 'the advisor\'s cards are grouped by Elder');
  assert.match(page, /if \(platform\.teacherWorkbench && me\.isAdvisor\) return 'grid';/, 'three across, as the Elder sees them');
  assert.match(shell, /platform\.teacherWorkbench \? \[\] : classes\.map/, 'the class tab leaves the bar');
  /* A project's family is its pair of Elders; one with none comes last. */
  const byElder = (rows) => {
    const out = new Map();
    for (const w of rows) {
      const elders = (w.officers ?? []).filter((o) => o.users?.display_name).map((o) => String(o.users.display_name)).sort((a, b) => a.localeCompare(b));
      const name = elders.length ? elders.join(', ') : null;
      const key = name ?? '\u0000';
      if (!out.has(key)) out.set(key, { elder: name, rows: [] });
      out.get(key).rows.push(w);
    }
    return [...out.values()].sort((a, b) => (a.elder === null ? 1 : b.elder === null ? -1 : a.elder.localeCompare(b.elder)));
  };
  const g = byElder([
    { id: 1, officers: [{ users: { display_name: 'Yutong Chen' } }, { users: { display_name: 'Aanya Padhi' } }] },
    { id: 2, officers: [] },
    { id: 3, officers: [{ users: { display_name: 'Aanya Padhi' } }, { users: { display_name: 'Yutong Chen' } }] },
    { id: 4, officers: [{ users: { display_name: 'Elaina Pan' } }] },
  ]);
  assert.deepEqual(g.map((x) => x.elder), ['Aanya Padhi, Yutong Chen', 'Elaina Pan', null]);
  assert.deepEqual(g[0].rows.map((r) => r.id), [1, 3], 'the pair is one family whichever order the Elders were attached');
  assert.match(page, /const name = elders\.length \? elders\.join\(', '\) : null;/, 'and the page groups the same way');
});

if (process.exitCode) console.error(`\n${passed} passed, with failures.`);
else console.log(`${passed} plate assertions passed.`);
