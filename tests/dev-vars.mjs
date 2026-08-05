/**
 * Tests for reading .dev.vars.
 *
 * The file is written by hand, so it will have comments, blank lines, an
 * `export` somebody copied from a shell, and quotes around a value or not.
 * None of that should stop a seed script running.
 *
 * Run: npm run test:devvars
 */

import assert from 'node:assert/strict';
import { parseDevVars } from '../scripts/dev-vars.mjs';

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

test('plain assignments', () => {
  assert.deepEqual(parseDevVars('A=1\nB=two'), { A: '1', B: 'two' });
});

test('comments and blank lines are skipped', () => {
  assert.deepEqual(parseDevVars('# a note\n\nA=1\n   \n#B=2'), { A: '1' });
});

test('an export copied from a shell is tolerated', () => {
  assert.deepEqual(parseDevVars('export A=1'), { A: '1' });
});

test('a matched pair of quotes is stripped', () => {
  assert.deepEqual(parseDevVars('A="one"\nB=\'two\''), { A: 'one', B: 'two' });
});

test('an unmatched quote is left alone', () => {
  assert.deepEqual(parseDevVars('A="one'), { A: '"one' });
});

test('a value containing = keeps it, because keys are tokens and values are not', () => {
  assert.deepEqual(parseDevVars('KEY=abc=def=='), { KEY: 'abc=def==' });
});

test('a JWT survives intact', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.abc-_123';
  assert.equal(parseDevVars(`SUPABASE_SECRET_KEY=${jwt}`).SUPABASE_SECRET_KEY, jwt);
});

test('a line with no equals is ignored rather than crashing', () => {
  assert.deepEqual(parseDevVars('nonsense\nA=1'), { A: '1' });
});

test('whitespace around the key and value is trimmed', () => {
  assert.deepEqual(parseDevVars('  A  =  1  '), { A: '1' });
});

test('carriage returns from a Windows editor are not part of the value', () => {
  assert.deepEqual(parseDevVars('A=1\r\nB=2\r\n'), { A: '1', B: '2' });
});

console.log(`${passed} dev-vars assertions passed.`);
