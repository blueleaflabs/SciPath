/**
 * NOTHING IS USED BEFORE IT IS DECLARED.
 *
 * `seed-scenarios.mjs` read `entry.id` seventy lines above the `const entry`
 * that creates it. The file parses, `node --check` passes, every other test
 * passes, and the failure arrives two minutes into a reset with the schema
 * rebuilt, storage emptied, forty-two accounts written and seven programs
 * seeded — as `Cannot access 'entry' before initialization`, which names the
 * variable and not the line that reads it.
 *
 * That is the same shape as the temporal dead zone that shipped in page
 * frontmatter and broke the entry page for every visitor. A `const` is
 * hoisted into its block and left uninitialised, so a read above it is a
 * runtime error rather than a syntax error, and nothing that only reads the
 * file will see it.
 *
 * `tests/scripts.mjs` was written for a neighbouring bug — a function called
 * and never defined — and cannot catch this one, because `entry` *is*
 * defined. What is wrong is where.
 *
 * This parses rather than pattern matches. A regular expression cannot tell
 * a read above a declaration from a read inside a callback that runs after
 * it, and a check that reports something correct as broken is worse than no
 * check, because the next real report is the one nobody believes.
 *
 * The rule, stated exactly:
 *
 *   a read of a `let`, `const`, or `class` binding, lexically before the
 *   declaration, in the same scope or a block nested inside it, with no
 *   function boundary in between
 *
 * The last clause is what keeps it honest. A function may close over a
 * binding declared after it, because what matters is when it is called:
 *
 *   const show = () => total;   // legal. `total` exists by the time it runs
 *   const total = 4;
 *   show();
 *
 * Run: npm run test:tdz
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { stripTypeScriptTypes } from 'node:module';

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

function walkFiles(dir, extensions) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, extensions));
    else if (extensions.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

/* ── Scopes ───────────────────────────────────────────────────────────────
 *
 * A lexical declaration belongs to the block it is written in, so a scope
 * can be filled from the statements directly inside it without descending.
 * `var` and function declarations are hoisted and initialised, so they are
 * deliberately not collected: reading one early is legal, if odd.
 */

const FUNCTIONS = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Every name a binding pattern introduces. */
function namesIn(node, out = []) {
  if (!node || typeof node !== 'object') return out;

  switch (node.type) {
    case 'Identifier':
      out.push(node.name);
      break;
    case 'ObjectPattern':
      for (const property of node.properties) {
        namesIn(property.type === 'RestElement' ? property.argument : property.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const element of node.elements) namesIn(element, out);
      break;
    case 'AssignmentPattern':
      namesIn(node.left, out);
      break;
    case 'RestElement':
      namesIn(node.argument, out);
      break;
    default:
      break;
  }

  return out;
}

/** The statements that sit directly inside a scope-creating node. */
function bodyOf(node) {
  if (node.type === 'Program' || node.type === 'BlockStatement') return node.body ?? [];
  if (node.type === 'StaticBlock') return node.body ?? [];
  if (node.type === 'SwitchStatement') return node.cases.flatMap((c) => c.consequent);
  return [];
}

function newScope(node, parent) {
  const scope = {
    node,
    parent,
    isFunction: FUNCTIONS.has(node.type),
    declared: new Map(),
  };

  for (const statement of bodyOf(node)) {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      for (const declarator of statement.declarations) {
        for (const name of namesIn(declarator.id)) {
          if (!scope.declared.has(name)) scope.declared.set(name, statement.start);
        }
      }
    }
    if (statement.type === 'ClassDeclaration' && statement.id) {
      scope.declared.set(statement.id.name, statement.start);
    }
  }

  /* A `for` header declares into the loop's own scope, and so does a
     catch clause. Both are initialised before the body runs. */
  if (node.type === 'ForStatement' && node.init?.type === 'VariableDeclaration') {
    for (const d of node.init.declarations) {
      for (const name of namesIn(d.id)) scope.declared.set(name, -1);
    }
  }
  if (
    (node.type === 'ForOfStatement' || node.type === 'ForInStatement') &&
    node.left?.type === 'VariableDeclaration'
  ) {
    for (const d of node.left.declarations) {
      for (const name of namesIn(d.id)) scope.declared.set(name, -1);
    }
  }
  if (node.type === 'CatchClause' && node.param) {
    for (const name of namesIn(node.param)) scope.declared.set(name, -1);
  }

  /* Parameters, which exist for the whole call. */
  if (scope.isFunction) {
    for (const param of node.params ?? []) {
      for (const name of namesIn(param)) scope.declared.set(name, -1);
    }
  }

  return scope;
}

