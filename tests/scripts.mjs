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
import { migrationSql } from './migrations.mjs';

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
      /* `(` among the stripped characters, for a doubled paren.
      
         `new Promise((resolve) => …` makes the match start at the outer
         paren, so the group is `(resolve` and the parameter was recorded
         under a name nothing could ever call. It reported `resolve`
         undefined in a file that plainly defines it, which reads as a broken
         check rather than a caught fault — and a check that cries wolf is one
         somebody deletes. */
      const name = part.trim().split('=')[0].trim().replace(/[{}[\]().]/g, '');
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

test('the first seed to open a socket waits for the gateway', () => {
  /* `supabase db reset` restarts the containers and returns before they are
     listening. `seed-orgs` is the next thing in `npm run reset` to make a
     request, and without a wait it answered with `TypeError: fetch failed`
     prefixed by whichever organization sorted first — a message that names
     an organization file and says nothing about the gateway.

     Asserted on order, not presence. A wait placed after the client is built
     is still a wait, but the first RPC can already be in flight, so this
     requires it above `createClient`. */
  const text = fs.readFileSync('scripts/seed-orgs.mjs', 'utf8');

  const wait = text.indexOf('requireApi(');
  const client = text.indexOf('createClient(');

  assert.ok(wait !== -1, 'scripts/seed-orgs.mjs must call requireApi()');
  assert.ok(client !== -1, 'scripts/seed-orgs.mjs is expected to build a client');
  assert.ok(
    wait < client,
    'requireApi() must run before the client is built, or the first call races it'
  );
});

test('the cleanup tool never identifies a fixture by the live domain', () => {
  /* **A fixture is a flag, not a namespace.**

     `wipe-demo` deleted every account whose address ended in the fixture
     domain, and everything those accounts made. That was safe for exactly as
     long as the domain was `demo.invalid`, which nobody can register. It is
     `scipath.org` now — a real domain, on purpose, so mail arriving can be
     demonstrated — and the same rule would delete every real account on it.

     `seed-people.mjs` had already written the warning in its own header: its
     advisors sit on an organization's own domain so they read properly in a
     demonstration, and using that namespace as the safe-to-delete rule would
     destroy real people. The domain move turned a documented hazard into a
     live one.

     So: the tool may match `.invalid`, where nothing can ever be real, and
     the flag a seed sets on purpose. It may not match `FIXTURE_DOMAIN`. */
  const wipe = fs.readFileSync('scripts/wipe-demo.mjs', 'utf8');
  const code = wipe.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  assert.doesNotMatch(
    code,
    /FIXTURE_DOMAIN|demo-accounts\.mjs/,
    'wipe-demo must not identify a fixture by the fixture domain'
  );
  assert.match(code, /user_metadata/, 'wipe-demo must identify a fixture by its flag');

  /* And the flag has to be set, or matching on it finds nothing. */
  const seed = fs.readFileSync('scripts/seed-demo.mjs', 'utf8');
  assert.match(
    seed,
    /demo:\s*true/,
    'seed-demo must flag its accounts, or the cleanup tool matches none of them'
  );
});

