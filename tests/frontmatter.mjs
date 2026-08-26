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
         reports a page that is perfectly correct.

         **Neither are comments.** This read them, so an English sentence
         inside a block became a reference: a note ending "a teacher can find
         a row where she last saw it" was reported as the block reading a
         const named `where` declared two hundred lines below. The rule was
         right about the class and wrong about prose, and the failure mode is
         the worst kind — it points at correct code and names a real const,
         so the obvious response is to move working code around. */
      const readable = body
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^\s*\/\/.*$/gm, ' ')
        .replace(/(^|[{,\s])(\w+)\s*:/g, '$1');

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

/**
 * No frontmatter writes a script tag out in full, not even inside a comment.
 *
 * Vite's dependency scanner finds script blocks in a `.astro` file by looking
 * for the opening tag. It does not know the frontmatter is TypeScript and it
 * does not know what a comment is, so an occurrence up there makes it read
 * every line from that point to the real closing tag as JavaScript. The first
 * template attribute it meets is a syntax error, and the message names that
 * attribute rather than the comment two hundred lines above it that caused it.
 *
 * `astro build` is unaffected, because the scanner runs only in dev. So this
 * passes every suite, passes CI, and breaks `npm run dev` for whoever installs
 * next — which is what it did: one word in a comment about escaping script
 * tags took out the dev server, and the error pointed at a pagefind filter.
 *
 * Describe the tag instead of writing it. The comment is not less clear for it.
 */
test('no frontmatter writes a literal script tag', () => {
  const problems = [];

  /* `src`, not `pages`. The scanner reads every `.astro` file, and the one
     that broke was a component: checking only pages is a guard that would
     have passed on the very file it was written for. Found by reintroducing
     the tag and watching this stay green. */
  for (const file of walk('src')) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.startsWith('---')) continue;

    const end = text.indexOf('\n---', 3);
    if (end === -1) continue;

    text
      .slice(0, end)
      .split('\n')
      .forEach((line, i) => {
        if (/<\/?script\b/i.test(line)) {
          problems.push(`${file}:${i + 1} writes a script tag in the frontmatter`);
        }
      });
  }

  assert.deepEqual(problems, [], 'describe the tag rather than writing it out');
});

console.log(
  `${passed} frontmatter assertions passed. ${checked} immediate blocks in ` +
    `${pages.length} pages, ${walk('src').length} components and pages scanned for script tags.`
);
