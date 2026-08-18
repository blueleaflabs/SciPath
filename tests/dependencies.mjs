/**
 * Every package we import is declared.
 *
 * `wrangler` was imported by three scripts and appeared in no dependency
 * list. It worked because `@astrojs/cloudflare` pulls it in, and a transitive
 * dependency is not a promise: a different resolution, a newer adapter, or a
 * clean install on somebody else's machine and it is gone.
 *
 * That is exactly what happened — the build worked here and failed there.
 * This catches it at the point where the import is added rather than at the
 * point where somebody else clones the repository.
 *
 * Run: npm run test:deps
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

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);

/** The bit before the first slash, or the scope and name for a scoped one. */
function packageOf(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function walk(dir, extensions) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, extensions));
    else if (extensions.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const files = [
  ...walk('src', ['.ts', '.astro', '.mjs']),
  ...walk('scripts', ['.mjs']),
  ...walk('tests', ['.mjs']),
];

const imports = new Map();

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const patterns = [
    /from\s+'([^']+)'/g,
    /import\s*\(\s*'([^']+)'\s*\)/g,
    /require\(\s*'([^']+)'\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      /* Relative paths, Node builtins, and Astro's virtual modules are not
         packages. */
      if (
        specifier.startsWith('.') ||
        specifier.startsWith('/') ||
        specifier.startsWith('node:') ||
        specifier.startsWith('astro:')
      ) {
        continue;
      }
      const name = packageOf(specifier);
      if (!imports.has(name)) imports.set(name, file);
    }
  }
}

test('every imported package is in package.json', () => {
  const missing = [...imports.entries()].filter(([name]) => !declared.has(name));
  assert.deepEqual(
    missing.map(([name, where]) => `${name} (imported by ${where})`),
    [],
    'a transitive dependency is not a promise'
  );
});

test('wrangler in particular, since the scripts need it directly', () => {
  /* getPlatformProxy is how the seeder and the indexer reach the local R2
     bucket. It arrives with the Cloudflare adapter today and that is not
     something to rely on. */
  assert.ok(declared.has('wrangler'), 'wrangler must be declared, not inherited');
});

test('nothing is declared twice', () => {
  const both = Object.keys(pkg.dependencies ?? {}).filter(
    (name) => name in (pkg.devDependencies ?? {})
  );
  assert.deepEqual(both, [], 'a package in both lists resolves unpredictably');
});

/* ── Everything gets the configuration the same way ──────────────────────── */

test('no script calls the Supabase CLI without loading .dev.vars first', () => {
  /* `supabase/config.toml` substitutes `env(GOOGLE_CLIENT_ID)` when the
     containers start, reading the shell. The node scripts learned to read
     `.dev.vars` themselves, so sourcing it stopped being a habit — and the
     CLI, which nothing had taught, began receiving an empty client id.
     Google answers an empty client id with `invalid_client`, which reads as a
     broken OAuth setup rather than a missing variable.
     
     The lesson is narrower than "read the file": everything that needs the
     configuration has to get it the same way, including the things that are
     not ours. */
  const offenders = Object.entries(pkg.scripts ?? {})
    .filter(([, command]) => /(?:^|&&\s*)(?:npx\s+)?supabase\s/.test(command))
    .map(([name]) => name);

  assert.deepEqual(
    offenders,
    [],
    'route it through scripts/supabase.mjs, which loads .dev.vars first'
  );
});

test('the runner exists and loads the variables', () => {
  const runner = fs.readFileSync('scripts/supabase.mjs', 'utf8');
  assert.match(runner, /loadDevVars/);
  assert.match(runner, /GOOGLE_CLIENT_ID/, 'it should name what is missing');
});

console.log(`${passed} dependency assertions passed. ${imports.size} packages imported.`);
