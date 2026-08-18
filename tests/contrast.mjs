/**
 * Contrast assertions for every shipped theme.
 *
 * The legibility floor is a regression test, not a guideline. A theme that
 * is not exercised rots silently over months of component work and fails on
 * the day someone actually needs it, so every theme in tokens.css is checked
 * on every build.
 *
 * Run: npm run test:contrast
 */

import fs from 'node:fs';
import path from 'node:path';

const AA = 4.5;
const AA_LARGE = 3.0;

const css = fs.readFileSync(path.join(process.cwd(), 'src/styles/tokens.css'), 'utf8');

/** Pull each [data-theme="x"] block into a token map. */
function parseThemes(source) {
  const themes = {};
  const blockPattern = /\[data-theme=['"]([\w-]+)['"]\]\s*\{([^}]*)\}/g;
  let match;
  while ((match = blockPattern.exec(source)) !== null) {
    const [, name, body] = match;
    const tokens = {};
    for (const line of body.split('\n')) {
      const declaration = /--([\w-]+)\s*:\s*([^;]+);/.exec(line);
      if (declaration) tokens[`--${declaration[1]}`] = declaration[2].trim();
    }
    themes[name] = tokens;
  }
  return themes;
}

/** Resolve var() indirection, so --brand: var(--ink) is checkable. */
function resolve(tokens, name, depth = 0) {
  if (depth > 10) throw new Error(`Token loop at ${name}`);
  const value = tokens[name];
  if (!value) throw new Error(`Missing token ${name}`);
  const indirect = /^var\((--[\w-]+)\)$/.exec(value);
  if (indirect) return resolve(tokens, indirect[1], depth + 1);
  return value;
}

function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const clean = hex.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) throw new Error(`Not a hex color: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

/**
 * Every pair where text sits on a surface. Large-only pairs are marked, and
 * a pair that carries no text at all does not belong in this list.
 */
const PAIRS = [
  ['--ink', '--paper'],
  ['--ink', '--card'],
  ['--ink', '--sunk'],
  ['--ink-2', '--paper'],
  ['--ink-2', '--card'],
  ['--ink-2', '--sunk'],
  ['--ink-3', '--paper'],
  ['--ink-3', '--card'],
  ['--ink-3', '--sunk'],
  ['--masthead-ink', '--masthead-bg'],
  ['--masthead-ink-2', '--masthead-bg'],
  ['--brand-contrast', '--brand'],
  ['--card', '--ink'],

  /* Section numbers and folios are set in the school's own hue on a card and
     on the wash. They were briefly set in `--brand-mark`, which is 3.2:1 —
     under this floor for text at that size, and invisible to this file
     because the pair was not in it. A colour used as text belongs here; the
     mark stays an edge colour, and edges are exempt because nobody reads
     them. */
  ['--brand', '--card'],
  ['--brand', '--sunk'],
  ['--brand', '--paper'],
  ['--stage-draft', '--card'],
  ['--stage-work', '--card'],
  ['--stage-ready', '--card'],
  ['--stage-ready', '--ready-bg'],
  ['--stage-comp', '--card'],
  ['--stage-comp', '--ok-bg'],
  ['--stage-pub', '--card'],
  ['--alert', '--card'],
  ['--alert', '--alert-bg'],
  ['--focus', '--card'],
];

const themes = parseThemes(css);
const names = Object.keys(themes);

if (names.length === 0) {
  console.error('No themes found in tokens.css. Has the block syntax changed?');
  process.exit(1);
}

let failures = 0;
let checks = 0;

for (const name of names) {
  const tokens = themes[name];
  console.log(`\ntheme: ${name}`);
  for (const [fg, bg] of PAIRS) {
    const a = resolve(tokens, fg);
    const b = resolve(tokens, bg);
    const r = ratio(a, b);
    checks += 1;
    const floor = fg === '--focus' ? AA_LARGE : AA;
    const ok = r >= floor;
    if (!ok) failures += 1;
    const grade = r >= 7 ? 'AAA' : r >= AA ? 'AA ' : r >= AA_LARGE ? 'AA*' : '   ';
    console.log(
      `  ${ok ? 'pass' : 'FAIL'}  ${grade}  ${r.toFixed(2).padStart(5)}:1  ${fg} on ${bg}`
    );
  }
}

console.log(`\n${checks} pairs checked across ${names.length} themes, ${failures} below floor.`);

if (failures > 0) {
  console.error('Contrast floor breached. Fix the token, do not lower the floor.');
  process.exit(1);
}