test('no script shadows a global it then constructs', () => {
  /* `const URL = process.env.PUBLIC_SUPABASE_URL` reads perfectly and makes
     `new URL(...)` later in the same file a TypeError, because the const
     shadows the global constructor. It is not a parse error and no type
     check sees it: the file loads, and it throws on the line that runs.

     `restart-stack.mjs` did exactly this and only failed when the prompt was
     answered, which is the branch a quick smoke test does not reach.

     Narrow on purpose. This is not a general shadowing rule; it is the pair
     that bit, and a rule wide enough to cover every global would report
     every local named `Response` in a project that never constructs one. */
  const GLOBALS = ['URL', 'Response', 'Request', 'Headers', 'Date', 'Error'];
  const problems = [];

  /* A mention inside a comment is not a declaration, and the comment above
     this rule contains both halves of the pair it refuses. */
  const bare = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  for (const file of files) {
    const text = bare(fs.readFileSync(file, 'utf8'));

    for (const name of GLOBALS) {
      const declared = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`).test(text);
      const constructed = new RegExp(`\\bnew\\s+${name}\\s*\\(`).test(text);

      if (declared && constructed) {
        problems.push(`${file} declares ${name} and also calls new ${name}()`);
      }
    }
  }

  assert.deepEqual(problems, [], 'rename the local, or the constructor is shadowed');
});

test('nothing spells out a nudge kind except the one place that owns them', () => {
  /* **Two names for one event, written in three places.**

     `nudge` picks its template from what the recipient is, so a nudge to an
     Elder is written as `nudge_officer`. `nudge_state` filtered
     `kind = 'nudge'` alone, so the case a teacher uses most was sent
     successfully and counted nowhere: the button came back unchanged and read
     as a button that does not work.

     `app.nudge_kinds()` is the list. A literal anywhere else is a fourth
     place for a third template to be forgotten — and this is a failure with
     no error, on a screen whose whole job is to show that something happened. */
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');

  /* Comments explaining the rule name both kinds, which is the point of them. */
  const code = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' ');

  const owner = code.indexOf('function app.nudge_kinds()');
  assert.ok(owner !== -1, 'app.nudge_kinds() must exist');

  /* Everything except the function that defines them. */
  const elsewhere = code.slice(0, owner) + code.slice(code.indexOf('$$;', owner));

  assert.doesNotMatch(
    elsewhere,
    /'nudge_officer'/,
    "the nudge kinds belong in app.nudge_kinds(), not spelled out"
  );
});

test('the readiness failure asks Docker rather than guessing', () => {
  /* The first version of this message said a container had not come back,
     which assumes containers existed. They did not: the stack had never been
     started, `db reset` recreates only the database, and the message sent
     somebody to restart something that was not running.

     A wrong diagnosis is worse than none, so the failure path has to consult
     Docker. Asserted on the import rather than the wording, because the
     wording will change and the consultation must not. */
  const text = fs.readFileSync('scripts/api-ready.mjs', 'utf8');

  assert.match(
    text,
    /supabaseContainers/,
    'the failure path must ask which containers exist, not assume'
  );
  assert.match(
    text,
    /db:start/,
    'it must name the command that fixes the commonest case'
  );

  /* A hardcoded container name is wrong the moment the directory is renamed,
     and `no such container` reads as the diagnosis being broken. */
  assert.doesNotMatch(
    text,
    /docker logs supabase_\w+_\w+/,
    'name the container from what Docker reported, not from a literal'
  );
});

test('the Supabase wrapper asks about Docker before it spawns anything', () => {
  /* The local stack is containers. Without a daemon the CLI answers with the
     socket path it could not open, which reads as a broken path and is
     almost always Docker Desktop being closed — a morning went to that once.
     `scripts/docker.mjs` asks the question first and says the answer.

     Asserted on the wrapper rather than on the helper, because a helper
     nothing calls is the failure this is guarding against. Order matters as
     much as presence: a check that runs after `spawn` is a check that never
     runs, so this reads positions rather than just looking for the name. */
  const text = fs.readFileSync('scripts/supabase.mjs', 'utf8');

  const guard = text.indexOf('requireDocker()');
  const spawned = text.indexOf('spawn(');

  assert.ok(guard !== -1, 'scripts/supabase.mjs must call requireDocker()');
  assert.ok(spawned !== -1, 'scripts/supabase.mjs is expected to spawn the CLI');
  assert.ok(
    guard < spawned,
    'requireDocker() must run before the CLI is spawned, or the CLI reports first'
  );

  /* **And not for a command that targets the hosted project.**

     The pre-flight ran unconditionally on the reasoning that every command
     routed through this file needs the local stack. That reasoning read the
     command list off `package.json` and missed `reset-cloud.mjs`, which
     spawns this file for `db reset --linked` — a command that needs no
     container. A cloud reset stopped after its confirmation with a message
     about starting Docker Desktop.

     `--linked` is the CLI's own word for the remote project, so this is not
     a list of exempt subcommands that grows a case each time somebody
     forgets one. It is the same fact the CLI itself reads. */
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  assert.match(
    code,
    /--linked[\s\S]{0,120}requireDocker\(\)/,
    'the Docker pre-flight must be skipped for a --linked command'
  );
});

test('the cloud reset does not ask for a container it does not need', () => {
  /* Asserted from the caller's side as well, because the two files have to
     agree and only one of them was checked. `reset-cloud` passing something
     other than `--linked` would walk straight past the condition above while
     that condition still reads correctly on its own. */
  const cloud = fs.readFileSync('scripts/reset-cloud.mjs', 'utf8');
  const spawnsLocal = /supabase\.mjs'[^\]]*\]/g;

  for (const call of cloud.match(spawnsLocal) ?? []) {
    assert.match(
      call,
      /--linked/,
      `reset-cloud spawns the CLI without --linked: ${call.trim()}`
    );
  }
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

test('the production ref is one value, not four copies', () => {
  /**
   * Four scripts refuse to run against production by naming its project ref,
   * and each holds its own copy of the string.
   *
   * The project was recreated in a different region, and every one of those
   * copies went on naming a project that no longer exists — four guards that
   * could not fire, saying nothing, because a guard only reports when it
   * stops something. The loopback check beside them still held, which is the
   * only reason this was harmless.
   *
   * Checking they agree rather than checking the value: the ref changes when
   * a project is recreated, and a test that hardcodes it is the fifth copy.
   */
  const holders = files.filter((f) => /const PRODUCTION_REF = /.test(fs.readFileSync(f, 'utf8')));

  /* There is one now, and this used to insist on several.
  
     The test was written when four scripts each named the ref, and it checked
     that the four agreed — the best available answer while there were four.
     They are one: `scripts/fixture-target.mjs` holds it and the scripts that
     need it import it. So the assertion inverts. Insisting on several would
     mean a test failing because the thing it was written to prevent had been
     made impossible, which is how a guard outlives what it guarded. */
  assert.ok(
    holders.length <= 1,
    `the ref is defined in ${holders.length} places: ${holders
      .map((f) => path.relative('.', f))
      .join(', ')}`
  );

  /* And nothing else writes the value out. A literal ref anywhere is a fifth
     copy that will go on naming a project that no longer exists — silently,
     because a guard only reports when it stops something. */
  const defined = holders.length
    ? fs.readFileSync(holders[0], 'utf8').match(/const PRODUCTION_REF = '([^']*)'/)?.[1]
    : null;

  if (!defined) return;

  const literals = files.filter(
    (f) => !holders.includes(f) && fs.readFileSync(f, 'utf8').includes(defined)
  );

  assert.deepEqual(
    literals.map((f) => path.relative('.', f)),
    [],
    'import PRODUCTION_REF rather than writing it out again'
  );
});

test('the cloud reset empties every table the migration creates', () => {
  /**
   * `reset-cloud.mjs` names the tables it empties, in an order the foreign
   * keys dictate. A table missing from that list is not an error at run time:
   * it is simply never emptied, and the next seed collides with rows nobody
   * expected to still be there.
   *
   * My first version of that list, written from memory, named two tables that
   * do not exist and missed twelve that do — which is the argument for
   * checking it against the schema rather than reading it carefully.
   *
   * `organizations` is excluded deliberately and named here so that the
   * exclusion is a decision rather than an omission.
   */
  const sql = migrationSql();
  const inSchema = new Set([...sql.matchAll(/^create table public\.(\w+) \(/gm)].map((m) => m[1]));

  assert.ok(inSchema.size > 20, `read only ${inSchema.size} tables — widen the pattern`);

  const script = fs.readFileSync('scripts/reset-cloud.mjs', 'utf8');
  const block = script.match(/const TABLES = \[([\s\S]*?)\];/)?.[1];

  assert.ok(block, 'could not find TABLES in reset-cloud.mjs');

  const listed = new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));

  const KEPT = new Set(['organizations']);

  const missing = [...inSchema].filter((t) => !listed.has(t) && !KEPT.has(t));
  const invented = [...listed].filter((t) => !inSchema.has(t));

  assert.deepEqual(missing, [], 'these tables would never be emptied');
  assert.deepEqual(invented, [], 'these are not tables in the migration');

  /**
   * And `organizations` cannot be reached by the cascade.
   *
   * The script says it leaves that table alone, and `truncate ... cascade`
   * reaches any table holding a foreign key *into* one being truncated. A
   * column added to `organizations` that pointed at, say, a user would make
   * the comment a lie and empty the one table an interrupted reset is
   * supposed to leave coherent.
   */
  const orgBody = sql.match(/create table public\.organizations \(([\s\S]*?)\n\);/)?.[1];

  assert.ok(orgBody, 'could not find create table public.organizations');

  assert.deepEqual(
    [...orgBody.matchAll(/references public\.(\w+)/g)].map((m) => m[1]),
    [],
    'organizations now references another table, so the cascade would empty it too'
  );
});

test('no script deletes from a table the schema revokes DELETE on', () => {
  /**
   * Twice in one session a script was written against a privilege the
   * migration deliberately withholds.
   *
   * Nothing in this system is hard deleted — removal is a state column or an
   * `archived_at` — so DELETE is revoked from `authenticated` and
   * `service_role` on every table, and granted back on exactly two. A script
   * using the secret key holds `service_role` and is bound by that.
   *
   * **Both instances were invisible until they ran.** `reset-cloud.mjs` failed
   * on its first statement against a real project. `seed-programs.mjs` had a
   * delete that could only execute on a second seed against a database
   * somebody had kept, so `npm run reset` — which always starts empty — never
   * reached it, and it sat wrong for months.
   *
   * A source check catches both, which is the argument for one: the run that
   * would expose them is rare and expensive.
   */
  const sql = migrationSql();

  /* A delete named in a comment explaining why it is not done is not a
     delete, and this file's own scripts now contain several. */
  const withoutComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  /* Granted back after the blanket revoke. Order matters in the file and so
     it does here: a table revoked and then granted is allowed. */
  const allowed = new Set(
    [...sql.matchAll(/grant delete on ([^;]+?) to ([^;]+);/g)]
      .filter((m) => /service_role/.test(m[2]))
      .flatMap((m) => [...m[1].matchAll(/public\.(\w+)/g)].map((t) => t[1]))
  );

  assert.ok(
    /revoke delete on all tables in schema public/.test(sql),
    'the blanket revoke is gone — this check no longer describes the schema'
  );

  const problems = [];

  for (const file of files) {
    const text = withoutComments(fs.readFileSync(file, 'utf8'));

    /* `.from('x')` followed by `.delete(` before the statement ends. Written
       across lines in every real instance, so the gap is permissive. */
    for (const m of text.matchAll(/\.from\(\s*'(\w+)'\s*\)[\s\S]{0,200}?\.delete\(/g)) {
      if (!allowed.has(m[1])) {
        problems.push(
          `${path.relative('.', file)} deletes from ${m[1]}, which revokes DELETE from service_role`
        );
      }
    }
  }

  assert.deepEqual(
    [...new Set(problems)],
    [],
    'say what is in the way instead, or grant DELETE deliberately in the migration'
  );
});

test('every table below the blanket grant names service_role', () => {
  /**
   * `grant ... on all tables in schema public` covers what exists at that
   * point in the file and nothing declared after it. The migration says so in
   * a comment, added after two tables were found to have received nothing.
   *
   * Eighteen tables are declared below that line. Seventeen name
   * `service_role` in a grant of their own; `step_warnings` named only
   * `authenticated`, and had since it was written. **A missing grant is
   * silent** — the interface uses `authenticated` and worked perfectly, and
   * the gap surfaced only when a script holding the secret key tried to count
   * the rows, as an empty error message from a tool three files away.
   *
   * Checked here rather than in the database suite because it is a fact about
   * the file: the suite applies the migration as the owner, who needs no
   * grant, so nothing it does would ever notice.
   */
  const sql = migrationSql();

  const blanket = sql.indexOf('grant select, insert, update on all tables in schema public');
  assert.ok(blanket > 0, 'the blanket grant is gone — this check no longer describes the schema');

  /* Every `grant ... to ... service_role;` statement, and the tables it
     names. Split on the semicolon because these run across lines, and with
     comments removed first — a comment sits above most of these grants, and
     leaving it in means the chunk does not begin with the word `grant`. My
     first version of this check missed two grants for exactly that reason and
     reported two false positives, which is the same class of fault as the
     thing it is looking for. */
  const bare = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*--.*$/gm, ' ');

  const granted = new Set(
    bare
      .split(';')
      .filter((statement) => /^\s*grant\b/i.test(statement) && /service_role/.test(statement))
      .flatMap((statement) => [...statement.matchAll(/public\.(\w+)/g)].map((m) => m[1]))
  );

  const below = [...sql.matchAll(/create table public\.(\w+) \(/g)]
    .filter((m) => m.index > blanket)
    .map((m) => m[1]);

  assert.ok(below.length > 5, `found only ${below.length} tables below the grant — widen the pattern`);

  assert.deepEqual(
    below.filter((t) => !granted.has(t)),
    [],
    'these are unreachable with the secret key; grant them explicitly'
  );
});

test('the two resets seed the same things in the same order', () => {
  /* Two chains describe the same rebuild — `npm run reset` in package.json
     for the local stack, `SEEDS` in reset-cloud.mjs for the project — and
     nothing compared them. A seed added to one is a seed the other silently
     does without, and the way that surfaces is a demonstration missing its
     cast rather than an error.
  
     Only the seeds they share are compared. The local chain also runs the
     scenarios, the cases, publishing and the search index, all of which
     refuse a non-loopback target by design. What must agree is the order of
     the four that run in both, because `seed-programs` grants scoped officer
     roles to accounts `seed-demo` has already created. */
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const cloud = fs.readFileSync('scripts/reset-cloud.mjs', 'utf8');

  /* Every seed the local reset runs. It used to be four — the ones the cloud
     happened to have — which meant the test could only catch a divergence
     among those and said nothing about the four it did not run. The cloud
     runs all of them now, into the demonstration tenant, so the comparison
     is the whole chain. */
  const SHARED = [
    'seed-orgs',
    'seed-demo',
    'seed-programs',
    'seed-scenarios',
    'seed-cases',
    'seed-people',
    'seed-publish',
  ];
  const order = (text) =>
    [...text.matchAll(/scripts\/(seed-[a-z]+)\.mjs/g)]
      .map((m) => m[1])
      .filter((name) => SHARED.includes(name))
      .filter((name, i, all) => all.indexOf(name) === i);

  const local = order(pkg.scripts.reset);
  const block = cloud.slice(cloud.indexOf('const SEEDS = ['));

  assert.deepEqual(
    order(block),
    local,
    'the cloud reset seeds a different set, or in a different order, than npm run reset'
  );

  assert.ok(local.length === SHARED.length, `npm run reset no longer runs ${SHARED.join(', ')}`);

  /* The index is not a seed and does not match the pattern above, so it is
     checked on its own. A cloud reset that leaves it out gives the
     demonstration a showcase whose search finds nothing. */
  assert.match(pkg.scripts.reset, /index-records/, 'the local reset indexes what it published');
  assert.match(cloud, /index-records\.mjs', '--remote'/, 'and so does the cloud reset');
});

test('one rule about where fixtures may be written, and one set of names', () => {
  /* Three scripts invent people, and each carried its own copy of both
     facts. The copies had already drifted: `seed-demo` grew an
     `--allow-remote` escape while the other two kept a flat refusal, and
     `seed-cases` had a prefix map with three schools in it where `seed-demo`
     had four — so a case seeded against the fourth looked up
     `undefined_student9`, found nobody, and made a project with no author.
  
     Neither drift was visible until it ran. */
  const inventors = ['scripts/seed-demo.mjs', 'scripts/seed-scenarios.mjs', 'scripts/seed-cases.mjs'];

  for (const file of inventors) {
    const text = fs.readFileSync(file, 'utf8');

    assert.match(text, /fixtureTarget\(/, `${file} decides for itself where fixtures may go`);
    assert.doesNotMatch(
      text,
      /127\\\.0\\\.0\\\.1/,
      `${file} carries its own copy of the loopback test`
    );
    assert.doesNotMatch(
      text,
      /montavista: '/,
      `${file} carries its own copy of the prefix map`
    );
  }

  /* And the shared one is the only place either is stated. */
  const shared = fs.readFileSync('scripts/fixture-target.mjs', 'utf8');
  assert.match(shared, /export const FIXTURE_PREFIX/);
  assert.match(shared, /export function fixtureTarget/);
  assert.match(shared, /org\.demo === true/, 'and it decides on the flag, not on a list');
});

test('the cases do not name the schools they are seeded into', () => {
  /* `seedSchool('montavista')` and `seedSchool('svslc')` were written out,
     which was fine while the only target was a laptop holding every school.
     The demonstration tenant is the only school that may receive invented
     people in the deployed project, so the list has to be something a run
     can state. */
  const cases = fs.readFileSync('scripts/seed-cases.mjs', 'utf8');

  assert.doesNotMatch(cases, /seedSchool\('/, 'the schools come from the environment');
  assert.match(cases, /DEMO_ORGS/, 'which is what names them');

  /* A case wanting a co-author at a school this run did not seed is skipped
     rather than written with one author and a summary describing two. */
  assert.match(cases, /elsewhere\.has\(c\.with\.school\)/, 'and an absent partner skips its case');
});

test('the files go where the rows go', () => {
  /* Three scripts write into the notebook bucket and only `index-records`
     could reach the real one. The other two called `getPlatformProxy`
     unconditionally, so a cloud seed wrote its showcase images into
     `.wrangler` on the machine that ran it, said "written to local file
     storage", and left the demonstration with a showcase full of nothing.
     Nothing failed, which is what made it expensive.
  
     The Supabase target decides, because asking somebody to keep a second
     flag in agreement with the first is asking for the run where they do
     not. */
  const writers = [
    'scripts/seed-scenarios.mjs',
    'scripts/seed-publish.mjs',
    'scripts/index-records.mjs',
  ];

  for (const file of writers) {
    const text = fs.readFileSync(file, 'utf8');

    assert.match(text, /openBucket\(/, `${file} has to ask which bucket`);
    /* The call, not the name. Two of these explain in a comment why the
       proxy has to be disposed, which is worth keeping and is not a use of
       it. A test that cannot tell prose from code deletes the prose. */
    assert.doesNotMatch(
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, ''),
      /getPlatformProxy/,
      `${file} reaches for the local bucket directly`
    );
  }

  const shared = fs.readFileSync('scripts/notebook-bucket.mjs', 'utf8');
  assert.match(shared, /const wantRemote = remote \?\? !isLoopback/, 'the target decides');
  assert.match(shared, /R2_ACCOUNT_ID/, 'and a remote run needs the credentials named');
});

test('a seed signs in only as somebody invented', () => {
  /* `actingAs` refused any target but the local stack, which was the same
     rule as everywhere else until the demonstration tenant moved into the
     deployed project — and then it stopped a seed halfway, after the
     projects were already written.
  
     The target was the wrong thing to check. What matters is whose session
     it is, and a fixture address ends in a reserved domain that resolves
     nowhere and that no real person can hold. */
  const actAs = fs.readFileSync('scripts/act-as.mjs', 'utf8');

  assert.match(actAs, /demo\.invalid/, 'the fixture domain is the check');
  assert.match(actAs, /email\.endsWith/, 'and it is made against the address');
  assert.doesNotMatch(
    actAs,
    /127\\\.0\\\.0\\\.1/,
    'the target is not what decides who may be signed in as'
  );
});

test('a seed names the school it seeded, not the one it was written for', () => {
  /* Both of these print a block at the end telling somebody what to try and
     who to sign in as, and both had it written out: `mv_student9`,
     `montavista.localhost:4321`. True of every run until there was more than
     one school to seed into, and then it named accounts that do not exist at
     a host nobody is testing.
  
     `seed-scenarios` was fixed and its neighbor was not, which is the
     argument for checking both rather than the one that was noticed. */
  for (const file of ['scripts/seed-scenarios.mjs', 'scripts/seed-cases.mjs']) {
    const code = fs
      .readFileSync(file, 'utf8')
      /* Comments quote the names they removed, and explaining a fix is not
         committing it again. */
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\*.*$/gm, '');

    assert.doesNotMatch(code, /\bmv_\w+/, `${file} names a Monta Vista fixture`);
    assert.doesNotMatch(code, /\bsvs_\w+/, `${file} names an SVSLC fixture`);
    assert.doesNotMatch(code, /localhost:4321/, `${file} names a laptop's address`);
  }
});

test('addresses are built when asked, not when the module loaded', () => {
  /* An ES import is evaluated before any statement in the file that imports
     it, so a module capturing `process.env` at the top was read before
     `loadCloudVars()` ran and never saw `.cloud.vars`. That is how the cloud
     reset printed `http://demo.localhost:4321/auth/callback/` as the redirect
     URL to register in a production dashboard — and printed it beside a check
     on the same variable that passed, which is a fix that changes nothing
     sitting next to the thing it failed to fix. */
  const deployment = fs.readFileSync('src/lib/deployment.ts', 'utf8');

  assert.match(deployment, /function currentRootDomain\(\)/, 'the domain is read by a function');

  for (const fn of ['originFor', 'apexOrigin']) {
    const body = deployment.slice(deployment.indexOf(`export function ${fn}`));
    assert.match(
      body.slice(0, body.indexOf('}')),
      /currentRootDomain\(\)/,
      `${fn} has to ask again rather than close over the import-time value`
    );
  }

  /* And the cloud reset refuses to act at all when the value is a laptop's,
     before anything is dropped rather than in its last line of output. */
  const cloud = fs.readFileSync('scripts/reset-cloud.mjs', 'utf8');
  assert.match(cloud, /PUBLIC_ROOT_DOMAIN is \$\{domain/, 'and says so up front');
});

test('the sender has words for every kind that is enqueued', () => {
  /* Nine kinds have been enqueued since the outbox was written and nothing
     turned any of them into a sentence — `platform.ts` was named in the
     schema's own comment and did not exist, which is why nothing has ever
     been sent.
  
     A kind with no entry is not a crash: the drain marks it skipped. But it
     is a message nobody wrote, and it should fail here rather than be
     discovered as silence. */
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');
  const platform = fs.readFileSync('src/lib/notify/platform.ts', 'utf8');

  /* Read from the insert statements themselves, not from the whole file.
     Matching `values (v_org, '...'` anywhere collected `active`, `pending`
     and every other literal that happens to sit in that position in some
     other table's insert. */
  const enqueued = new Set();

  for (const at of [...sql.matchAll(/insert into public\.notifications/g)]) {
    const block = sql.slice(at.index, at.index + 900);
    const stop = block.indexOf('on conflict');
    const body = stop === -1 ? block : block.slice(0, stop);

    for (const m of body.matchAll(/then '([a-z_]+)' else '([a-z_]+)' end/g)) {
      enqueued.add(m[1]);
      enqueued.add(m[2]);
    }
    for (const m of body.matchAll(/select v_org,\s*\n?\s*'([a-z_]+)'/g)) enqueued.add(m[1]);
    for (const m of body.matchAll(/values \(v_org, '([a-z_]+)'/g)) enqueued.add(m[1]);
  }

  assert.ok(enqueued.size >= 5, `read only ${enqueued.size} kinds — widen the pattern`);

  const written = new Set(
    [...platform.matchAll(/^  ([a-z_]+): \(m\) => \(\{/gm)].map((m) => m[1])
  );

  const unwritten = [...enqueued].filter((k) => !written.has(k)).sort();
  assert.deepEqual(unwritten, [], 'these are queued and have no message written for them');
});

test('the send window is tight, and widening it is deliberate', () => {
  /* A queue that has been filling since the outbox was written would, on its
     first drain, mail everybody a year of arrears. Anything older than the
     window is marked skipped and stays in the table as a decision rather
     than being sent or lost. */
  const drain = fs.readFileSync('src/lib/notify/drain.ts', 'utf8');
  const send = fs.readFileSync('scripts/send.mjs', 'utf8');

  const minutes = Number(drain.match(/SINCE_MINUTES = (\d+)/)?.[1]);
  assert.ok(minutes > 0 && minutes <= 120, `the default window is ${minutes} minutes`);

  assert.match(send, /--send/, 'and sending is opt in');
  assert.match(drain, /dryRun = false/, 'with looking as the default');
});

test('the Worker has somewhere for a cron trigger to arrive', () => {
  /* The adapter's default entry exports `fetch` and nothing else, so a cron
     trigger had nowhere to land. `src/worker.js` wraps that entry rather
     than replacing it — the request handling it performs is internal to the
     adapter, and a copy of it here would be a second copy to keep in step
     through every upgrade. */
  const worker = fs.readFileSync('src/worker.js', 'utf8');
  const config = fs.readFileSync('astro.config.mjs', 'utf8');

  assert.match(worker, /scheduled: async \(event, env, context\)/, 'the handler has to exist');
  assert.match(worker, /astroExports\(manifest\)/, 'and delegate fetch to the adapter');
  assert.match(config, /workerEntryPoint: \{ path: 'src\/worker\.js' \}/, 'and be pointed at');

  /* `waitUntil`, not an awaited call. Cloudflare ends the invocation when the
     handler returns, and a drain still sending at that moment leaves messages
     marked claimed and never delivered. */
  assert.match(worker, /context\.waitUntil\(/, 'the work has to outlive the handler');
});

test('the cron schedule is one somebody chose', () => {
  /* Nothing in the outbox has ever been sent. A trigger firing on deploy
     would make the first real send an unattended one, so the schedule is a
     year out and changing it is a deliberate act.
  
     Also: a schedule sparser than the send window skips messages as stale
     rather than sending them late, so the two are checked against each
     other rather than each being plausible alone. */
  const raw = fs.readFileSync('wrangler.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const config = JSON.parse(raw);

  assert.ok(Array.isArray(config.triggers?.crons), 'wrangler has to declare the trigger');
  assert.equal(config.triggers.crons.length, 1, 'one schedule, so there is one thing to reason about');

  const [minute, hour, day, month] = config.triggers.crons[0].split(' ');
  const yearly = day !== '*' && month !== '*';

  const drain = fs.readFileSync('src/lib/notify/drain.ts', 'utf8');
  const windowMinutes = Number(drain.match(/SINCE_MINUTES = (\d+)/)?.[1]);

  if (!yearly) {
    const everyN = minute.startsWith('*/') ? Number(minute.slice(2)) : hour === '*' ? 60 : 1440;
    assert.ok(
      everyN <= windowMinutes,
      `the trigger runs every ${everyN} minutes and the send window is ${windowMinutes}`
    );
  }
});

test('a claimed message is held, not left for the next drain', () => {
  /* The first version claimed with `for update skip locked` and handed rows
     back still `pending`, with a comment asserting that this prevented two
     drains sending the same message. It does not: the lock ends when the
     claim's transaction returns, which is before anything has been sent.
  
     A rule asserted in a comment while enforcing nothing is the failure
     19.9 keeps collecting, and this one was mine. */
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');
  const drain = fs.readFileSync('src/lib/notify/drain.ts', 'utf8');

  assert.match(sql, /'pending', 'processing', 'sent', 'failed', 'skipped'/,
    'the outbox needs a state for a message somebody is sending');
  assert.match(sql, /claim_token   uuid/, 'and a token saying who holds it');
  assert.match(sql, /claimed_until timestamptz/, 'and a lease, so a crash is recoverable');

  /* Settling requires the token back. Without that, a drain whose lease was
     recovered can still mark as sent a message another drain is sending. */
  assert.match(sql, /and claim_token = p_token/, 'settling has to require the claim');
  assert.match(drain, /row\.claim_token/, 'and the sender has to carry it');
});

test('a link in an email is not scipath.scipath.org', () => {
  /* `subdomain || '.' || root` is right for every school and produces
     `scipath.scipath.org` for the one tenant whose subdomain is the root.
     It is a broken link, in an email, to somebody who cannot get back. */
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');

  assert.match(sql, /is_platform     boolean not null default false/,
    'the database has to know which tenant is the apex');
  assert.match(
    sql,
    /case when o\.is_platform then '' else o\.subdomain \|\| '\.' end/,
    'and the address builder has to ask'
  );
});

test('nothing compares a column against a value it cannot hold', () => {
  /* Both publication functions tested `affiliation_state = 'verified'`, and
     the column allows `unverified`, `domain_verified`, `mentor_verified` and
     `lapsed`. It was false for everybody, always: every published author was
     marked unverified, and nothing surfaced it because a check constraint
     cannot see a literal in a comparison and nothing else read the flag.
  
     Checked here rather than in the DB suite. A behavioral test would have to
     construct a verified author, a project with no record, and a publication
     — and my first attempt at one passed with the bug still in place, which
     is worse than no test at all. Reading the constraint and then reading
     every comparison against it cannot pass for the wrong reason. */
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');

  const allowed = new Set(
    (sql.match(/check \(affiliation_state in\s*\n?\s*\(([^)]*)\)/)?.[1] ?? '')
      .split(',')
      .map((v) => v.trim().replace(/'/g, ''))
      .filter(Boolean)
  );

  assert.ok(allowed.size >= 3, `read only ${allowed.size} states — widen the pattern`);

  const compared = [
    ...sql.matchAll(/affiliation_state\s*(?:=|in)\s*\(?\s*'([a-z_]+)'/g),
  ].map((m) => m[1]);

  const impossible = [...new Set(compared)].filter((v) => !allowed.has(v));
  assert.deepEqual(impossible, [], 'compared against values the column cannot hold');
});

console.log(`${passed} script assertions passed. ${files.length} scripts read.`);
