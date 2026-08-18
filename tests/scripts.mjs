/**
 * Every script defines the functions it calls.
 *
 * `seedImages` was called and never defined. An edit anchored on a line that
 * had since been reformatted, the replacement matched nothing, and the file
 * still parsed — so `node -c` passed, every test passed, and the failure
 * arrived at the end of a two-minute reset with everything before it already
 * written.
 *
 * These are plain scripts with no type checking behind them, which makes a
 * missing definition a runtime surprise rather than a build error. This
 * closes that.
 *
 * Run: npm run test:scripts
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

const files = fs
  .readdirSync('scripts')
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => path.join('scripts', f));

/** Anything the language or the runtime provides, which a script need not define. */
const AMBIENT = new Set([
  /* Keywords that can sit immediately before a parenthesis and are not
     calls: `async (code) => {}`, `await (x)`, `delete (y)`. */
  'async', 'await', 'yield', 'delete', 'void', 'in', 'of', 'instanceof',
  'else', 'do', 'try', 'finally', 'case', 'throw', 'new',

  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'require', 'import', 'await', 'new', 'super', 'console', 'JSON', 'Object',
  'Array', 'String', 'Number', 'Boolean', 'Math', 'Date', 'Promise', 'Set',
  'Map', 'Error', 'RegExp', 'Symbol', 'parseInt', 'parseFloat', 'isNaN',
  'encodeURIComponent', 'decodeURIComponent', 'setTimeout', 'clearTimeout',
  'fetch', 'Response', 'Request', 'Headers', 'Blob', 'URL', 'URLSearchParams',
  'TextEncoder', 'TextDecoder', 'Uint8Array', 'ArrayBuffer', 'Buffer',
  'process', 'structuredClone', 'crypto', 'btoa', 'atob', 'queueMicrotask',
]);

/**
 * Strings and comments are prose, and prose contains parentheses.
 *
 * A citation in a seeded reference list — "Managing Cover Crops Profitably
 * (3rd ed.)" — reads as a call to `Profitably` otherwise. Blanking them keeps
 * the offsets and removes the content.
 */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
    .replace(/`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => ' '.repeat(m.length));
}

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const text = code(source);

  /* What this file provides: its own declarations and everything it imports. */
  const provided = new Set(AMBIENT);

  for (const m of text.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)) provided.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g))
    provided.add(m[1]);
  for (const m of text.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g)) provided.add(m[1]);

  /* Imports, both named and default, static and dynamic. */
  for (const m of text.matchAll(/import\s+\{([^}]*)\}\s+from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) provided.add(name);
    }
  }
  for (const m of text.matchAll(/import\s+(\w+)\s+from/g)) provided.add(m[1]);
  for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import/g)) {
    for (const part of m[1].split(',')) provided.add(part.trim());
  }
  /* Destructuring generally, since a script pulls names out of results. */
  for (const m of text.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop()?.trim().split('=')[0].trim();
      if (name) provided.add(name);
    }
  }
  /* Parameters of every function, which are in scope inside it. */
  for (const m of text.matchAll(/function\s+\w+\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split('=')[0].trim().replace(/[{}[\].]/g, '');
      if (name) provided.add(name);
    }
  }
  for (const m of text.matchAll(/\(([^)]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split('=')[0].trim().replace(/[{}[\].]/g, '');
      if (name) provided.add(name);
    }
  }
  for (const m of text.matchAll(/(?:^|[^.\w])(\w+)\s*=>/gm)) provided.add(m[1]);
  /* Loop bindings, which are in scope inside the loop. */
  for (const m of text.matchAll(/for\s*\(\s*(?:const|let|var)\s+(\w+)/g)) provided.add(m[1]);
  for (const m of text.matchAll(/catch\s*\(\s*(\w+)/g)) provided.add(m[1]);
  /* Methods on an object literal, in both spellings. */
  for (const m of text.matchAll(/(\w+)\s*:\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/g)) provided.add(m[1]);
  for (const m of text.matchAll(/(?:^|[,{]\s*)(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm)) provided.add(m[1]);

  /* What it calls, ignoring anything reached through a dot. */
  const called = new Set();
  for (const m of text.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const name = m[2];
    /* A constant in caps is a value, not a call. A bare number is `slice(0,
       3)` and friends: the pattern sees the comma-space as a boundary. */
    if (/^[A-Z_]+$/.test(name)) continue;
    /* A single character is a fragment of something the blanking left
       behind, never a function worth checking. */
    if (name.length < 2) continue;
    called.add(name);
  }

  test(`${file} defines everything it calls`, () => {
    const missing = [...called].filter((name) => !provided.has(name));
    assert.deepEqual(missing, [], 'a call with no definition fails only at run time');
  });
}

/* ── A script that opens a runtime has to close it ───────────────────────── */

test('every script that starts a platform proxy disposes it', () => {
  /* `getPlatformProxy` starts a miniflare runtime with open handles. A script
     that does not dispose it prints everything it was going to print and then
     hangs, which reads as the work having failed when it succeeded.
     
     An `exit` handler does not count: exit is the thing that never happens. */
  const problems = [];

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/getPlatformProxy/.test(text)) continue;

    if (!/\.dispose\(\)/.test(text)) {
      problems.push(`${file} starts a proxy and never disposes it`);
      continue;
    }

    if (/process\.on\(\s*'exit'[\s\S]{0,60}dispose/.test(text)) {
      problems.push(`${file} disposes on 'exit', which never fires`);
    }
  }

  assert.deepEqual(problems, []);
});

/* ── A query that fails should say so ────────────────────────────────────── */

test('no seed script reads data without reading the error beside it', () => {
  /* `select('id, slug, name')` on a table with no `name` column returns an
     error and no rows. A script that destructures only `data` turns that into
     "nothing found", and the seed reported that a school it had just created
     did not exist.
     Only the reads a script then branches on. A lookup whose emptiness is
     already handled — an optional row, a count — is fine to read bare. What
     is not fine is treating "the query failed" and "there is nothing there"
     as the same answer. */
  const problems = [];

  for (const file of files.filter((f) => /seed/.test(f))) {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(/const \{\s*data:\s*(\w+)\s*\}\s*=\s*await db/g)) {
      const name = m[1];
      const after = text.slice(m.index, m.index + 900);

      /* Does it decide something on the basis of the rows being absent? */
      const decides =
        new RegExp(`if\\s*\\(\\s*!${name}\\b`).test(after) ||
        new RegExp(`fail\\(\`?[^)]*\\$\\{?${name}`).test(after) ||
        new RegExp(`!${name}\\?\\.length`).test(after);

      if (decides) {
        const line = text.slice(0, m.index).split('\n').length;
        problems.push(`${file}:${line} branches on ${name} being empty, ignoring the error`);
      }
    }
  }

  assert.deepEqual(problems, [], 'destructure error too, and say something when it is set');
});

