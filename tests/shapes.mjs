/**
 * EVERY SHAPE FILLS.
 *
 * A shape is the template of a deliverable a student writes in SciPath
 * (6.16). A field without a prompt, a choice with one option, two fields
 * with one id: each is a document nobody can complete, and it should fail
 * here rather than in front of a class on the day the thing is due.
 *
 * Also: every deliverable in a program template that names a shape names
 * one that exists, and the older shapes (parts, answers) still read as
 * sections of fields, so nothing that referenced them has changed shape.
 *
 *   node --experimental-strip-types tests/shapes.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { validateShape, sectionsOf, askedOf } from '../src/lib/template-resolve.ts';

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

const files = fs.readdirSync('src/config/shapes').filter((f) => f.endsWith('.yaml'));
const shapes = files.map((f) => ({ file: f, shape: yaml.load(fs.readFileSync(`src/config/shapes/${f}`, 'utf8')) }));

for (const { file, shape } of shapes) {
  test(`${file} is a shape a student can fill`, () => {
    assert.deepEqual(validateShape(shape), []);
    assert.ok(askedOf(shape).length > 0, 'asks for something');
  });
}

test('the older forms read as sections of fields', () => {
  const quad = shapes.find((s) => s.shape.id === 'quad_chart').shape;
  const sections = sectionsOf(quad);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].fields.length, 4);
  assert.equal(sections[0].fields[0].kind, 'long');
  const abstract = shapes.find((s) => s.shape.id === 'abstract').shape;
  assert.equal(askedOf(abstract).length, 4);
});

test('the validator refuses what a student could not fill', () => {
  assert.ok(validateShape({ id: 'x', name: 'x', sections: [{ id: 's', fields: [{ id: 'a', kind: 'long' }] }] }).some((p) => /prompt/.test(p)));
  assert.ok(validateShape({ id: 'x', name: 'x', sections: [{ id: 's', fields: [{ id: 'a', kind: 'choice', prompt: '?', options: ['one'] }] }] }).some((p) => /two options/.test(p)));
  assert.ok(validateShape({ id: 'x', name: 'x', sections: [{ id: 's', fields: [{ id: 'a', kind: 'text', prompt: '?' }, { id: 'a', kind: 'text', prompt: '?' }] }] }).some((p) => /twice/.test(p)));
  assert.ok(validateShape({ id: 'x', name: 'x', sections: [{ id: 's', fields: [{ id: 'a', kind: 'note', text: 'read this' }] }] }).some((p) => /every field is a note/.test(p)));
  assert.ok(validateShape({ id: 'x', name: 'x', sections: [{ id: 's', fields: [{ id: 'Bad-Id', kind: 'text', prompt: '?' }] }] }).some((p) => /lower case/.test(p)));
});

test('every shape a program names exists', () => {
  const ids = new Set(shapes.map((s) => s.shape.id));
  const named = [];
  for (const dir of ['programs', 'deliverables']) {
    for (const f of fs.readdirSync(`src/config/${dir}`).filter((f) => f.endsWith('.yaml'))) {
      const doc = yaml.load(fs.readFileSync(`src/config/${dir}/${f}`, 'utf8'));
      for (const d of Array.isArray(doc?.deliverables) ? doc.deliverables : []) if (d.shape) named.push({ where: `${dir}/${f}`, shape: d.shape });
    }
  }
  const missing = named.filter((n) => !ids.has(n.shape));
  assert.deepEqual(missing, [], 'a deliverable names a shape that is not in src/config/shapes');
});

test('a shape with a rubric field is asked for by a step that carries a rubric', () => {
  const rubricShapes = new Set(shapes.filter((s) => (s.shape.sections ?? []).some((sec) => (sec.fields ?? []).some((f) => f.kind === 'rubric'))).map((s) => s.shape.id));
  if (rubricShapes.size === 0) return;
  const problems = [];
  for (const f of fs.readdirSync('src/config/programs').filter((f) => f.endsWith('.yaml'))) {
    const doc = yaml.load(fs.readFileSync(`src/config/programs/${f}`, 'utf8'));
    const byId = new Map((Array.isArray(doc?.deliverables) ? doc.deliverables : []).map((d) => [d.id, d]));
    for (const step of Array.isArray(doc?.steps) ? doc.steps : []) {
      const wants = (step.deliverables ?? []).map((d) => byId.get(d.ref ?? d.id)).filter(Boolean);
      if (wants.some((d) => rubricShapes.has(d.shape)) && !step.rubric) problems.push(`${f}/${step.id} wants a shape with a self-evaluation and carries no rubric`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the Elder\'s fields are never required of the student', () => {
  for (const { shape } of shapes) {
    for (const sec of shape.sections ?? []) for (const f of sec.fields ?? []) {
      if (f.owner === 'staff') assert.ok(!f.required, `${shape.id}/${f.id}`);
    }
  }
});

if (process.exitCode) {
  console.error(`\n${passed} passed, with failures.`);
} else {
  console.log(`${passed} shape assertions passed. ${shapes.length} shapes read.`);
}
