/**
 * Tests for the structural check.
 *
 * Written before the interface around it, on the same reasoning as the date
 * ordering tests: a check that can only be exercised by filling in a form is
 * a check nobody will exercise.
 *
 * Run: npm run test:structure
 */

import assert from 'node:assert/strict';
import { checkStructure, maySubmit, completeness, checklist, applicableRules, words } from '../src/lib/structure.ts';
import { defaultRules, sectionsFor } from '../src/config/structure.ts';

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

const filler = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

/** A manuscript with nothing wrong with it, which every test then breaks. */
function complete(over = {}) {
  return {
    recordKind: 'article',
    source: 'workbench',
    bodyFormat: 'full-text',
    title: 'Thermal tolerance in intertidal snails',
    abstract: filler(140),
    keywords: ['thermal tolerance', 'intertidal', 'gastropods'],
    discipline: 'biology-biomedicine',
    contributions:
      'B. Adeyemi designed the study, collected and analyzed the data, and wrote the paper. J. Okonkwo supervised laboratory safety and reviewed the protocol before work began.',
    externalUrl: null,
    pdfPath: null,
    sections: [
      { key: 'background', body: filler(160) },
      { key: 'prior_work', body: filler(110) },
      { key: 'methods', body: filler(210) },
      { key: 'results', body: filler(160) },
      { key: 'discussion', body: filler(160) },
      { key: 'conclusion', body: filler(80) },
      { key: 'future_work', body: filler(60) },
    ],
    figures: [],
    references: ['One', 'Two', 'Three', 'Four', 'Five'],
    authors: [{ displayName: 'B. Adeyemi', accepted: true }],
    entryCount: 1,
    ...over,
  };
}

const run = (over) =>
  checkStructure({ rules: defaultRules, manuscript: complete(over) });

const blocking = (findings) => findings.filter((f) => f.severity === 'blocking');
const ids = (findings) => findings.map((f) => f.ruleId);

/* ── The happy path ─────────────────────────────────────────────────────── */

test('a complete manuscript has nothing blocking', () => {
  const f = run({});
  assert.deepEqual(blocking(f), []);
  assert.equal(maySubmit(f), true);
});

test('the human checks are always reported and never block', () => {
  const f = run({});
  const human = f.filter((x) => x.severity === 'human');
  assert.equal(human.length, 4);
  assert.equal(maySubmit(f), true);
});

test('findings come back blocking first', () => {
  const f = run({ abstract: null, discipline: null });
  assert.equal(f[0].severity, 'blocking');
  assert.equal(f[f.length - 1].severity, 'human');
});

/* ── Sections ───────────────────────────────────────────────────────────── */

test('an unwritten section blocks', () => {
  const f = run({
    sections: complete().sections.filter((s) => s.key !== 'methods'),
  });
  assert.ok(ids(blocking(f)).includes('section.methods'));
  assert.match(f[0].message, /has not been written/);
});

test('a section under its minimum blocks and says by how much', () => {
  const f = run({
    sections: complete().sections.map((s) =>
      s.key === 'methods' ? { key: 'methods', body: filler(40) } : s
    ),
  });
  const hit = f.find((x) => x.ruleId === 'section.methods');
  assert.equal(hit.severity, 'blocking');
  assert.match(hit.message, /is 40 words. It needs at least 200/);
});

test('placeholder text left in a section blocks', () => {
  const f = run({
    sections: complete().sections.map((s) =>
      s.key === 'results' ? { key: 'results', body: `${filler(160)} TODO` } : s
    ),
  });
  const hit = f.find((x) => x.ruleId === 'section.results');
  assert.equal(hit.severity, 'blocking');
  assert.match(hit.message, /TODO/);
});

test('a PDF record is not asked for sections it was never going to have', () => {
  const f = run({ bodyFormat: 'pdf-only', pdfPath: 'x.pdf', sections: [] });
  assert.deepEqual(
    ids(blocking(f)).filter((id) => id.startsWith('section.')),
    []
  );
});

/* ── Authors, which is the one rule that never softens ──────────────────── */

test('an author who has not accepted blocks', () => {
  const f = run({
    authors: [
      { displayName: 'B. Adeyemi', accepted: true },
      { displayName: 'C. Duarte', accepted: false },
    ],
    contributions:
      'B. Adeyemi ran the experiments and wrote the paper. C. Duarte built the logging rig and analyzed the temperature series.',
  });
  const hit = f.find((x) => x.ruleId === 'meta.authors');
  assert.equal(hit.severity, 'blocking');
  assert.match(hit.message, /C. Duarte/);
});

