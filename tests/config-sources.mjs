/**
 * EVERYTHING THAT NEEDS THE CONFIGURATION GETS IT THE SAME WAY.
 *
 * This has now failed twice in the same shape.
 *
 * First `wrangler` was imported by three scripts and declared in no
 * dependency list. It worked because the Cloudflare adapter pulled it in, so
 * the build passed here and failed on another machine.
 *
 * Then the node scripts learned to read `.dev.vars` themselves, which meant
 * nobody sourced it into the shell any more — and `supabase/config.toml`
 * substitutes `env(GOOGLE_CLIENT_ID)` from the shell when the containers
 * start. Google answers an empty client id with `invalid_client`, which reads
 * as a broken OAuth setup rather than a missing variable.
 *
 * Both times a consumer was fixed and a different consumer was forgotten. So
 * this enumerates the consumers rather than the fixes:
 *
 *   node scripts      loadDevVars()
 *   the Supabase CLI  scripts/supabase.mjs
 *   the worker        the wrangler binding, which reads .dev.vars itself
 *   CI                secrets, named in the workflow
 *
 * And `.dev.vars.example` is the one list of what exists.
 *
 * Run: npm run test:config-sources
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

const example = fs.readFileSync('.dev.vars.example', 'utf8');

/** Every variable the example documents, commented or not. */
const documented = new Set(
  [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1])
);

/** Things the platform provides rather than things we configure. */
const AMBIENT = new Set([
  'NODE_ENV', 'CI', 'PATH', 'HOME', 'PWD', 'TERM',
  /* Bindings, which come from wrangler.jsonc rather than from a variable. */
  'NOTEBOOK', 'SESSION',
]);

const scriptFiles = fs
  .readdirSync('scripts')
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => path.join('scripts', f));

/* ── Every script reads the file the same way ────────────────────────────── */

for (const file of scriptFiles) {
  const text = fs.readFileSync(file, 'utf8');

  const reads = [...text.matchAll(/process\.env(?:\.|\[')([A-Z][A-Z0-9_]+)/g)]
    .map((m) => m[1])
    .filter((name) => !AMBIENT.has(name));

  if (reads.length === 0) continue;

  test(`${file} loads .dev.vars before reading it`, () => {
    assert.match(
      text,
      /loadDevVars\(\)/,
      'a script that reads configuration must load it, not hope the shell has it'
    );
  });

  test(`${file} reads nothing undocumented`, () => {
    const undocumented = [...new Set(reads)].filter((name) => !documented.has(name));
    assert.deepEqual(undocumented, [], 'add it to .dev.vars.example');
  });
}

/* ── The Supabase CLI ────────────────────────────────────────────────────── */

test('config.toml needs nothing that is undocumented', () => {
  const toml = fs.readFileSync('supabase/config.toml', 'utf8');

  /* Only what is actually in effect. The file ships with a dozen providers
     disabled and a dozen more commented out, each naming a secret nobody has
     to set, and requiring documentation for all of them would make this list
     noise that nobody reads.
     
     Optional keys are excluded by name rather than by rule: Studio works
     without an OpenAI key, and a rule that inferred that would be guessing. */
  const OPTIONAL = new Set(['OPENAI_API_KEY']);

  const active = [];
  for (const block of toml.split(/\n(?=\[)/)) {
    if (!/^\s*enabled\s*=\s*true/m.test(block)) continue;
    for (const line of block.split('\n')) {
      if (line.trim().startsWith('#')) continue;
      for (const m of line.matchAll(/env\(([A-Z][A-Z0-9_]+)\)/g)) active.push(m[1]);
    }
  }

  const undocumented = [...new Set(active)]
    .filter((name) => !OPTIONAL.has(name))
    .filter((name) => !documented.has(name));
  assert.deepEqual(
    undocumented,
    [],
    'the containers substitute these at start, and an empty one fails somewhere else entirely'
  );
});

/* ── The worker ──────────────────────────────────────────────────────────── */

test('the application reads nothing undocumented', () => {
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.(ts|astro)$/.test(entry.name)) out.push(full);
    }
    return out;
  };

  const reads = new Set();
  for (const file of walk('src')) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/env(?:\?)?\.([A-Z][A-Z0-9_]{3,})/g)) {
      if (!AMBIENT.has(m[1])) reads.add(m[1]);
    }
  }

  const undocumented = [...reads].filter((name) => !documented.has(name));
  assert.deepEqual(undocumented, [], 'add it to .dev.vars.example');
});

/* ── CI ──────────────────────────────────────────────────────────────────── */

test('the workflow names every secret it uses', () => {
  const dir = '.github/workflows';
  if (!fs.existsSync(dir)) return;

  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const used = [...text.matchAll(/\$\{\{\s*secrets\.([A-Z][A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);

    for (const name of used) {
      assert.ok(
        documented.has(name) || /^R2_/.test(name),
        `${file} uses ${name}, which is documented nowhere`
      );
    }
  }
});

/* ── And nothing documented is dead ──────────────────────────────────────── */

test('every documented variable is read by something', () => {
  /* A variable in the example that nothing reads is a instruction to set
     something pointless, and the reader cannot tell which. */
  const everywhere = [
    ...scriptFiles.map((f) => fs.readFileSync(f, 'utf8')),
    fs.readFileSync('supabase/config.toml', 'utf8'),
    /* The build's own configuration reads the environment too, and reporting
       a variable as unread because this list stopped at `scripts/` would push
       somebody to delete the documentation for a variable that is doing its
       job. `PUBLIC_SITE_URL` is read here and nowhere else, by design: it is
       the deployment's own origin, needed at build time for canonical tags
       and the sitemap. */
    fs.readFileSync('astro.config.mjs', 'utf8'),
  ];

  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (/\.(ts|astro)$/.test(entry.name)) out.push(fs.readFileSync(full, 'utf8'));
    }
    return out;
  };
  everywhere.push(...walk('src'));

  if (fs.existsSync('.github/workflows')) {
    for (const file of fs.readdirSync('.github/workflows')) {
      everywhere.push(fs.readFileSync(path.join('.github/workflows', file), 'utf8'));
    }
  }

  const haystack = everywhere.join('\n');
  const dead = [...documented].filter((name) => {
    /* Its own definition in the example does not count as a use. */
    const uses = haystack.split(name).length - 1;
    return uses === 0;
  });

  assert.deepEqual(dead, [], 'remove it, or the reader is told to set something pointless');
});

test('nothing is documented twice', () => {
  /* Two entries for one variable means two explanations, and a reader
     following the second may set the wrong thing. */
  const names = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]);
  const twice = names.filter((name, i) => names.indexOf(name) !== i);
  assert.deepEqual([...new Set(twice)], []);
});

console.log(
  `${passed} configuration assertions passed. ${documented.size} variables documented.`
);
