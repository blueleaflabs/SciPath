/**
 * Nothing in a page's frontmatter reads a value that does not exist yet.
 *
 * `const x = (() => { ... })()` runs the moment it is defined. If the body
 * touches a `const` declared further down, the page throws
 * "Cannot access before initialization" — every time, for every visitor.
 *
 * The build does not catch this. An on-demand page is bundled rather than
 * executed, so it compiles cleanly and fails on the first request. That is
 * exactly what happened: the entry page was broken for every student from
 * the moment warnings were added, and `npm run build` said nothing.
 *
 * Only immediately-invoked blocks are checked. A function declared early and
 * called later is fine, which is most of what a page does.
 *
 * Run: npm run test:frontmatter
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.astro')) out.push(full);
  }
  return out;
}

/** The balanced body of the block starting at the first brace after `from`. */
function bodyOf(text, from) {
  const open = text.indexOf('{', from);
  let depth = 0;

  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open, i);
    }
  }
  return text.slice(open);
}

const pages = walk('src/pages');
let checked = 0;

test('no immediately-invoked block reads a const declared below it', () => {
  const problems = [];

  for (const file of pages) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.startsWith('---')) continue;

    const front = source.slice(3, source.indexOf('\n---', 3));
    const declared = [...front.matchAll(/^const\s+(\w+)/gm)].map((m) => ({
      name: m[1],
      at: m.index,
    }));

    for (const m of front.matchAll(/^const\s+(\w+)\s*=\s*\(\(\)\s*=>\s*\{/gm)) {
      checked += 1;

      const body = bodyOf(front, m.index);

      /* Object keys are not reads. `{ done: rows.filter(...) }` names a
         property, and treating it as a reference to a `done` further down
         reports a page that is perfectly correct. */
      const readable = body.replace(/(^|[{,\s])(\w+)\s*:/g, '$1');

      for (const other of declared) {
        if (other.at <= m.index) continue;
        if (new RegExp(`\\b${other.name}\\b`).test(readable)) {
          const line = front.slice(0, m.index).split('\n').length + 1;
          problems.push(`${file}:${line} ${m[1]} reads ${other.name}, declared below`);
        }
      }
    }
  }

  assert.deepEqual(problems, [], 'move it below what it depends on');
});

console.log(`${passed} frontmatter assertions passed. ${checked} immediate blocks in ${pages.length} pages.`);
