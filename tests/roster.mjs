/**
 * Tests for reading a roster.
 *
 * A club advisor pastes from Excel. The file will have a header or not,
 * quotes or not, a stray blank line, and a column order they chose. None of
 * that should produce an error, and an address that is not an address should.
 *
 * Run: npm run test:roster
 */

import assert from 'node:assert/strict';
import { parseRoster, splitLine } from '../src/lib/roster.ts';

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

test('a plain file with a header', () => {
  const { rows, problems } = parseRoster(
    'email,name,role\na@b.com,A Person,officer\nc@d.com,C Person,editor'
  );
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].email, 'a@b.com');
  assert.equal(rows[0].display_name, 'A Person');
  assert.equal(rows[1].role, 'editor');
});

test('no header at all', () => {
  const { rows, problems } = parseRoster('a@b.com,A Person,officer');
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'officer');
});

test('columns in any order', () => {
  const { rows } = parseRoster('role,email\nofficer,a@b.com');
  assert.equal(rows[0].email, 'a@b.com');
  assert.equal(rows[0].role, 'officer');
});

test('a name containing a comma survives quoting', () => {
  assert.deepEqual(splitLine('"Duarte, C.",a@b.com,editor'), ['Duarte, C.', 'a@b.com', 'editor']);
  const { rows } = parseRoster('"Duarte, C.",a@b.com,editor');
  assert.equal(rows[0].display_name, 'Duarte, C.');
});

test('a doubled quote is one quote', () => {
  assert.deepEqual(splitLine('"say ""hi""",a@b.com,officer')[0], 'say "hi"');
});

test('blank lines and trailing newlines are ignored', () => {
  const { rows, problems } = parseRoster('\na@b.com,A,officer\n\n\n');
  assert.equal(rows.length, 1);
  assert.deepEqual(problems, []);
});

test('addresses are lowercased', () => {
  const { rows } = parseRoster('A.Person@School.EDU,A,officer');
  assert.equal(rows[0].email, 'a.person@school.edu');
});

test('the same person and role twice is one row', () => {
  const { rows } = parseRoster('a@b.com,A,officer\na@b.com,A,officer');
  assert.equal(rows.length, 1);
});

test('the same person in two roles is two rows', () => {
  const { rows } = parseRoster('a@b.com,A,officer\na@b.com,A,editor');
  assert.equal(rows.length, 2);
});

test('a line with no address is reported with its line number', () => {
  const { rows, problems } = parseRoster('email,role\nnot an address,officer\na@b.com,editor');
  assert.equal(rows.length, 1);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 2);
  assert.match(problems[0].reason, /no email/);
});

test('a role nobody can give out is refused by name', () => {
  const { rows, problems } = parseRoster('a@b.com,A,advisor');
  assert.deepEqual(rows, []);
  assert.match(problems[0].reason, /advisor/);
});

test('a missing role is refused rather than guessed', () => {
  const { problems } = parseRoster('a@b.com,A Person');
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /no role/);
});

test('a header row is not read as data', () => {
  const { rows } = parseRoster('email,name,role\na@b.com,A,officer');
  assert.equal(rows.length, 1);
});

test('a first line that looks like a header but holds an address is data', () => {
  const { rows, problems } = parseRoster('email@school.edu,name,officer');
  assert.equal(rows.length, 1, JSON.stringify(problems));
});

test('problems and rows come back together, so a good file with one bad line still loads', () => {
  const { rows, problems } = parseRoster(
    'a@b.com,A,officer\ngarbage\nc@d.com,C,editor'
  );
  assert.equal(rows.length, 2);
  assert.equal(problems.length, 1);
});

console.log(`${passed} roster assertions passed.`);