test('no seed script writes without checking whether the write worked', () => {
  /* A read that fails looks like an absence. A write that fails looks like
     nothing at all, until the next statement collides with the row that
     should have gone — which is exactly what happened: a `delete()` refused
     by a foreign key, the error dropped, and the following insert hitting a
     unique constraint.
     
     The first version of this test looked for `await db` alone on a line and
     found two of thirteen. */
  const problems = [];

  for (const file of files.filter((f) => /seed|reset/.test(f))) {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(/await db\b/g)) {
      const before = text.slice(0, m.index);
      const line = before.split('\n').length;
      const statement = before.split('\n').pop();
      const after = text.slice(m.index, m.index + 400);

      /* A write, not a read. */
      if (!/\.(insert|update|delete|upsert)\(/.test(after)) continue;

      /* Its result is looked at if it is destructured, or if it is inside
         the `must()` helper, which throws. */
      if (/error/.test(statement)) continue;
      if (/must\(/.test(before.slice(-60))) continue;

      problems.push(`${file}:${line} writes and never looks at the result`);
    }
  }

  assert.deepEqual(problems, [], 'destructure { error }, or wrap it in must()');
});

test('every module a script imports can actually be loaded by node', () => {
  /* Vite resolves `./publish`; node does not, and the seed died on it after
     everything before it had already written. The build passed the whole
     time, because the build never runs these scripts.
   
     Checked by reading the import graph rather than executing, so this stays
     fast and needs no database. */
  const problems = [];
  const seen = new Set();

  /**
   * `import type { X } from './y'` is removed in full before node resolves
   * anything, so the specifier is never a path at run time and the rule
   * below does not apply to it. The inline spelling,
   * `import { type X } from './y'`, is deliberately not exempt: it leaves
   * the statement in place and node does go looking for the file.
   *
   * Without this, pulling a TypeScript module into a script's import graph
   * reports every type-only import inside it as a missing extension, which
   * is a demand for something that would then have to be spelled `.ts` and
   * turned on in tsconfig to satisfy a requirement that was never real.
   */
  const withoutTypeOnly = (text) =>
    text.replace(/^\s*(?:import|export)\s+type\s[^\n]*$/gm, '');

  const walkImports = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);

    const text = withoutTypeOnly(fs.readFileSync(file, 'utf8'));

    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const spec = m[1];
      const resolved = path.resolve(path.dirname(file), spec);

      /* A bare specifier that only Vite can resolve. */
      if (!/\.(ts|mjs|js|json)$/.test(spec)) {
        problems.push(`${file} imports '${spec}' with no extension`);
        continue;
      }

      if (!fs.existsSync(resolved)) {
        problems.push(`${file} imports '${spec}', which is not there`);
        continue;
      }

      walkImports(resolved);
    }
  };

  for (const file of files) walkImports(file);

  assert.deepEqual([...new Set(problems)], [], 'node needs the extension');
});