test('unaccepted authorship still blocks on an external submission', () => {
  const f = run({
    source: 'external',
    authors: [
      { displayName: 'B. Adeyemi', accepted: true },
      { displayName: 'C. Duarte', accepted: false },
    ],
  });
  assert.ok(ids(blocking(f)).includes('meta.authors'));
});

/* ── Contributions ──────────────────────────────────────────────────────── */

test('a contributions statement that omits an author is advice, not a wall', () => {
  const f = run({
    authors: [
      { displayName: 'B. Adeyemi', accepted: true },
      { displayName: 'C. Duarte', accepted: true },
    ],
  });
  const hit = f.find((x) => x.ruleId === 'meta.contributions');
  assert.equal(hit.severity, 'advisory');
  assert.match(hit.message, /C. Duarte/);
  assert.equal(maySubmit(f), true);
});

test('a short but complete contributions statement is fine', () => {
  const f = run({
    contributions: 'I did all of the work myself. No mentor was involved at any point.',
    authors: [{ displayName: 'B. Adeyemi', accepted: true }],
  });
  assert.deepEqual(blocking(f), []);
});

test('a contributions statement naming everyone passes', () => {
  const f = run({
    authors: [
      { displayName: 'B. Adeyemi', accepted: true },
      { displayName: 'C. Duarte', accepted: true },
    ],
    contributions:
      'Adeyemi designed the study, ran every trial, and wrote the paper. Duarte built the logging rig, wrote the analysis scripts, and prepared the temperature series figures for the poster.',
  });
  assert.equal(
    f.find((x) => x.ruleId === 'meta.contributions'),
    undefined
  );
});

/* ── Abstract, keywords, references ─────────────────────────────────────── */

test('a missing abstract blocks', () => {
  const f = run({ abstract: null });
  assert.ok(ids(blocking(f)).includes('meta.abstract'));
});

test('an overlong abstract is advice, not a wall', () => {
  const f = run({ abstract: filler(500) });
  const hit = f.find((x) => x.ruleId === 'meta.abstract');
  assert.equal(hit.severity, 'advisory');
  assert.equal(maySubmit(f), true);
});

