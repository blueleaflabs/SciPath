/**
 * AN ORGANIZATION FILE THE DATABASE WOULD REFUSE.
 *
 * `src/config/orgs/*.yaml` is the only description of a school (1.65), and
 * `scripts/seed-orgs.mjs` hands it to `public.provision_org`, which inserts
 * into a table with check constraints on three of those fields. Nothing
 * compared the two. A mark one character too long therefore passed every
 * suite, passed the build, rendered correctly on every page, and failed a
 * third of the way through `npm run reset` — after the database had been
 * dropped and recreated, with two organizations already written and the rest
 * of the seed chain unrun.
 *
 * That is the worst place to find it. The reset is destructive and not
 * resumable, so the cost of the failure is the whole sequence rather than the
 * one row, and the message names a constraint rather than the file.
 *
 * **The limits are parsed out of the migration rather than written down
 * here.** A number copied into a test is a fact about the day it was copied:
 * widen the constraint and this file would go on enforcing the old ceiling,
 * green, while the schema had moved. Same shape as 19.9's count taken from a
 * file. If the parse stops finding a constraint this fails rather than
 * skipping, because a check that quietly reads nothing is the failure mode
 * this whole directory exists to prevent.
 *
 * Run: npm run test:orgs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

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

const migration = fs.readFileSync(
  'supabase/migrations/0001_identity_and_tenancy.sql',
  'utf8'
);

/* The `create table public.organizations` body, and only it. Reading the
   whole file would find `theme` and `mark` on other tables. */
const table = migration.match(
  /create table public\.organizations \(([\s\S]*?)\n\);/
)?.[1];

assert.ok(table, 'could not find create table public.organizations');

/** `check (char_length(col) between A and B)` */
function lengthLimits(column) {
  const m = table.match(
    new RegExp(`char_length\\(${column}\\)\\s+between\\s+(\\d+)\\s+and\\s+(\\d+)`)
  );
  assert.ok(m, `no char_length constraint on ${column} — widen the pattern rather than dropping the check`);
  return { min: Number(m[1]), max: Number(m[2]) };
}

/** `check (col in ('a', 'b'))` */
function allowedValues(column) {
  const m = table.match(
    new RegExp(`${column}\\s+text[^\\n]*(?:\\n[^\\n]*?)?check \\(${column} in \\(([^)]*)\\)\\)`)
  );
  assert.ok(m, `no enum constraint on ${column} — widen the pattern rather than dropping the check`);
  const values = [...m[1].matchAll(/'([^']+)'/g)].map((v) => v[1]);
  assert.ok(values.length > 0, `parsed no values out of ${column}'s constraint`);
  return values;
}

const markLimits = lengthLimits('mark');
const themes = allowedValues('theme');
const signupModes = allowedValues('signup_mode');

const dir = 'src/config/orgs';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();

assert.ok(files.length > 0, `no organization files in ${dir}`);

/* Every file is checked, including one declaring `provisioned: false`. A
   record that is not a row today becomes one the day somebody deletes that
   line, and finding out then is finding out during a reset. */
for (const file of files) {
  const doc = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
  const at = `${dir}/${file}`;

  test(`${file}: the mark fits organizations.mark`, () => {
    assert.ok(typeof doc.mark === 'string' && doc.mark.length > 0, `${at} has no mark`);
    assert.ok(
      doc.mark.length >= markLimits.min && doc.mark.length <= markLimits.max,
      `mark "${doc.mark}" is ${doc.mark.length} characters; the schema allows ` +
        `${markLimits.min} to ${markLimits.max}. Widen the constraint in 0001 ` +
        `and step the badge down in ui.css, or choose a shorter mark.`
    );
  });

  test(`${file}: the theme is one the schema permits`, () => {
    assert.ok(
      themes.includes(doc.theme),
      `theme "${doc.theme}" is not one of ${themes.join(', ')}`
    );
  });

  test(`${file}: the signup mode is one the schema permits`, () => {
    /* `provision_org` defaults it, so an absent one is legal. */
    const mode = doc.signup_mode ?? 'domain';
    assert.ok(
      signupModes.includes(mode),
      `signup_mode "${mode}" is not one of ${signupModes.join(', ')}`
    );
  });

  test(`${file}: the lockup name is present`, () => {
    assert.ok(
      typeof doc.name === 'string' && doc.name.trim().length > 0,
      `${at} has no name, and organizations.lockup_name is not null`
    );
  });
}

/**
 * The badge has a size for every length the schema allows.
 *
 * `.lockup .badge` sets one font size and `[data-len='4']` steps it down, so
 * a longer mark rendered at the base size grows the badge sideways into a
 * rectangle. That is a visual defect rather than a broken page, which is why
 * it is worth a check: nothing else would report it, and the mark sits in the
 * masthead of every page a school has.
 */
test('every mark length the schema allows has a badge size', () => {
  const css = fs.readFileSync('src/styles/ui.css', 'utf8');
  const stepped = new Set(
    [...css.matchAll(/\.badge\[data-len='(\d+)'\]/g)].map((m) => Number(m[1]))
  );

  /* The base rule carries the shortest lengths; anything above the first
     stepped length needs one of its own. */
  const shortest = Math.min(...stepped);

  for (let n = shortest; n <= markLimits.max; n += 1) {
    assert.ok(
      stepped.has(n),
      `a mark may be ${n} characters and .badge[data-len='${n}'] has no rule, ` +
        `so it renders at the base size and the badge stops being square`
    );
  }
});

console.log(
  `\n${passed} organization assertions passed. ` +
    `${files.length} files read, mark ${markLimits.min}-${markLimits.max} from the migration.`
);
