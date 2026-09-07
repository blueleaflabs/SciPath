/**
 * A PHONE, A TABLET, A LAPTOP: THE GUARDS (2.8).
 *
 * Layout is fluid by construction and content decides where it changes
 * shape; these are the rules that keep that true, asserted on the
 * sources so the next change cannot quietly undo one. The pictures are
 * `npm run shots`; this is what makes the pictures boring.
 *
 * Run: npm run test:mobile
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; }
  catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
}

const base = fs.readFileSync('src/styles/base.css', 'utf8');
const ui = fs.readFileSync('src/styles/ui.css', 'utf8');
const mast = fs.readFileSync('src/components/Masthead.astro', 'utf8');
const shell = fs.readFileSync('src/components/AppShell.astro', 'utf8');
const layout = fs.readFileSync('src/layouts/Base.astro', 'utf8');

test('the viewport is the device', () => {
  assert.match(layout, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
});

test('nothing may widen the document', () => {
  assert.match(base, /html,\s*body \{\s*overflow-x: clip;\s*\}/, 'the body clips sideways overflow (clip, not hidden)');
  assert.doesNotMatch(base, /overflow-x: hidden/, 'hidden would make the root a scroll container');
});

test('the type scale steps down on a phone and never below 17px', () => {
  assert.match(base, /@media \(max-width: 720px\) \{\s*html \{\s*font-size: clamp\(17px, [\d.]+vw, 19\.5px\);/);
});

test('the masthead stacks below the width its content fits on one line', () => {
  assert.match(ui, /@media \(min-width: 861px\) \{\s*\.mast-in \{ flex-wrap: nowrap; \}/, 'one line only above 860');
  assert.match(mast, /@media \(min-width: 861px\) \{\s*\.mnav-bar \{ flex-wrap: nowrap; min-width: 0; \}/);
  assert.match(mast, /@media \(max-width: 860px\) \{[\s\S]*?\.mnav-acct \{[^}]*white-space: normal;[^}]*\}/, 'the account cluster may wrap on a narrow screen');
  assert.match(mast, /@media \(max-width: 600px\) \{[\s\S]*?\.mnav-find \{ flex: 1 1 100%; \}/, 'the search takes its own row on a phone');
});

test('the working-surface bar is a strip on a phone, never wrapped labels', () => {
  assert.match(shell, /@media \(max-width: 720px\) \{\s*\.appnav \{\s*overflow-x: auto;/);
  assert.match(shell, /\.appnav a \{ white-space: nowrap;/);
  assert.match(shell, /\.appnav a\[aria-current="page"\]/, 'the current tab is scrolled into view');
});

test('touch targets key on the pointer, not the width', () => {
  assert.match(ui, /@media \(pointer: coarse\) \{[\s\S]*?min-height: 44px;/);
  assert.doesNotMatch(ui, /@media \(max-width: \d+px\) \{[^}]*min-height: 44px/, '44px is for a finger, which a narrow mouse window does not have');
});

test('a wide table scrolls in its own box on a phone', () => {
  assert.match(ui, /@media \(max-width: 860px\) \{\s*\.tbl:not\(\.phased\) \{\s*display: block;\s*overflow-x: auto;/);
});

test('every bare nowrap in the shared kit has a way out', () => {
  /* A nowrap on a flex child that may neither wrap nor shrink is the
     failure a phone shows first. In ui.css, nowrap is allowed on short,
     bounded text (a pill, a count, a label, a button) and on things that
     scroll; the plate's control column is the one that needed a phone
     rule, and it has one. */
  assert.match(ui, /\.alarm\.plate \.plate-row > \.act \{ justify-self: stretch; white-space: normal; \}/);
  assert.match(ui, /\.ledger \.do \{ grid-column: 2; padding: 0 0 12px; white-space: normal;/);
});

test('the pictures script exists and is documented', () => {
  assert.ok(fs.existsSync('scripts/shots.mjs'));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts.shots, 'node scripts/shots.mjs');
  assert.match(fs.readFileSync('COMMANDS.md', 'utf8'), /npm run shots/);
});

console.log(`${passed} mobile assertions passed.`);