test('too few keywords blocks, too many is advice', () => {
  assert.equal(run({ keywords: ['one'] }).find((f) => f.ruleId === 'meta.keywords').severity, 'blocking');
  assert.equal(
    run({ keywords: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).find((f) => f.ruleId === 'meta.keywords')
      .severity,
    'advisory'
  );
});

test('fewer than five references blocks', () => {
  const f = run({ references: ['One', 'Two'] });
  const hit = f.find((x) => x.ruleId === 'meta.references');
  assert.equal(hit.severity, 'blocking');
  assert.match(hit.message, /are 2 references/);
});

test('blank reference lines do not count', () => {
  const f = run({ references: ['One', '  ', 'Two', '', 'Three', 'Four', 'Five'] });
  assert.equal(f.find((x) => x.ruleId === 'meta.references'), undefined);
});

test('an all-capitals title is advice', () => {
  const f = run({ title: 'THERMAL TOLERANCE IN INTERTIDAL SNAILS' });
  const hit = f.find((x) => x.ruleId === 'meta.title');
  assert.equal(hit.severity, 'advisory');
});

/* ── The external path ──────────────────────────────────────────────────── */

test('an external manuscript reports the same problems as advice', () => {
  const f = run({ source: 'external', sections: [], abstract: null, references: [] });
  assert.deepEqual(
    blocking(f).filter((x) => x.ruleId !== 'meta.authors'),
    []
  );
  assert.equal(maySubmit(f), true);
  assert.ok(f.some((x) => x.ruleId === 'meta.abstract' && x.severity === 'advisory'));
});

test('a migrated record is advisory too', () => {
  const f = run({ source: 'migrated', abstract: null });
  assert.equal(f.find((x) => x.ruleId === 'meta.abstract').severity, 'advisory');
});

/* ── Figures ────────────────────────────────────────────────────────────── */

test('a figure nobody mentions in the text is advice', () => {
  const f = run({
    figures: [{ number: 1, caption: 'Survival by shore height', alt: 'A bar chart.' }],
  });
  const hit = f.find((x) => x.ruleId === 'figure.referenced');
  assert.equal(hit.severity, 'advisory');
  assert.match(hit.message, /Figure 1/);
});

test('a figure referenced anywhere in the prose is fine', () => {
  const f = run({
    figures: [{ number: 1, caption: 'Survival by shore height', alt: 'A bar chart.' }],
    sections: complete().sections.map((s) =>
      s.key === 'results' ? { key: 'results', body: `${filler(160)} as shown in Figure 1.` } : s
    ),
  });
  assert.equal(f.find((x) => x.ruleId === 'figure.referenced'), undefined);
});

test('Fig. 2 and fig 2 both count as a reference', () => {
  for (const form of ['Fig. 2', 'fig 2', '(Figure 2)']) {
    const f = run({
      figures: [{ number: 2, caption: 'c', alt: 'a' }],
      sections: complete().sections.map((s) =>
        s.key === 'results' ? { key: 'results', body: `${filler(160)} ${form}` } : s
      ),
    });
    assert.equal(f.find((x) => x.ruleId === 'figure.referenced'), undefined, form);
  }
});

/* ── Record kinds ───────────────────────────────────────────────────────── */

test('a project entry is not asked for sections or references', () => {
  const f = checkStructure({
    rules: defaultRules,
    manuscript: complete({
      recordKind: 'project',
      bodyFormat: 'none',
      sections: [],
      references: [],
    }),
  });
  assert.deepEqual(blocking(f), []);
});

test('a project entry with no fair behind it blocks', () => {
  const f = checkStructure({
    rules: defaultRules,
    manuscript: complete({
      recordKind: 'project',
      bodyFormat: 'none',
      sections: [],
      references: [],
      entryCount: 0,
    }),
  });
  assert.ok(ids(blocking(f)).includes('meta.entries'));
});

test('an article is never asked for a competition record', () => {
  const f = run({ entryCount: 0 });
  assert.equal(f.find((x) => x.ruleId === 'meta.entries'), undefined);
});

/* ── Pointing elsewhere ─────────────────────────────────────────────────── */

test('link-only with no address blocks', () => {
  const f = run({ bodyFormat: 'link-only', sections: [], externalUrl: null });
  assert.ok(ids(blocking(f)).includes('meta.external_url'));
});

test('pdf-only with no file blocks', () => {
  const f = run({ bodyFormat: 'pdf-only', sections: [], pdfPath: null });
  assert.ok(ids(blocking(f)).includes('meta.pdf'));
});

/* ── Counting ───────────────────────────────────────────────────────────── */

test('word counting ignores extra whitespace and nulls', () => {
  assert.equal(words('  one   two\n\nthree '), 3);
  assert.equal(words(null), 0);
  assert.equal(words(''), 0);
});

test('completeness counts required machine-checkable items only', () => {
  const m = complete();
  const f = checkStructure({ rules: defaultRules, manuscript: m });
  const { done, total } = completeness(defaultRules, m, f);
  assert.equal(done, total);
  assert.ok(total > 10);
});

test('completeness falls as things go missing', () => {
  const m = complete({ abstract: null, discipline: null });
  const f = checkStructure({ rules: defaultRules, manuscript: m });
  const { done, total } = completeness(defaultRules, m, f);
  assert.equal(done, total - 2);
});

test('a project entry has fewer things to complete than an article', () => {
  const article = complete();
  const entry = complete({ recordKind: 'project', bodyFormat: 'none', sections: [], references: [] });
  const a = completeness(defaultRules, article, checkStructure({ rules: defaultRules, manuscript: article }));
  const p = completeness(defaultRules, entry, checkStructure({ rules: defaultRules, manuscript: entry }));
  assert.ok(p.total < a.total);
});

test('the section list matches what the rules declare', () => {
  assert.equal(sectionsFor('article').length, 7);
  assert.equal(sectionsFor('project').length, 0);
});

test('every rule id is unique', () => {
  const seen = new Set();
  for (const rule of defaultRules) {
    assert.equal(seen.has(rule.id), false, `duplicate rule id ${rule.id}`);
    seen.add(rule.id);
  }
});

/* ── The checklist ──────────────────────────────────────────────────────── */

test('a complete manuscript shows every item done', () => {
  const m = complete();
  const list = checklist(defaultRules, m, checkStructure({ rules: defaultRules, manuscript: m }));
  assert.ok(list.length > 10);
  assert.deepEqual(list.filter((i) => i.status !== 'done'), []);
});

test('the checklist keeps the items that pass alongside the ones that do not', () => {
  const m = complete({ abstract: null });
  const list = checklist(defaultRules, m, checkStructure({ rules: defaultRules, manuscript: m }));
  assert.equal(list.find((i) => i.ruleId === 'meta.abstract').status, 'blocking');
  assert.equal(list.find((i) => i.ruleId === 'meta.title').status, 'done');
});

test('a done item explains what the rule wants rather than going blank', () => {
  const m = complete();
  const list = checklist(defaultRules, m, checkStructure({ rules: defaultRules, manuscript: m }));
  assert.ok(list.find((i) => i.ruleId === 'meta.title').message.length > 20);
});

test('an advisory item is neither done nor blocking', () => {
  const m = complete({ abstract: filler(500) });
  const list = checklist(defaultRules, m, checkStructure({ rules: defaultRules, manuscript: m }));
  assert.equal(list.find((i) => i.ruleId === 'meta.abstract').status, 'advisory');
});

test('the checklist has no human checks in it', () => {
  const m = complete();
  const list = checklist(defaultRules, m, checkStructure({ rules: defaultRules, manuscript: m }));
  assert.deepEqual(list.filter((i) => i.ruleId.startsWith('human.')), []);
});

test('a finding no rule produced still appears', () => {
  const m = complete({
    figures: [{ number: 1, caption: 'c', alt: 'a' }],
  });
  const list = checklist(defaultRules, m, checkStructure({ rules: defaultRules, manuscript: m }));
  const orphan = list.find((i) => i.ruleId === 'figure.referenced');
  assert.equal(orphan.status, 'advisory');
});

test('a project entry checklist is shorter and has no sections in it', () => {
  const m = complete({ recordKind: 'project', bodyFormat: 'none', sections: [], references: [] });
  const list = checklist(defaultRules, m, checkStructure({ rules: defaultRules, manuscript: m }));
  assert.deepEqual(list.filter((i) => i.ruleId.startsWith('section.')), []);
});

test('checklist length matches what completeness counts', () => {
  const m = complete();
  const f = checkStructure({ rules: defaultRules, manuscript: m });
  assert.equal(checklist(defaultRules, m, f).length, completeness(defaultRules, m, f).total);
});

/* ── A finished PDF asks for four things and a file ─────────────────────── */

test('a PDF record is not asked for references or contributions', () => {
  const m = complete({
    bodyFormat: 'pdf-only',
    pdfPath: 'x.pdf',
    sections: [],
    references: [],
    contributions: null,
  });
  const f = checkStructure({ rules: defaultRules, manuscript: m });
  assert.deepEqual(blocking(f), []);
});

test('the PDF checklist is title, authors, abstract, keywords, discipline', () => {
  const m = complete({ bodyFormat: 'pdf-only', pdfPath: 'x.pdf', sections: [], references: [], contributions: null });
  const list = checklist(defaultRules, m, checkStructure({ rules: defaultRules, manuscript: m }));
  assert.deepEqual(
    list.map((i) => i.ruleId).sort(),
    ['meta.abstract', 'meta.authors', 'meta.discipline', 'meta.keywords', 'meta.title']
  );
});

test('references and contributions come back the moment writing moves here', () => {
  const pdf = complete({ bodyFormat: 'pdf-only', pdfPath: 'x.pdf', sections: [], references: [], contributions: null });
  const here = complete();
  assert.ok(
    applicableRules(defaultRules, here).length > applicableRules(defaultRules, pdf).length
  );
  assert.ok(applicableRules(defaultRules, here).some((r) => r.id === 'meta.references'));
  assert.ok(!applicableRules(defaultRules, pdf).some((r) => r.id === 'meta.references'));
});

test('every caller agrees on how many things there are', () => {
  for (const m of [
    complete(),
    complete({ bodyFormat: 'pdf-only', pdfPath: 'x.pdf', sections: [], references: [], contributions: null }),
    complete({ recordKind: 'project', bodyFormat: 'none', sections: [], references: [], contributions: null }),
  ]) {
    const f = checkStructure({ rules: defaultRules, manuscript: m });
    assert.equal(checklist(defaultRules, m, f).length, completeness(defaultRules, m, f).total);
  }
});

console.log(`${passed} structural check assertions passed.`);