const CREATES_SCOPE = new Set([
  'Program',
  'BlockStatement',
  'StaticBlock',
  'SwitchStatement',
  'ForStatement',
  'ForOfStatement',
  'ForInStatement',
  'CatchClause',
  ...FUNCTIONS,
]);

/**
 * Where a name resolves, and whether a function stands between the two.
 *
 * Returns null when nothing in scope declares it lexically, which covers
 * imports, `var`, globals, and anything this file cannot see.
 */
function resolve(name, scope) {
  let crossedFunction = false;

  for (let at = scope; at; at = at.parent) {
    if (at.declared.has(name)) {
      return { declaredAt: at.declared.get(name), crossedFunction };
    }
    if (at.isFunction) crossedFunction = true;
  }

  return null;
}

/* ── The walk ─────────────────────────────────────────────────────────────
 *
 * Identifiers that are not reads are skipped by name of the field they sit
 * in, rather than by trying to recognise them afterwards. A property key, a
 * declared name, and a label all look exactly like a variable otherwise.
 */

function findViolations(source, file) {
  const ast = acorn.parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    /* Astro compiles frontmatter into a function, so a bare `return` for an
       early redirect is legal there and is not this check's business. */
    allowReturnOutsideFunction: true,
    locations: true,
  });

  const found = [];

  /**
   * Two kinds of failure, and the second is the one that reached a page.
   *
   * A direct read above the declaration is the plain case. The other is a
   * function that closes over a binding declared later and is then *called*
   * before it: legal to write, fatal to run.
   *
   *   const has = (what) => template.has[what];   // fine on its own
   *   const hasResult = has('awards');            // throws
   *   const template = resolve(id);
   *
   * Every entry page threw on that, and nothing that compiles the page can
   * see it: the build does not execute a route. So closures are recorded
   * on the way past and their call sites checked afterwards.
   */
  const closures = new Map();

  const visit = (node, scope) => {
    if (!node || typeof node !== 'object' || !node.type) return;

    const here = CREATES_SCOPE.has(node.type) ? newScope(node, scope) : scope;

    /* `const name = () => ...`, whose body is walked with the closure
       recorded so its free reads can be attributed to it. */
    if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      FUNCTIONS.has(node.init?.type ?? '')
    ) {
      closures.set(node.id.name, { scope: here, reads: [], declaredAt: node.start });
      collecting.push(node.id.name);
      visit(node.init, here);
      collecting.pop();
      return;
    }

    if (node.type === 'Identifier') {
      const where = resolve(node.name, here);

      if (where && where.declaredAt >= 0) {
        if (!where.crossedFunction && node.start < where.declaredAt) {
          found.push({
            name: node.name,
            line: node.loc.start.line,
            declaredLine: source.slice(0, where.declaredAt).split('\n').length,
            why: 'read above its declaration',
          });
        }

        /* Inside a closure, and reaching outside it. Remembered rather than
           judged: whether it is a problem depends on where it is called. */
        if (where.crossedFunction && collecting.length > 0) {
          const owner = closures.get(collecting[collecting.length - 1]);
          if (owner) owner.reads.push({ name: node.name, declaredAt: where.declaredAt });
        }
      }

      /* A call of a closure, at a point the reader will reach immediately. */
      if (closures.has(node.name) && collecting.length === 0) {
        const owner = closures.get(node.name);
        for (const read of owner.reads) {
          if (node.start > owner.declaredAt && node.start < read.declaredAt) {
            found.push({
              name: read.name,
              line: node.loc.start.line,
              declaredLine: source.slice(0, read.declaredAt).split('\n').length,
              why: `reached through ${node.name}() before it is initialised`,
            });
          }
        }
      }

      return;
    }

    for (const [field, value] of Object.entries(node)) {
      if (field === 'type' || field === 'loc' || field === 'start' || field === 'end') continue;

      /* Positions that hold a name rather than a read. */
      if (node.type === 'MemberExpression' && field === 'property' && !node.computed) continue;
      if (node.type === 'Property' && field === 'key' && !node.computed) continue;
      if (node.type === 'MethodDefinition' && field === 'key' && !node.computed) continue;
      if (node.type === 'PropertyDefinition' && field === 'key' && !node.computed) continue;
      if (node.type === 'VariableDeclarator' && field === 'id') continue;
      if (FUNCTIONS.has(node.type) && (field === 'id' || field === 'params')) continue;
      if (node.type === 'ClassDeclaration' && field === 'id') continue;
      if (node.type === 'CatchClause' && field === 'param') continue;
      if (node.type === 'LabeledStatement' && field === 'label') continue;
      if ((node.type === 'BreakStatement' || node.type === 'ContinueStatement') && field === 'label')
        continue;
      if (/^Import(Default|Namespace)?Specifier$/.test(node.type)) continue;
      if (node.type === 'ExportSpecifier') continue;

      if (Array.isArray(value)) for (const child of value) visit(child, here);
      else visit(value, here);
    }
  };

  /* Which closure's body the walk is currently inside, innermost last. */
  const collecting = [];

  visit(ast, null);

  /* One line calling `has()` three times is one mistake, not three. */
  const seen = new Set();
  return found.filter((v) => {
    const key = `${v.line}:${v.name}:${v.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The frontmatter of an Astro page, which is a module and runs per request.
 *
 * Extracted rather than parsed whole: the markup below is not JavaScript,
 * and the failure this catches lives entirely above the second fence.
 *
 * Three adjustments, each forced by something real, and none of them moves
 * a line.
 *
 * **Imports are blanked.** They cannot sit inside the function body below,
 * and nothing here needs them: an imported name resolves to nothing in the
 * scope chain, and an unresolved name is never reported. Replaced with
 * spaces rather than removed so the line count holds.
 *
 * **It is wrapped as a function body**, because Astro compiles frontmatter
 * into one and a page returning a 404 early is ordinary rather than a
 * mistake. The opening sits where the `---` was and adds no newline.
 *
 * **Types are stripped**, because acorn parses JavaScript and every page
 * here is TypeScript. Stripping replaces an annotation with spaces, so
 * offsets survive.
 *
 * The order is forced: the stripper refuses a bare `return` outside a
 * function, and refuses an `import` inside one, so the imports have to go
 * before the wrap and the wrap before the strip.
 *
 * The first version of this did none of it, failed to parse all fifty
 * pages, swallowed the error and reported a pass — which is exactly "a test
 * that passes because the output is uniformly wrong". Nothing here is
 * wrapped in a catch for that reason: a page this cannot read is a page it
 * does not cover, and it has to say so.
 */
const OPENING = 'async function _frontmatter(){';

/** Blank every top level import, keeping the line count and the offsets. */
function withoutImports(text) {
  const lines = text.split('\n');
  let inside = false;

  return lines
    .map((line) => {
      const trimmed = line.trim();

      /* `export const getStaticPaths = ...` is a declaration the check needs
         to see. Only the keyword is in the way, so only the keyword goes. */
      if (!inside && /^export\s+(?:const|let|var|function|class|async|default)\b/.test(trimmed)) {
        return line.replace(/export(\s)/, '      $1');
      }

      const starts = /^(?:import|export)\b/.test(trimmed);
      if (!inside && !starts) return line;

      /* A statement ends at its specifier or its semicolon. Until then the
         import is spread over several lines and every one of them goes. */
      inside = !(/from\s*['"][^'"]*['"]\s*;?\s*$/.test(trimmed) || /;\s*$/.test(trimmed));
      return ' '.repeat(line.length);
    })
    .join('\n');
}

export function frontmatterOf(source) {
  if (!source.startsWith('---')) return null;

  const end = source.indexOf('\n---', 3);
  if (end < 0) return null;

  const body = OPENING + withoutImports(source.slice(3, end)) + '\n}';
  return stripTypeScriptTypes(body, { mode: 'strip' });
}

/* ── Every script, every test, and every page's frontmatter ──────────────── */

const files = [...walkFiles('scripts', ['.mjs']), ...walkFiles('tests', ['.mjs'])];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');

  test(`${file} declares everything before it reads it`, () => {
    const violations = findViolations(source, file);
    assert.deepEqual(
      violations.map((v) => `${file}:${v.line} ${v.name} ${v.why}, declared on line ${v.declaredLine}`),
      [],
      'a const is hoisted uninitialised, so this fails at run time and not at parse time'
    );
  });
}

/**
 * Pages matter more than scripts here.
 *
 * A script fails in front of whoever ran it. A page compiles cleanly, ships,
 * and fails on first request in front of a visitor, because the build does
 * not execute a route. That is how the entry page came to throw for every
 * student who opened one.
 */
const pages = walkFiles('src', ['.astro']);
let scanned = 0;

for (const file of pages) {
  const source = fs.readFileSync(file, 'utf8');
  const frontmatter = frontmatterOf(source);
  if (!frontmatter) continue;
  scanned += 1;

  test(`${file} frontmatter declares everything before it reads it`, () => {
    /* Deliberately not wrapped. A page this cannot parse is a page this
       does not cover, and the first version hid that behind a catch and
       reported fifty passes over fifty files it had never read. */
    const violations = findViolations(frontmatter, file);

    assert.deepEqual(
      violations.map((v) => `${file}:${v.line} ${v.name} ${v.why}, declared on line ${v.declaredLine}`),
      [],
      'the build compiles a page and never runs it, so this reaches a visitor'
    );
  });
}

/* ── That the check catches the thing it was written for ──────────────────── */

test('it finds a closure called before what it closes over', () => {
  /* The entry page in miniature. Legal to write, fatal to run, and
     invisible to anything that compiles the page without running it. */
  const bug = `
    const has = (what) => template.has[what];
    const hasResult = has('awards');
    const template = resolve(id);
  `;
  const found = findViolations(`function main() {${bug}}`, 'inline');
  assert.equal(found.length, 1, 'the early call was not reported');
  assert.equal(found[0].name, 'template');
  assert.match(found[0].why, /through has\(\)/);
});

test('it does not report a closure called after the binding is ready', () => {
  /* The same three lines in the order that works. */
  const fine = `
    const has = (what) => template.has[what];
    const template = resolve(id);
    const hasResult = has('awards');
  `;
  assert.deepEqual(findViolations(`function main() {${fine}}`, 'inline'), []);
});

test('it finds a read above the declaration, in a nested block', () => {
  /* The seed bug in miniature: the read is inside an `if` and the
     declaration is in the loop body around it. */
  const bug = `
    for (const scene of scenes) {
      if (scene.result) {
        record(entry.id);
      }
      const { data: entry } = await db.insert();
    }
  `;
  const found = findViolations(`async function main() {${bug}}`, 'inline');
  assert.equal(found.length, 1, 'the read above the declaration was not reported');
  assert.equal(found[0].name, 'entry');
});

test('it does not report a closure over a later declaration', () => {
  /* Legal, common, and what a heuristic gets wrong. */
  const fine = `
    const show = () => total;
    const total = 4;
    show();
  `;
  assert.deepEqual(findViolations(`function main() {${fine}}`, 'inline'), []);
});

test('it does not report a declaration in a sibling block', () => {
  const fine = `
    { const x = 1; use(x); }
    { const x = 2; use(x); }
  `;
  assert.deepEqual(findViolations(`function main() {${fine}}`, 'inline'), []);
});

test('it does not report a property that shares a name with a later binding', () => {
  const fine = `
    log(row.entry);
    const entry = 1;
    use(entry);
  `;
  assert.deepEqual(findViolations(`function main() {${fine}}`, 'inline'), []);
});

test('it does not report a loop binding or a parameter', () => {
  const fine = `
    function f(a, { b }) { return a + b; }
    for (const item of list) use(item);
    for (let i = 0; i < 3; i += 1) use(i);
    try { go(); } catch (e) { report(e); }
  `;
  assert.deepEqual(findViolations(fine, 'inline'), []);
});

if (process.exitCode) {
  console.error('\nA read above a declaration fails at run time, part way through.\n');
} else {
  console.log(
    `\n${passed} temporal dead zone assertions passed. ` +
      `${files.length} scripts and ${scanned} pages parsed.`
  );
}