test('no script reaches a module only Vite can run', () => {
  /**
   * The same fault as the check above, a size larger.
   *
   * `import.meta.glob` is a Vite transform and not a runtime API, so under
   * plain node it is not a function at all — and `import.meta.env` is simply
   * undefined, which throws on the property access. Both have now killed a
   * reset partway through, after seed scripts had already written into a
   * database that had just been dropped. The reset is destructive and not
   * resumable, so the cost is the whole sequence rather than the one import.
   *
   * The resolution is the split the template library already had:
   * `template-resolve.ts` holds the logic and does no I/O, `templates.ts`
   * does the glob for the application, and `template-library.mjs` reads the
   * directory for a script. `org-shape.ts` and `orgs-library.mjs` are that
   * arrangement for organizations.
   *
   * Transitive on purpose. Neither failure was a script calling these
   * directly; both were a script importing a module that did.
   */
  /* A mention inside a comment explaining this rule is not a use, and this
     file and the two modules below contain several. */
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  const VITE_ONLY = [
    ['import.meta.glob', 'a Vite transform, not a function at run time'],
    ['import.meta.env', 'undefined under node, so the property access throws'],
  ];

  const problems = [];
  const seen = new Set();

  const withoutTypeOnly = (text) =>
    text.replace(/^\s*(?:import|export)\s+type\s[^\n]*$/gm, '');

  /* Reported against the script rather than the module, because the script is
     what has to change and the module is usually right to be doing it. */
  const walk = (file, entry, chain) => {
    const key = `${entry}::${file}`;
    if (seen.has(key) || !fs.existsSync(file)) return;
    seen.add(key);

    const text = fs.readFileSync(file, 'utf8');

    for (const [api, why] of VITE_ONLY) {
      /**
       * The API followed by something that makes it a use.
       *
       * `import.meta.glob(` is a call; `import.meta.env.PUBLIC_ORG` and
       * `typeof import.meta.env !== 'undefined'` are reads. Prose naming the
       * API — of which this file and the two modules it points at have
       * several — is followed by an ordinary word and does not match, and
       * comments are stripped before the test regardless. Two independent
       * reasons, because a guard that fires on its own documentation is a
       * guard somebody deletes.
       */
      const escaped = api.replace(/\./g, '\\.');
      const uses = new RegExp(`${escaped}\\s*[(!.\\[]`);

      if (uses.test(stripComments(text))) {
        problems.push(
          `${entry} reaches ${path.relative('.', file)}, which uses ${api} — ${why}` +
            (chain.length ? `\n          via ${chain.join(' -> ')}` : '')
        );
      }
    }

    for (const m of withoutTypeOnly(text).matchAll(/from\s+'(\.[^']+)'/g)) {
      const resolved = path.resolve(path.dirname(file), m[1]);
      if (fs.existsSync(resolved)) walk(resolved, entry, [...chain, path.relative('.', file)]);
    }
  };

  for (const file of files) walk(file, file, []);

  assert.deepEqual(
    [...new Set(problems)],
    [],
    'a script must not import a module that only builds under Vite'
  );
});

test('no test helper swallows an async assertion', () => {
  /* `fn()` without `await` counts an async assertion as passed the moment it
     starts, and a rejection surfaces later as an unhandled promise nothing is
     watching. Four assertions were reporting success without having run, and
     breaking the code they check changed nothing. */
  const problems = [];

  for (const file of fs.readdirSync('tests').filter((f) => f.endsWith('.mjs'))) {
    const text = fs.readFileSync(`tests/${file}`, 'utf8');

    const hasAsync = /await test\(|async \(\) =>/.test(text);
    const awaits = /await fn\(\)/.test(text);
    const defines = /function test\(/.test(text);

    if (defines && hasAsync && !awaits) {
      problems.push(`tests/${file} has async assertions and a helper that does not await`);
    }
  }

  assert.deepEqual(problems, []);
});


test('no suite prints its tally before the last test', () => {
  /* Twice now, appending tests to a file left the `console.log` in the
     middle of it. The new tests ran, failures would still have been
     reported, but the count never moved — so a suite that had grown by four
     said what it said yesterday, which is the same silence as a check that
     does not run.
   
     19.9 already has the rule this belongs to: **a check reports how much it
     read**. A stale count is a false report of that. */
  const problems = [];

  for (const file of fs.readdirSync('tests').filter((f) => f.endsWith('.mjs'))) {
    const full = `tests/${file}`;
    const lines = fs.readFileSync(full, 'utf8').split('\n');

    const tally = lines.findIndex((l) => /console\.log\(`\$\{passed\}/.test(l));
    if (tally < 0) continue;

    const after = lines.slice(tally + 1).findIndex((l) => /^test\(/.test(l));
    if (after >= 0) problems.push(`${full}:${tally + after + 2} runs after the tally`);
  }

  assert.deepEqual(problems, [], 'move the console.log to the end of the file');
});

console.log(`${passed} script assertions passed. ${files.length} scripts read.`);
