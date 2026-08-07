/**
 * A seeded manuscript described as finished has to actually be finished.
 *
 * The fixtures exist so somebody can sit down and run a submission through
 * without writing a paper first. Two of them are meant to be submit-ready,
 * and both were quietly failing the structural check: one section at 115
 * words against a minimum of 150, another at 149 against 150. The first thing
 * a person meets is then a list of things to fix, which is the opposite of
 * what the fixture is for.
 *
 * The minimums come from the rule set rather than being restated here, so
 * raising one makes this fail rather than making the fixtures wrong.
 *
 * Run: npm run test:seeds
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultRules } from '../src/config/structure.ts';

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

const source = fs.readFileSync('scripts/seed-scenarios.mjs', 'utf8');

function bank(name) {
  const start = source.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} is not in the seeder`);
  const block = source.slice(start, source.indexOf('\n};', start));

  const sections = {};
  for (const rule of defaultRules.filter((r) => r.kind === 'section')) {
    const match = block.match(
      new RegExp(`${rule.key}:\\s*\\n?\\s*'((?:[^'\\\\]|\\\\.)*)'`, 's')
    );
    if (match) sections[rule.key] = match[1];
  }
  return sections;
}

const banks = { SECTION_TEXT: bank('SECTION_TEXT'), SECTION_TEXT_B: bank('SECTION_TEXT_B') };
const sectionRules = defaultRules.filter((r) => r.kind === 'section');

const words = (text) => text.trim().split(/\s+/).filter(Boolean).length;

for (const [name, sections] of Object.entries(banks)) {
  test(`${name} has every section the rules ask for`, () => {
    for (const rule of sectionRules) {
      assert.ok(sections[rule.key], `${name} has no ${rule.key}`);
    }
  });

  test(`${name} clears every minimum`, () => {
    for (const rule of sectionRules) {
      const n = words(sections[rule.key] ?? '');
      assert.ok(
        n >= (rule.minWords ?? 0),
        `${name}.${rule.key} is ${n} words and needs ${rule.minWords}`
      );
    }
  });

  test(`${name} contains no placeholder text`, () => {
    for (const [key, text] of Object.entries(sections)) {
      assert.doesNotMatch(text, /\bTODO\b|\bTBD\b|lorem ipsum/i, `${name}.${key}`);
    }
  });
}

test('the two banks are genuinely different prose', () => {
  /* Two finished papers in a queue should not read identically, or an editor
     testing the review screens learns nothing from the second one. */
  const a = new Set(banks.SECTION_TEXT.methods.toLowerCase().split(/\s+/));
  const b = new Set(banks.SECTION_TEXT_B.methods.toLowerCase().split(/\s+/));
  const shared = [...a].filter((w) => b.has(w)).length;
  assert.ok(shared / a.size < 0.6, 'the two methods sections overlap too much');
});

test('the seeded abstracts sit inside the range the rules allow', () => {
  const rule = defaultRules.find((r) => r.id === 'meta.abstract');
  for (const match of source.matchAll(/abstract:\s*\n?\s*'((?:[^'\\]|\\.)*)'/g)) {
    const n = words(match[1]);
    /* Short scene notes are not abstracts; only the ones long enough to be
       one are held to the ceiling. */
    if (n < 40) continue;
    assert.ok(n <= (rule.maxWords ?? 350), `an abstract runs to ${n} words`);
  }
});

console.log(`${passed} seed manuscript assertions passed.`);
