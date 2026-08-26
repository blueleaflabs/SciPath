/**
 * A SCOPED ROLE REACHES ITS OWN PROGRAMS AND NO OTHERS.
 *
 * **A privilege bug is invisible to any test that runs as the person who
 * granted it**, and this one was invisible to every test that ran at all.
 *
 * A project can be in a class and in a fair at once, and both teachers see it
 * — correctly, because it is one project and showing half of it would be a
 * lie about the work. What did not follow was standing: the participation
 * page checked that a session existed, that an account existed, and that the
 * project was in the program. Nothing asked whether the reader ran that
 * program. So a teacher scoped to the class could open the fair's page, and
 * every control on it that reads `me.runsTheClub` opened with it: recording
 * deliverables, verifying somebody else's, editing the warnings, setting an
 * awarded amount.
 *
 * The Open button was offered to everybody and the page refused nobody, which
 * is why removing the button was never the fix. A button is a link to an
 * address and the address was the hole.
 *
 * `reachesProgram` is the rule both of them ask. This is that rule under
 * every standing it has to answer for.
 *
 * Run: npm run test:reach
 */

import assert from 'node:assert/strict';
import { reachesProgram } from '../src/lib/roles.ts';

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

const IRPD = 'program-irpd';
const FAIR = 'program-synopsys';

/** A standing, with everything off unless the case turns it on. */
const who = (over) => ({
  names: [],
  isStudent: false,
  isOfficer: false,
  isAdvisor: false,
  isEditor: false,
  runsTheClub: false,
  scopes: [],
  anywhere: false,
  ...over,
});

const classTeacher = who({ isAdvisor: true, runsTheClub: true, scopes: [IRPD] });
const schoolAdvisor = who({ isAdvisor: true, runsTheClub: true, anywhere: true });
const clubOfficer = who({ isOfficer: true, runsTheClub: true, scopes: [FAIR] });
const plainStudent = who({ isStudent: true });

test('a scoped teacher reaches the program they run', () => {
  assert.equal(reachesProgram(classTeacher, IRPD), true);
});

test('a scoped teacher does not reach a program they do not run', () => {
  /* The bug, stated. A class teacher, a project in the class and the fair,
     and the fair's page. */
  assert.equal(reachesProgram(classTeacher, FAIR), false);
});

test('an officer of one program does not reach another', () => {
  /* Same rule, other direction. A club officer is not admitted to the class
     by holding a fair role, which is the mirror of the case that was found
     and would otherwise have been fixed in one direction only. */
  assert.equal(reachesProgram(clubOfficer, IRPD), false);
});

test('an unscoped role reaches everything', () => {
  /* What `anywhere` means, and the right default for a school's own advisor.
     A rule that fenced her out of a program would be worse than the bug. */
  assert.equal(reachesProgram(schoolAdvisor, FAIR), true);
  assert.equal(reachesProgram(schoolAdvisor, IRPD), true);
});

test('an author reaches every program their project is in', () => {
  /* Their work. A class teacher cannot fence a student out of the fair the
     student entered, and a student holds no role at all — so without this
     the guard would have locked out the one person who must never be. */
  assert.equal(reachesProgram(plainStudent, FAIR, { isAuthor: true }), true);
  assert.equal(reachesProgram(classTeacher, FAIR, { isAuthor: true }), true);
});

test('an officer attached to the participation reaches it', () => {
  /* Oversight names the participation rather than the project (22.18), so
     being attached here is a fact about this row and not a guess from a
     standing role. */
  assert.equal(reachesProgram(plainStudent, FAIR, { attachedTo: true }), true);
});

test('a bystander reaches nothing', () => {
  /* Somebody who is neither an author, nor attached, nor running anything.
     They can still see from the project page that it is entered; what stops
     is acting on the entry. */
  assert.equal(reachesProgram(plainStudent, FAIR), false);
});

test('an absent program is not a wildcard', () => {
  /* `undefined` reaching everything is the shape this kind of guard fails
     in: a route that loses its parameter would open every program to a
     scoped role. Only `anywhere` is a wildcard, and it says so. */
  assert.equal(reachesProgram(classTeacher, null), false);
  assert.equal(reachesProgram(classTeacher, undefined), false);
  assert.equal(reachesProgram(schoolAdvisor, null), true);
});

console.log(`\n${passed} reach assertions passed.`);
