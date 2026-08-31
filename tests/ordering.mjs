/**
 * Deadlines are listed by date.
 *
 * The entry page sorted by the template's sequence, which is a different
 * thing: a sequence says what depends on what, and a page headed "deadlines"
 * is answering "what is next". Those diverge — the fair's applications open
 * in September and sit late in the sequence because they belong to the
 * approval phase — and the result read as an error.
 *
 * Run: npm run test:ordering
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

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.astro')) out.push(full);
  }
  return out;
}

const pages = walk('src/pages');

/**
 * A PAGE WITHOUT ITS COMMENTS.
 *
 * Every assertion below that looks for a sentence in a page must read this
 * rather than the file. The check that a public page ends with a way in
 * asserted `Sign in to join one` against `src/pages/index.astro`, and passed
 * for a year on a comment quoting the copy that had been replaced. The live
 * link said something else, and the assertion would equally have passed a
 * page with no link at all, which is the one thing it existed to prevent.
 *
 * Comments in this codebase quote the copy they explain, deliberately and
 * usefully. That is exactly why a test may not read them.
 */
function copyOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Every public page: everything outside the working surface. */
const publicPages = pages.filter(
  (f) => !f.includes(`${path.sep}app${path.sep}`) && !f.includes(`${path.sep}auth${path.sep}`)
);

test('every deadline query orders by date first', () => {
  /* A query against milestones that orders by anything else is showing a
     student a list whose first row is not the next thing due. */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(/\.from\('(entry_milestones|program_milestones)'\)([\s\S]{0,600}?);/g)) {
      const query = m[2];
      if (!/\.order\(/.test(query)) continue;

      const first = query.match(/\.order\('(\w+)'/)?.[1];
      if (first !== 'due_on') {
        problems.push(`${file} orders ${m[1]} by ${first}`);
      }
    }
  }

  assert.deepEqual(problems, [], 'order by due_on, with sort_order as the tiebreak');
});

test('an undated deadline sorts last, not first', () => {
  /* A step nobody has scheduled is not the next thing to worry about, and
     Postgres puts nulls first for ascending order unless told otherwise. */
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  assert.match(entry, /nullsFirst: false/);
});

test('the sequence is still the tiebreak', () => {
  /* Two things due the same day should read in the order they happen, which
     is what the template's order is for. */
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  const at = entry.indexOf(".order('due_on'");
  assert.ok(at > 0);
  assert.match(entry.slice(at, at + 300), /\.order\('sort_order'/);
});

test('manuscript sections are still ordered by sequence', () => {
  /* Sections have no dates and their order is the argument. This exists so
     nobody applies the rule above where it does not belong. */
  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\.from\('manuscript_sections'\)([\s\S]{0,400}?);/g)) {
      if (/\.order\(/.test(m[1])) {
        assert.match(m[1], /\.order\('sort_order'/, file);
      }
    }
  }
});

/* ── Buttons look like the tenant's buttons ──────────────────────────────── */

test('every button carries a button class', () => {
  /* Twelve of them inherited the browser default: grey, system font, nothing
     to do with the school's lockup. On a page where every other control is
     styled, one that is not reads as broken rather than plain. */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');

    /* `class:list` is Astro's, and a button may run to several lines, so the
       match has to reach past the newline and accept both spellings. */
    for (const m of text.matchAll(/<button(?![^>]*\bclass(:list)?[=\s])[^>]*>/gs)) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line} ${m[0].slice(0, 44)}`);
    }
  }

  assert.deepEqual(problems, [], 'add class="btn", "btn btn-2", or "btn btn-2 btn-sm"');
});

test('the small variant exists, and lives with the other buttons', () => {
  /* A full-size button inside a table row turns one line into two, which is
     what made the deadline rows read as a wrapped mess. It is a variant of
     `.btn` and belongs beside it rather than in whichever page needed it
     first. */
  const css = fs.readFileSync('src/styles/ui.css', 'utf8');
  assert.match(css, /\.btn-sm\s*\{/);
});

test('the deadline row is laid out as one line', () => {
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  assert.match(entry, /\.statusf\s*\{[\s\S]*?display:\s*grid/);
  assert.match(entry, /grid-template-columns/);
});

/* ── Whose deadline it is ────────────────────────────────────────────────── */

test('a copied milestone keeps the layer it came from', () => {
  /* `org_id` cannot say it: on a copied milestone it is always the school's,
     whether the deadline came from the fair or the club. Every copy in the
     migration has to carry `source` or a real entry loses it, and a student
     who cannot tell a club deadline from a fair rule starts treating real
     deadlines as advisory. */
  const sql = migrationSql();

  /* There were four, in four functions, and I updated two by string match and
     missed two. Two of those four were dead: `start_entry` had been declared
     three times and only the last one ran, so this count included bodies that
     had not executed since the change that superseded them.

     Then there was one. `app.copy_milestones` was extracted so that joining a
     class and entering a fair shared it, and `start_entry` went on doing its
     own copy beside it — which is how the two drifted: the inline one carried
     `satisfied_by` and the shared one did not, so whether a sponsor could
     close an approval depended on which path had made the entry.
     `start_entry` delegates to `enter_program` now, and the copy happens in
     exactly one statement.

     The number is asserted rather than bounded, because a second copy site
     appearing is the thing that goes wrong here: the fix is always to call
     `copy_milestones` rather than write another insert. */
  const starts = [...sql.matchAll(/insert into public\.entry_milestones\b/g)].map((m) => m.index);
  assert.equal(starts.length, 1, `found ${starts.length} copies, expected 1`);

  const missing = [];
  for (const at of starts) {
    const statement = sql.slice(at, sql.indexOf(';', at));
    const line = sql.slice(0, at).split('\n').length;
    if (!/\bsource\b/.test(statement)) missing.push(`line ${line}`);
  }

  assert.deepEqual(missing, [], 'these copies drop the source');
});

test('the entry page shows it', () => {
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  assert.match(entry, /Set by/);
  assert.match(entry, /source/, 'and reads the column');
});

/* ── What is next ────────────────────────────────────────────────────────── */

test('a page that filters on a column also selects it', () => {
  /* `m.kind !== 'event'` against rows fetched without `kind` matches
     everything and looks like it works. The overview did exactly that, and
     the only symptom would have been forty projects still reading
     "Applications open". */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(/\.from\('(entry_milestones|program_milestones)'\)([\s\S]{0,600}?);/g)) {
      const columns = m[2].match(/\.select\('([^']+)'/)?.[1] ?? '';
      const after = text.slice(m.index, m.index + 4000);

      for (const column of ['kind', 'due_on', 'completed_on', 'source']) {
        const used = new RegExp(`\\bm\\.${column}\\b|\\b${column}:`).test(after);
        if (used && !columns.includes(column)) {
          problems.push(`${file} filters on ${column} without selecting it`);
        }
      }
    }
  }

  assert.deepEqual([...new Set(problems)], []);
});

test('an event is not what a page counts down to', () => {
  /* Applications opening is a day on the fair's calendar, not something a
     student does. Counting down to it while their sponsor is unasked is
     worse than saying nothing. */
  for (const file of ['src/pages/app/project/[id]/in/[program].astro', 'src/pages/app/index.astro']) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /kind !== 'event'/, `${file} counts down to events`);
  }
});

/* ── No example content inside a field ───────────────────────────────────── */

test('no form field carries a placeholder', () => {
  /* Grey text inside a box reads as a filled value. "Chemistry" in the
     category field looked like the category was already Chemistry, and
     "Ricoh Sustainable Development Award" looked like an award had been
     recorded.
     
     It also disappears the moment somebody types, which is exactly when they
     most want to know what the box is for. Where the hint was worth keeping,
     it belongs in the small text below the field, which stays. */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/placeholder=/g)) {
      problems.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
    }
  }

  assert.deepEqual(problems, [], 'put the hint under the field, or make it a label');
});

test('every field a person types into has a name', () => {
  /* Removing a placeholder that was the only prompt leaves an unlabelled
     box, which is worse than the problem. */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(/<(input|textarea|select)\b[^>]*>/gs)) {
      const tag = m[0];
      if (/type="(hidden|submit)"/.test(tag)) continue;
      if (/aria-label/.test(tag)) continue;

      /* Inside a <label>, which is how most of these are written. */
      const before = text.slice(Math.max(0, m.index - 400), m.index);
      const lastOpen = before.lastIndexOf('<label');
      const lastClose = before.lastIndexOf('</label>');
      if (lastOpen > lastClose) continue;

      /* Or bound to one by id, which is how a visually hidden label works. */
      const id = tag.match(/\bid="([^"]+)"/)?.[1];
      if (id && new RegExp(`<label[^>]*\\bfor="${id}"`).test(text)) continue;

      problems.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
    }
  }

  assert.deepEqual(problems, [], 'give it a <label> or an aria-label');
});

test('no hero repeats the same inline padding override', () => {
  /* Eight pages carried `style="padding-top:0"` on their hero. Eight copies
     of one instruction is the markup saying the shared rule is wrong, and
     the ninth page to be written would have inherited the gap and nobody
     would have noticed. */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/<section class="hero"[^>]*style=/g)) {
      problems.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
    }
  }

  assert.deepEqual(problems, [], 'put it in ui.css, where every page gets it');
});

/* ── One place decides what a program is called ──────────────────────────── */

test('no page appends the season to a program name by hand', () => {
  /* A program is an edition, so most names already end in their year:
     "Monta Vista Research Club, 2027". Five pages appended the season
     regardless, and the result read "2027 2027" on two of them before
     anybody noticed. */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');
    /* Rendered, not selected: `.select('name, season_year')` is a column
       list and perfectly fine. What is not fine is the two printed next to
       each other. */
    for (const m of text.matchAll(/\{[^{}]*\bname\b[^{}]*\}[^\n]{0,4}\{[^{}]*season_year[^{}]*\}|`\$\{[^`]*name\}\s*\$\{[^`]*season_year\}`/g)) {
      problems.push(`${file}:${text.slice(0, m.index).split('\n').length}`);
    }
  }

  assert.deepEqual(problems, [], 'use programTitle() from lib/program-names');
});

test('the old selection page redirects rather than 404s', () => {
  /* Its whole content is a column on the overview now. The nav pointed here
     for months, and an advisor's bookmark is the most likely one to exist. */
  const selection = fs.readFileSync('src/pages/app/selection.astro', 'utf8');
  assert.match(selection, /Astro\.redirect\('\/app\/#projects', 301\)/);
});

test('the old entries page redirects rather than 404s', () => {
  /* Two years of bookmarks, the welcome page and an empty state point at
     it. A dead link is a worse answer than a moved one. */
  const fairs = fs.readFileSync('src/pages/app/fairs.astro', 'utf8');
  assert.match(fairs, /Astro\.redirect\('\/app\/#join', 301\)/);
});

test('a class is not called a fair', () => {
  /* "Open fairs" over a list containing a research class is wrong, and
     "programs" is our word rather than a student's. The heading says what
     the list is for and each card says what kind of thing it is. */
  /* The joining half moved to the overview and `fairs.astro` is a redirect
     now. The rule did not change, so the file it reads did. */
  const overview = fs.readFileSync('src/pages/app/index.astro', 'utf8');
  assert.doesNotMatch(overview, />Open fairs</);
  assert.match(overview, /programKind\(/, 'each card should say its kind');
});

/* ── Nobody is offered an action they cannot take ────────────────────────── */

test('an author is not invited to assign their own officer', () => {
  /* An officer is assigned by another officer or by the advisor. Offering an
     author the link sent them to a page they cannot act on, and implied the
     gap was theirs to close. */
  for (const file of [
    'src/pages/app/project/[id]/team.astro',
    'src/pages/app/project/[id]/in/[program].astro',
  ]) {
    const text = fs.readFileSync(file, 'utf8');
    const at = text.indexOf('Assign one');
    assert.ok(at > 0, `${file} no longer offers to assign`);

    /* Gated within the block that renders it. */
    const before = text.slice(Math.max(0, at - 700), at);
    assert.match(before, /runsTheClub/, `${file} offers it to everybody`);
  }
});

test('and is told who does it instead', () => {
  /* A dead end says nothing. Naming who closes the gap is the useful
     answer, and it is what somebody would otherwise have to ask.

     The word itself is no longer asserted, because it stopped being a word
     and became data: a class calls this person an elder and a journal calls
     them an editor, and the page takes whichever from `programs.roles`.
     What has to hold is the shape of the sentence, which is that somebody
     is named and the advisor is the other way. Pinning "officer" here would
     make the check fail on exactly the pages that got this right. */
  for (const file of [
    'src/pages/app/project/[id]/team.astro',
    'src/pages/app/project/[id]/in/[program].astro',
  ]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /or your advisor assigns one/i, file);

    /* And somebody is named rather than the sentence starting at "or". */
    assert.match(
      text,
      /(staff|staffWord\([^)]*\))[^\n]*\}? or your advisor assigns one/i,
      `${file} names nobody before the advisor`
    );
  }
});

/* ── "Fair" is a kind, not a synonym for a program ───────────────────────── */

test('no empty state calls an unknown program a fair', () => {
  /* With nothing joined we do not know whether this student's school runs a
     fair, a class, or both. "No fair entered" is wrong for somebody whose
     only option is IRPD, and "no program entered" is our word rather than
     theirs. The way out is to use no noun at all. */
  const forbidden = [
    /No fairs? entered/i,
    /See open fairs/i,
    /No fairs are open/i,
    /Past fairs/i,
    /Fairs you have competed/i,
  ];

  /* Comments explaining the rule quote the wording the rule forbids, which
     is not a violation. Strip them before looking. */
  const withoutComments = (text) =>
    text
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/<!--[\s\S]*?-->/g, '');

  const problems = [];
  for (const file of pages) {
    const text = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const pattern of forbidden) {
      if (pattern.test(text)) problems.push(`${file}: ${pattern}`);
    }
  }

  assert.deepEqual(problems, [], 'say the kind where it is known, and no noun where it is not');
});

test('a class is never described as a club', () => {
  /* "Set by: The club" against every IRPD deadline named a body that does not
     exist. The school's own layer on top of a fair is a club; the school's
     own layer when the program IS the class is the class. */
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  const map = entry.slice(entry.indexOf('const whose'), entry.indexOf('};', entry.indexOf('const whose')));

  assert.match(map, /school: isCourse \? 'The class'/, 'a course has no club');
  assert.match(map, /program: isCourse \? 'The class'/, 'and no fair either');
  assert.match(map, /isGrant \? 'The funder'/, 'and a grant has neither');
  assert.doesNotMatch(
    entry,
    /whose\[m\.source\] \?\? entry\?\.programs\?\.name/,
    'the program row is the school edition, so its name is the wrong fallback'
  );
});

test('the pages that can tell a class from a fair do', () => {
  /* Where the kind is on the record there is no reason to guess, and "days
     to fair" in front of an IRPD student is the software describing
     something they are not doing. */
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  assert.match(entry, /isCourse/, 'the participation page should branch on the kind');

  /* The select moved into `src/lib/participation.ts`, which is the one place
     that reads the merged table and the place that decides whether a row is
     a class or a fair. Checked there rather than loosened here. */
  const resolver = fs.readFileSync('src/lib/participation.ts', 'utf8');
  assert.match(resolver, /program_role/, 'the resolver has to select the kind');
  assert.match(resolver, /programs\(id, name, season_year, kind/, 'and the program with it');

  const overview = fs.readFileSync('src/pages/app/index.astro', 'utf8');
  assert.match(overview, /kind === 'course'/, 'the join button should say which');
});

test('no page styles the file input for itself', () => {
  /* There are four across the app and each was inheriting the browser's
     grey system button, which on a page where every other control carries
     the school's styling reads as broken. One rule in ui.css rather than
     four pages deciding separately. */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');
    if (/file-selector-button/.test(text)) problems.push(file);
  }

  assert.deepEqual(problems, [], 'it belongs in src/styles/ui.css');

  const css = fs.readFileSync('src/styles/ui.css', 'utf8');
  assert.match(css, /file-selector-button/, 'and it should be there');
});

test('a blank text box is never named only to a screen reader', () => {
  /* Removing the placeholders left several fields with an aria-label and no
     visible cue. That satisfies a screen reader and shows a sighted person an
     empty box — which is how "what goes in here?" happened for the link field
     on the deadlines table.
   
     Selects and dates are exempt: their options and their format are visible
     in the control itself. This is about empty text boxes. */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(/<input\b[^>]*>/gs)) {
      const tag = m[0];
      if (!/aria-label/.test(tag)) continue;
      if (!/type="(text|url|email|search)"/.test(tag) && /type="/.test(tag)) continue;

      /* Named by a column header, or by a <label> around it. */
      const before = text.slice(Math.max(0, m.index - 400), m.index);
      if (before.lastIndexOf('<label') > before.lastIndexOf('</label>')) continue;

      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line}`);
    }
  }

  /* Inside a table, a visible column header names the control and repeating
     a label on every row would be noise. Both remaining cases are that: the
     link box under "Status, when, and a link", and the DOI box under "DOI".
   
     Line numbers would rot, so the rule is the shape: an aria-labelled text
     box is fine inside a <td> and not fine anywhere else. */
  const inACell = (file, line) => {
    const text = fs.readFileSync(file, 'utf8');
    const upTo = text.split('\n').slice(0, line).join('\n');
    return upTo.lastIndexOf('<td') > upTo.lastIndexOf('</td>');
  };

  const outside = problems.filter((p) => {
    const [file, line] = [p.slice(0, p.lastIndexOf(':')), Number(p.slice(p.lastIndexOf(':') + 1))];
    return !inACell(file, line);
  });

  assert.deepEqual(outside, [], 'give it a visible label, or put it under a column header');
});

/* ── Every button wears the tenant's clothes ─────────────────────────────── */

const components = fs.existsSync('src/components')
  ? fs.readdirSync('src/components').filter((f) => f.endsWith('.astro')).map((f) => `src/components/${f}`)
  : [];

const everything = [...pages, ...components];

/**
 * Classes that style a button without being `.btn`, each for a stated reason.
 *
 * A button is allowed to look like something other than a button — a nav
 * item, a link, a play control — provided it is deliberate and uses the
 * tenant's tokens. What is not allowed is a button with no class at all,
 * which inherits the browser's grey system chrome.
 */
const DELIBERATE = new Set([
  'mnav-out', // sign out, in the masthead, which reads as a nav item
  'mnav-go',  // the magnifying glass, which is the search field's own edge
  'play',     // the video facade's play control
  'linkish',  // a secondary action inside a table row
]);

test('every button carries a class', () => {
  const problems = [];

  for (const file of everything) {
    const text = fs.readFileSync(file, 'utf8');

    const controls = [
      ...text.matchAll(/<button\b[^>]*>/gs),
      ...text.matchAll(/<input\b[^>]*type="(?:submit|button|reset)"[^>]*>/gs),
    ];

    for (const m of controls) {
      const cls = m[0].match(/class(?::list)?=["{]([^"}]*)/)?.[1] ?? '';
      const names = cls.split(/[\s',\[\]]+/).filter(Boolean);

      const styled = names.some((n) => n === 'btn' || DELIBERATE.has(n));
      if (!styled) {
        problems.push(`${file}:${text.slice(0, m.index).split('\n').length} class="${cls}"`);
      }
    }
  }

  assert.deepEqual(problems, [], 'add a btn class, or add the class to DELIBERATE with a reason');
});

test('the classes that are not btn still use the tenant tokens', () => {
  /* Deliberate is not the same as themed. A button styled with a literal
     colour would look identical at every school, which is the thing the
     token system exists to prevent. */
  const css = [
    fs.readFileSync('src/styles/ui.css', 'utf8'),
    ...components.map((f) => fs.readFileSync(f, 'utf8')),
  ].join('\n');

  for (const name of DELIBERATE) {
    const at = css.indexOf(`.${name} {`);
    assert.ok(at > 0, `.${name} is not defined anywhere`);

    /* Including its descendants: `.play` is a transparent hit area and the
       visible triangle is the span inside it, so the token is one rule
       further down. */
    const block = css.slice(at, at + 900);
    assert.match(block, /var\(--/, `.${name} and its parts use no token`);
  }
});

test('no class that styles a button is defined more than once', () => {
  /* `.linkish` was defined in three files, one with `!important` to beat a
     rule in its own stylesheet, and the three had drifted to three sizes. */
  const problems = [];

  for (const name of DELIBERATE) {
    const where = everything
      .concat(['src/styles/ui.css'])
      .filter((f) => new RegExp(`\\.${name}\\s*\\{`).test(fs.readFileSync(f, 'utf8')));

    if (where.length > 1) problems.push(`.${name} in ${where.join(', ')}`);
  }

  assert.deepEqual(problems, []);
});

/* ── An action's outcome reaches the eye that caused it ──────────────────── */

test('a page that reports an outcome anchors it, and its forms post to it', () => {
  /* Every one of these renders its message near the top and runs to several
     screens. Clicking Generate three screens down returned a page whose only
     change was above the fold, which reads as nothing having happened — and
     is reported that way, correctly. */
  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');

    /* A page that reports the result of a POST it handled. A live region
       updated by script is not one, and neither is a sign-in message: those
       come from a redirect and sit directly above the form they are about,
       so there is nothing to scroll back to. */
    const reports = /role="(alert|status)"/.test(text);
    const posts = /<form method="POST"/.test(text);
    const handles = /Astro\.request\.method === 'POST'/.test(text);
    if (!reports || !posts || !handles) continue;

    if (!/id="outcome"/.test(text)) {
      problems.push(`${file} reports an outcome with nothing to return to`);
      continue;
    }

    /* A form whose handler redirects somewhere else is the exception, and it
       has to say so.
    
       Posting to `#outcome` and then being redirected leaves the fragment
       on the destination, because a browser keeps it when the new URL has
       none of its own — so joining a program landed somebody partway down
       the entry page, at an anchor belonging to the screen they had left.
       The fix is no fragment, which reads from here as a form that forgot
       to return to its own message.
    
       `data-leaves-page` is the difference, in the markup rather than in a
       list kept here: a reader of the page sees why, and a form that
       genuinely forgot still fails. */
    const loose = [...text.matchAll(/<form method="POST"(?! action)(?![^>]*data-leaves-page)/g)];
    if (loose.length > 0) {
      problems.push(`${file} has ${loose.length} forms that do not return to it`);
    }
  }

  assert.deepEqual(problems, [], 'wrap the message in #outcome and post to it');
});

test('deliverables are recorded in one place', () => {
  /* They were recorded in the deadlines table, which meant a deadline could
     be ticked complete with nothing behind it and a deliverable could exist
     against a deadline still reading open. One list, and the deadline is
     complete because the thing exists. */
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');

  assert.match(entry, /id="deliverables"/, 'there should be a deliverables section');
  assert.match(entry, /action" value="deliverable"/, 'and it records them');

  /* The deadlines table sends you there for anything with something to hand
     in, and keeps a control only for steps with nothing. */
  assert.match(entry, /href="#deliverables"/);
  assert.match(entry, /statusf simple/, 'a step with no deliverable stays markable');
});

/* ── The public pages read the same templates ────────────────────────────── */

test('the season on the front page comes from the templates, per tenant', () => {
  /* `/deadlines/` carried this and rendered an empty state for months while
     the templates held real, verified dates. It is withdrawn: it listed every
     step of every program grouped by phase, which is a reference document,
     and a reader arriving without an account is asking the shorter question
     of what they could take part in.

     What has to stay true is the half that mattered. The list is read from
     the same templates the working surface resolves, so a name and a date
     seen before signing up are the ones they will be held to, and it is read
     from the organization record so that two schools see two seasons. */
  const page = fs.readFileSync('src/pages/index.astro', 'utf8');
  assert.match(page, /resolveProgram/);
  assert.match(page, /org\.programs/, 'the list must be per tenant');
  assert.doesNotMatch(page, /const programs: Array</, 'no hardcoded list');
});

test('a withdrawn public page redirects rather than disappears', () => {
  /* Both have been in a footer, and one has been in the masthead since the
     site had a masthead. A dead link is a worse answer than a moved one, so
     they answer the way `/app/fairs/` does. 23.4 says why each went. */
  for (const file of ['src/pages/[org]/deadlines.astro', 'src/pages/[org]/for-schools.astro']) {
    const page = fs.readFileSync(file, 'utf8');
    assert.match(page, /Astro\.redirect/, `${file} should redirect`);
    assert.match(page, /301/, `${file} should say the move is permanent`);
  }
});

test('the public mistakes page shows no club-authored warning', () => {
  /* A club's own layer names teachers. The first two layers are true
     everywhere and safe to show anybody; the third is not, and is behind the
     door on the step it belongs to. */
  const page = fs.readFileSync('src/pages/[org]/mistakes.astro', 'utf8');
  assert.match(page, /step\.source === 'school'/, 'the local layer should be excluded');
  assert.doesNotMatch(page, /step_warnings/, 'and it should not read the club table at all');
});

test('neither page claims a process nobody runs', () => {
  const page = fs.readFileSync('src/pages/[org]/mistakes.astro', 'utf8');
  assert.doesNotMatch(page, /Collected from mentors and judges/);
});

test('a page that explains the work ends with a way in', () => {
  /* A page that explains the work and then stops sends somebody back to a
     search engine. Every page written to be read before signing up carries a
     call to action, and the link in it has to be a link rather than a
     sentence in a comment, which is why this reads `copyOf`. */
  const explainers = [
    'src/pages/[org]/mistakes.astro',
    'src/pages/[org]/how-it-works.astro',
    'src/pages/[org]/for-students.astro',
    'src/pages/[org]/for-educators.astro',
    'src/pages/[org]/for-student-leaders.astro',
    'src/pages/get-started/index.astro',
    'src/pages/try/index.astro',
    'src/pages/for-organizations/index.astro',
  ];

  const problems = [];
  for (const file of explainers) {
    const copy = copyOf(file);
    if (!/class="sec cta"/.test(copy)) problems.push(`${file}: no call to action`);
    if (!/href=\{?['"/]/.test(copy)) problems.push(`${file}: the call to action leads nowhere`);
  }

  /* The home page's way in, and both halves have to be links rather than
     sentences in a comment.

     **This asserted `class="btn" href=` and now asserts the audience cards.**
     The hero carried two buttons and before that three, and each cut was made
     for the same reason: a front door that opens on a decision asks for the
     decision before the reader has the thing to decide about. The last cut
     took the buttons entirely.

     The rule survives the change because the rule was never about buttons.
     It is that a page explaining the work must not stop without a way in, and
     the three audience cards are that way in — real links, above the fold,
     one per reader. Rewriting the assertion to match what the page does is
     right here and wrong in general; what makes it right is that the intent
     is untouched and the thing being checked is still a link. */
  const home = copyOf('src/pages/index.astro');
  const doors = [...home.matchAll(/class="who" href=/g)].length;
  assert.ok(doors >= 3, `the home page offers ${doors} audience cards, expected 3`);
  assert.match(home, /join one<\/a>/, 'the season list has no way in');

  assert.deepEqual(problems, []);
});

test('no public page claims what nothing has earned', () => {
  /* This guarded `/for-schools/`, which is hidden: it was a pitch to a
     teacher written before the product had met one, and a pitch that has
     never met its audience is a guess (23.4). The rule outlives the page and
     applies to every public page instead, which is where it should have been.

     Numbers are the same argument. "28 deadlines across 3 programs" is a
     claim, and a claim typed into a page drifts away from the software the
     week somebody adds a program. */
  /* **Enumerated, and then it was three files.** The list named the three
     public pages that existed when it was written, so the six added since
     were outside the rule that was supposed to apply to every public page.
     Anything enumerating the pages is a page inventory, and a page inventory
     maintained by hand is a page inventory that is wrong. */
  const problems = [];
  for (const file of publicPages) {
    const copy = copyOf(file);
    if (/\b(hundreds|thousands|schools trust|trusted by|join \d)\b/i.test(copy)) {
      problems.push(`${file}: nothing here has users yet, so nothing here may imply it`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the demonstration page publishes the credentials the seed makes', () => {
  /* A page that prints a sign-in has to print the one that exists. Typing
     the address here would make this a second copy of a fact the seed owns,
     and the copy drifts the first week somebody renames a handle — leaving
     the front door of the product advertising a password that does not
     work.

     Both the page and `scripts/seed-demo.mjs` read the same module. Broken
     deliberately to check this fails: writing one address into the page
     makes it fail here. */
  const page = copyOf('src/pages/try/index.astro');

  assert.match(page, /demoSignIns\(\)/,
    'the page should read the accounts rather than restate them');
  assert.match(page, /demo-accounts/,
    'and read them from the module the seed writes from');
  assert.doesNotMatch(page, /@demo\.invalid/,
    'a fixture address is written here rather than read');

  const seed = fs.readFileSync('scripts/seed-demo.mjs', 'utf8');
  assert.match(seed, /demo-accounts\.mjs/,
    'the seed should read the same module the page does');
});

/* ── A refused place is not a place ──────────────────────────────────────── */

test('a staff list only counts participations that were granted', () => {
  /* `requested` and `declined` were added and every query that lists
     participations kept treating them as real. An advisor who had just
     rejected a request found it in the next list down, asking who should be
     assigned to look after it.
   
     Pages that read one entry by id are exempt: showing somebody their own
     pending request is the point. This is about lists. */
  const problems = [];

  const lists = [
    'src/pages/app/assign.astro',
    /* The overview absorbed the selection screen, so the school-wide list of
       participations is here now. `selection.astro` is a redirect. */
    'src/pages/app/index.astro',
    'src/pages/app/publish/index.astro',
  ];

  for (const file of lists) {
    const text = fs.readFileSync(file, 'utf8');

    const aware =
      /\.in\('status', \['entered', 'competed'\]\)/.test(text) ||
      /\['entered', 'competed'\]\.includes/.test(text);

    if (!aware) problems.push(`${file} lists participations without checking they were granted`);
  }

  assert.deepEqual(problems, []);
});

test('an entry page says where the place stands', () => {
  /* It selected `status` and rendered the same screen whether a request had
     been granted, refused, or never decided. A student who had been turned
     down saw their deadlines and their deliverables with nothing to say that
     none of it counted for this program. */
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');

  assert.match(entry, /entry\.status === 'declined'/, 'a refusal is invisible');
  assert.match(entry, /entry\.status === 'requested'/, 'so is a pending request');
  assert.match(entry, /Not approved/);
});

/* ── A class that styles nothing ─────────────────────────────────────────── */

test('every shared class a page uses is defined somewhere', () => {
  /* `.in` was on twenty-six inputs and `.sr` on four labels, and neither
     existed. The inputs looked plausible because a browser's default input
     is not hideous; the labels rendered as ordinary text, which is how
     "Reason, optional" ended up sitting above a field instead of being read
     aloud and drawn nowhere.
   
     Only short, shared-looking names are checked. A page's own class is
     defined in its own style block and this would drown in them. */
  const shared = fs.readFileSync('src/styles/ui.css', 'utf8')
    + fs.readFileSync('src/styles/base.css', 'utf8')
    + fs.readFileSync('src/styles/tokens.css', 'utf8');

  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');
    const own = text.slice(text.indexOf('<style'));

    for (const m of text.matchAll(/class="([^"{}]+)"/g)) {
      for (const name of m[1].split(/\s+/).filter(Boolean)) {
        /* Two or three characters: the ones that look global by convention
           and are the easiest to assume somebody defined. */
        if (name.length > 3) continue;

        const defined =
          new RegExp(`\\.${name}[\\s,:{]`).test(shared) ||
          new RegExp(`\\.${name}[\\s,:{]`).test(own);

        if (!defined) problems.push(`${file}: .${name} is used and never defined`);
      }
    }
  }

  assert.deepEqual([...new Set(problems)], []);
});

test('a refused place can be found again and reversed', () => {
  /* It vanished from every staff view the moment somebody clicked. A
     decision made in error could not be undone by anybody, and a school
     could not see that it had turned six students away from the same
     program. */
  const assign = fs.readFileSync('src/pages/app/assign.astro', 'utf8');

  assert.match(assign, /id="refused"/, 'a refusal has nowhere to be seen');
  assert.match(assign, /Give them a place after all/, 'and no way back');
  assert.match(assign, /decided_note/, 'the reason should be shown to staff too');
});

test('a teacher is never offered as a project officer', () => {
  /* A club officer is a student who looks after somebody else's project. An
     advisor is a teacher, and offering them in that dropdown invited a
     category error — and made the load counts meaningless, since a teacher's
     count is not comparable to a student's.
   
     The approval queue is different and must still read advisors: deciding
     who gets a place is exactly a teacher's job. */
  const assign = fs.readFileSync('src/pages/app/assign.astro', 'utf8');
  const team = fs.readFileSync('src/pages/app/project/[id]/team.astro', 'utf8');

  /* Matched on the exclusion rather than on the statement that carried it.
     This read `if (r.role !== 'officer') return false;`, which was the shape
     of a `.filter` callback, and broke when the same rule moved into a loop
     that gathers every scope a person holds. The rule is that a
     non-officer is excluded; whether that is a `return false` or a
     `continue` is not the thing worth pinning. */
  assert.match(assign, /r\.role !== 'officer'/,
    'the assignable list should exclude anybody who is not an officer');
  assert.match(team, /\.eq\('role', 'officer'\)/,
    'the team page should ask for officers only');

  assert.match(assign, /\['officer', 'advisor'\]/,
    'advisors are still needed for the approval queue');
});

test('a program is only asked for what it has', () => {
  /* The result section is a competition's: a category, an entry code, a
     placement, somewhere it advanced to. A research class has none of those
     and was shown all of them, asking a student what they placed in a
     category that does not exist.
   
     The templates declared `has` from the beginning and the resolver dropped
     it, so the capability existed in the files and nowhere else. */
  const resolve = fs.readFileSync('src/lib/template-resolve.ts', 'utf8');
  assert.match(resolve, /Object\.assign\(has, layer\.has/, 'capabilities must survive resolution');

  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');
  assert.match(entry, /const hasResult =/, 'the result section should know whether there is one');

  for (const cap of ['categories', 'awards', 'advancement']) {
    assert.match(entry, new RegExp(`has\\('${cap}'\\)`), `${cap} is asked for unconditionally`);
  }
});


/* ── Somebody else's page opens in somebody else's tab ───────────────────── */

test('every external link opens in a new tab', () => {
  /* A student following a link to their own Drive, or to a fair's form, and
     losing a half filled entry is a small disaster with no upside. We store
     addresses and never fetch them (7.4), so every one of these leads off
     our pages entirely.
   
     `noreferrer` alongside `noopener` because the destination has no
     business knowing which student's page the click came from. */
  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro')) check(full);
    }
  };

  const check = (file) => {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(/<a\s[^>]*>/g)) {
      const tag = m[0];

      /* An address we hold rather than a route we serve. A literal `/path`
         or a template starting with one is ours. */
      const external =
        /href=\{[^}]*\b(url|Url|externalUrl|external_url|watch|doi|repoUrl)\b/.test(tag) ||
        /href="https?:\/\//.test(tag);

      if (!external) continue;
      if (/target="_blank"/.test(tag)) continue;

      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line}`);
    }
  };

  walk('src/pages');
  walk('src/components');

  assert.deepEqual(problems, [], 'add target="_blank" rel="noopener noreferrer"');
});

test('nothing opens a new tab without noreferrer', () => {
  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(/<a\s[^>]*target="_blank"[^>]*>/g)) {
          if (/rel="noopener noreferrer"/.test(m[0])) continue;
          problems.push(`${full}:${text.slice(0, m.index).split('\n').length}`);
        }
      }
    }
  };

  walk('src/pages');
  walk('src/components');

  assert.deepEqual(problems, []);
});

/* ── A reading measure belongs to text ──────────────────────────────────── */

test('no container of controls carries a reading measure', () => {
  /* Three times now, in one revision each.
   
     A row of six figures wrapped inside a hero capped at 74ch while two
     thirds of the page sat empty. A block of facts capped at 66ch had to
     fit a label and two eleven-rem buttons, so the value column shrank to
     about five rem, wrapped to one word per line, and the buttons overflowed
     on top of it.
   
     15.6a states the rule; this is the part of it a machine can hold. A
     selector that sets `max-width` to a measure token and also styles
     something that holds controls is the shape that keeps recurring, so the
     measure goes on the prose inside the container instead.
   
     Named selectors rather than a general rule, because the general rule
     would need to know what each class contains. The list is the point:
     adding to it should feel like a decision. */
  const holdsControls = ['.facts', '.counts', '.filters', '.f-do', '.queue', '.actions', '.hero'];

  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro') || entry.name.endsWith('.css')) check(full);
    }
  };

  const check = (file) => {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(/^([^\n{]*)\{([^}]*)\}/gm)) {
      const [, selector, body] = m;
      if (!/max-width:\s*var\(--measure-/.test(body)) continue;

      /* The measure is fine on a descendant that is text: `.hero h1` and
         `.hero .lede` are how the fix is spelled. */
      const bare = holdsControls.filter((c) => new RegExp(`${c.replace('.', '\\.')}\\s*(,|$)`).test(selector.trim()));
      if (bare.length === 0) continue;

      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${file}:${line} ${bare.join(' ')}`);
    }
  };

  /* The working surface only, which is what 15.6a is about: *a published
     record is read; a working screen is used*. `RecordDetail` styles a
     `.facts` of its own that is text with no controls in it, and 66ch is
     exactly right there. Widening the walk would mean either a false report
     on the archive or a check that has to know what every class contains,
     and the first teaches people to ignore it. */
  walk('src/pages/app');
  check('src/styles/ui.css');

  assert.deepEqual(problems, [], 'put the measure on the text inside it, not on the container');
});

/* ── A refresh re-reads; it does not re-send ─────────────────────────────── */

test('every page that handles a POST answers with a redirect', () => {
  /* Every form on the working surface posted to its own page and the page
     rendered the result directly, so the address bar held a POST and a
     refresh asked the browser to send it again. The honest answer to
     *Confirm form resubmission* is that nobody knows: the second send might
     record a second deliverable, grant a second place, or publish a second
     record.
   
     Post, redirect, get. Thirteen pages, none of which did it. */
  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro')) {
        const text = fs.readFileSync(full, 'utf8');
        if (!/Astro\.request\.method === 'POST'/.test(text)) continue;
        if (/afterPost\(/.test(text)) continue;
        problems.push(full);
      }
    }
  };

  walk('src/pages/app');

  assert.deepEqual(problems, [], 'end the handler with afterPost(Astro.url, ...)');
});

test('the redirect is a 303', () => {
  /* A 302 leaves the method to the browser and some will repeat the POST at
     the new address, which is the thing being fixed. 303 says go and GET
     this. */
  const helper = fs.readFileSync('src/lib/post-redirect.ts', 'utf8');
  assert.match(helper, /status: 303/);
});


test('a redirect that leaves a page does not inherit its fragment', () => {
  /* `afterPost` anchors at `#outcome` because it returns to the same page.
     A redirect that goes somewhere else has to say so, because **a browser
     inherits the fragment** when a `Location` carries none of its own:
     somebody who had just seen an outcome and then joined a program landed
     on `/app/entry/{id}/#outcome`, which is below the hero and all four
     cards, so the first thing they saw of their own project was the middle
     of it.
   
     An empty fragment is not no fragment. `#` parses to a fragment of zero
     length, which is not null, so nothing is inherited. */
  const helper = fs.readFileSync('src/lib/post-redirect.ts', 'utf8');
  assert.match(helper, /Location: `\$\{path\}#`/, 'leaveTo has to end the path with #');

  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro')) {
        const text = fs.readFileSync(full, 'utf8');
        if (!/Astro\.request\.method === 'POST'/.test(text)) continue;

        /* Only inside the handler. The guards at the top of a page — no
           session, no account, no such submission — run before a POST is
           ever read, on a GET as much as a POST, and are not what this is
           about. */
        const lines = text.split('\n');
        const start = lines.findIndex((l) =>
          l.startsWith("if (Astro.request.method === 'POST'")
        );
        if (start < 0) continue;

        let depth = 0;
        let close = lines.length;
        for (let i = start; i < lines.length; i += 1) {
          depth += (lines[i].match(/\{/g) ?? []).length;
          depth -= (lines[i].match(/\}/g) ?? []).length;
          if (depth === 0) {
            close = i;
            break;
          }
        }

        for (let i = start; i <= close; i += 1) {
          if (/return Astro\.redirect\(/.test(lines[i])) {
            problems.push(`${full}:${i + 1} ${lines[i].trim()}`);
          }
        }
      }
    }
  };

  walk('src/pages/app');

  assert.deepEqual(problems, [], 'use leaveTo(path) so the fragment is not inherited');
});

/* ── Signed in stays signed in, on every page ───────────────────────────── */

test('a public page can greet somebody the server cannot ask about', () => {
  /* Signing in and then opening a guide showed a bare Workbench link, which
     reads as *not you* rather than as *you, elsewhere*. A prerendered page
     has no session, so it renders both answers and a script picks.
   
     Asserted against the built markup rather than the source, because what
     matters is that the script's hooks survive the build: Astro adds a
     scoped attribute to every element, and a looser selector would have
     stopped matching. */
  const built = 'dist/montavista/guides/index.html';
  if (!fs.existsSync(built)) return;

  const html = fs.readFileSync(built, 'utf8');

  assert.match(html, /data-anon/, 'the signed out cluster is missing');
  assert.match(html, /data-known hidden/, 'the signed in cluster is missing or not hidden');
  assert.match(html, /data-name/, 'nothing for the script to write the name into');

  /* The sign out form is markup rather than something the script builds: it
     is a POST, and a form assembled by script is a form that stops working
     the moment the script does not run. */
  assert.match(html, /action="\/auth\/signout\/"/);
});

test('the workbench link is called the same thing to everybody', () => {
  /* Some pages said Sign in and some said Workbench, for the same person in
     the same state. One name for one destination. */
  const masthead = fs.readFileSync('src/components/Masthead.astro', 'utf8');
  assert.doesNotMatch(masthead, /'Sign in'|>Sign in</, 'the masthead still says Sign in somewhere');

  const built = 'dist/montavista/guides/index.html';
  if (fs.existsSync(built)) {
    assert.doesNotMatch(fs.readFileSync(built, 'utf8'), />\s*Sign in\s*</);
  }
});

/* ── A page is not a terminal ────────────────────────────────────────────── */

test('the participation page checks standing before it handles a POST', () => {
  /* **A guard after the handler refuses the page and accepts the writes.**

     Everything on the participation page that acts — recording a
     deliverable, verifying somebody else's, editing a warning, setting an
     awarded amount — is a POST to this same address. A scope check placed
     below that handler would render a redirect to somebody who had already
     written the row.

     Asserted on position rather than presence, for the same reason the
     Docker pre-flight is: a check that runs too late is a check that does
     not run. */
  const file = 'src/pages/app/project/[id]/in/[program].astro';
  const text = fs.readFileSync(file, 'utf8');

  const guard = text.indexOf('reachesProgram(');
  const post = text.indexOf("Astro.request.method === 'POST'");

  assert.ok(guard !== -1, `${file} must ask reachesProgram()`);
  assert.ok(post !== -1, `${file} is expected to handle a POST`);
  assert.ok(
    guard < post,
    'reachesProgram() must run before the POST handler, or the writes go through'
  );
});

test('no page tells a student to run a command', () => {
  /* Signing in to a demo account with the wrong password answered with a
     paragraph about `npm run reset` and the fixture password. Publishing a
     record with the dispatch token missing told an editor to run
     `npm run index:records`.
   
     Both were true and both were development notes rendered on pages a
     student reaches, telling them to run something they have never heard of
     and could not run. Whoever can act on it is reading a terminal, so the
     instruction belongs there and the page says what it means in the
     reader's own terms.
   
     `console.log` is exempt, because that *is* the terminal. */
  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro')) check(full);
    }
  };

  const check = (file) => {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      /* Comments explain these decisions by quoting the commands. */
      .map((l) => (/^\s*(\*|\/\*|\/\/)/.test(l) ? '' : l));

    lines.forEach((line, i) => {
      if (/console\.(log|error|warn)/.test(line)) return;
      if (/npm run |npx |supabase db reset|\.dev\.vars/.test(line)) {
        problems.push(`${file}:${i + 1} ${line.trim().slice(0, 60)}`);
      }
    });
  };

  walk('src/pages');
  walk('src/components');

  assert.deepEqual(problems, [], 'say it in the terminal, not on the page');
});

/* ── A supervisor belongs to a cohort, not to a venue ────────────────────── */

test('no page reads a role word off an entry', () => {
  /* The project page called somebody an Officer because the project had been
     entered at a fair, which is a venue's vocabulary rather than a school's.
     A regional fair has no opinion about what a school calls the person
     looking after a project; a class calls them an Elder and a club calls
     them an Officer, and that comes from the cohort (22.9).
   
     `staffWord(program)` on an entry page is correct: there the program *is*
     the subject. What this refuses is deriving one from a list of entries,
     which is how a project in two cohorts got one word for two supervisors. */
  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.astro')) {
        const text = fs.readFileSync(full, 'utf8');

        for (const m of text.matchAll(/(shared)?[sS]taffWord\([^)]*\)/g)) {
          if (!/entries|e\.programs/.test(m[0])) continue;
          problems.push(`${full}:${text.slice(0, m.index).split('\n').length} ${m[0].slice(0, 50)}`);
        }
      }
    }
  };

  walk('src/pages/app');

  assert.deepEqual(problems, [], 'read the word from project_cohorts, not from where the work went');
});

test('the project page shows when a project belongs nowhere', () => {
  /* `independent-research` existed so a solo student had something to join,
     and it hid the fact that nobody was answerable for their work. Deleting
     it makes the absence visible, which is the argument for a staffed Open
     Program cohort rather than a placeholder that made it look handled
     (22.10).

     What is asserted is that the state is legible, not the wording. A
     paragraph saying "nobody at the school is looking after it. That is
     allowed, and the work counts the same" used to sit under the picker and
     has gone: the eyebrow above the title and the count beside the section
     header both say it already, and a third telling — phrased as an absence
     and then a reassurance — read as a warning about a state the student had
     chosen. Two places still say it plainly, and this checks they do. */
  const page = fs.readFileSync('src/pages/app/project/[id].astro', 'utf8');
  assert.match(page, /Not in a class, and not entered anywhere/);
  assert.match(page, /'nowhere yet'/);
});

test('no page hands children to a component that cannot render them', () => {
  /**
   * A component with no `<slot />` discards everything written inside it.
   *
   * `AppShell` is a nav bar and has no slot. Ten pages used it self-closing
   * and one wrapped its whole body in it, so that page rendered the nav and
   * nothing else — no error, no warning, no blank-page exception. **Astro
   * does not report an unrendered slot**, because passing children to a
   * component that ignores them is legal, and the failure is therefore
   * visible only to somebody who opens the page.
   *
   * Checked by pairing an opening tag with its closing tag rather than by
   * looking for children, because that is the thing that would break: a
   * `</Component>` anywhere means somebody wrote a body.
   *
   * Reports how many components it resolved, so a rename that stops the
   * import matching shows as a drop rather than as a pass (19.9).
   */
  const components = fs
    .readdirSync('src/components')
    .filter((f) => f.endsWith('.astro'))
    .map((f) => f.replace(/\.astro$/, ''));

  const slotless = new Set(
    components.filter(
      (name) => !/<slot\b/.test(fs.readFileSync(`src/components/${name}.astro`, 'utf8'))
    )
  );

  assert.ok(components.length > 0, 'read no components — widen the pattern');

  const problems = [];
  let resolved = 0;

  for (const file of [...pages, ...components.map((c) => `src/components/${c}.astro`)]) {
    const text = fs.readFileSync(file, 'utf8');

    for (const name of components) {
      /* Imported here, so a word that merely appears in prose is not a use. */
      if (!new RegExp(`import\\s+${name}\\s+from`).test(text)) continue;
      resolved += 1;

      if (slotless.has(name) && new RegExp(`</${name}>`).test(text)) {
        problems.push(
          `${file} wraps content in <${name}>, which has no <slot /> and drops it`
        );
      }
    }
  }

  assert.ok(resolved > 0, 'matched no component imports — widen the pattern');

  assert.deepEqual(
    [...new Set(problems)],
    [],
    'give the component a <slot />, or close the tag and make the content a sibling'
  );
});

test('no page puts a form control class on something that is not one', () => {
  /**
   * `ui.css` styles `.in` as a text input: a border, a background, padding, a
   * radius. Twenty-six pages set it on an `<input>`, which is what it is for.
   * One page set it on a `<span>` holding a program's name, and got the name
   * rendered inside what looked like a disabled form field.
   *
   * **Nothing was wrong with either rule.** A page-scoped `.in` was written
   * for that span, and Astro's scoped styles do not stop a global rule of the
   * same name applying too — so the span took the input's look and the local
   * rule only adjusted it. Two meanings had been given one name, and the
   * cheaper one to change is the local one.
   *
   * Checked by name against the elements the class belongs on. A visual fault
   * of this kind is invisible to every check here, because the markup is
   * valid and the styles both apply exactly as written.
   */
  const controls = ['in', 'sel', 'btn-sub'];
  const allowed = /^(input|select|textarea|button)$/i;

  const problems = [];

  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');

    for (const cls of controls) {
      /* The element name immediately before the class, on the same tag. */
      for (const m of text.matchAll(
        new RegExp(`<(\\w+)(?:\\s[^>]*?)?\\sclass="${cls}"`, 'g')
      )) {
        if (!allowed.test(m[1])) {
          problems.push(
            `${path.relative('.', file)} puts class="${cls}" on a <${m[1]}>, ` +
              `which will take the form control's border and background`
          );
        }
      }
    }
  }

  assert.deepEqual(
    [...new Set(problems)],
    [],
    'give it a name of its own rather than borrowing a control class'
  );
});

test('every custom property a page uses is one the tokens define', () => {
  /**
   * `var(--font-mono)` appeared on four rules across two pages. There is no
   * such token — it is `--face-num` — so the browser fell back to its own
   * default monospace, which is a different face at a different weight and
   * looks close enough to pass.
   *
   * **An undefined custom property fails silently by design**: the browser
   * treats it as unset and moves on. Nothing errors, nothing warns, and the
   * page renders in whatever the platform happens to supply. That makes it
   * exactly the kind of fault this file exists for.
   *
   * Read from `tokens.css` rather than listed here, so a token added or
   * renamed there does not need a second edit — and so this cannot go stale
   * while continuing to pass (19.9).
   */
  const tokens = new Set(
    [...fs.readFileSync('src/styles/tokens.css', 'utf8').matchAll(/^\s*(--[\w-]+)\s*:/gm)]
      .map((m) => m[1])
  );

  assert.ok(tokens.size > 20, `read only ${tokens.size} tokens — widen the pattern`);

  const problems = [];

  for (const file of [...pages, 'src/styles/ui.css']) {
    const text = fs.readFileSync(file, 'utf8');

    for (const m of text.matchAll(/var\((--[\w-]+)/g)) {
      /* A page may define its own, and does: scoped styles declare a few
         locally. Only a name defined nowhere is a fault. */
      if (tokens.has(m[1])) continue;
      if (new RegExp(`${m[1]}\\s*:`).test(text)) continue;

      problems.push(`${path.relative('.', file)} uses ${m[1]}, which nothing defines`);
    }
  }

  assert.deepEqual([...new Set(problems)], [], 'the browser silently ignores an unknown token');
});

/* ── What each page offers, and to whom ─────────────────────────────────── */

test('the notebook page can reach its own export', () => {
  /* The export is this page printed, and when the page was reduced to the
     notebook and nothing else the control went with the four that belonged
     elsewhere. It was reachable from the overview and from the participation
     page, and not from the record it prints. */
  const notebook = fs.readFileSync('src/pages/app/project/[id].astro', 'utf8');
  assert.match(notebook, /href=\{`\/app\/project\/\$\{project\.id\}\/notebook\/`\}/);
});

test('somebody who is not an author is offered the way to write', () => {
  /* An elder or a teacher may write in a notebook, and the form sits below a
     block that can run to three cohorts and three entries. Reaching it by
     scrolling past the record is how an observation goes unwritten. */
  const notebook = fs.readFileSync('src/pages/app/project/[id].astro', 'utf8');
  assert.match(notebook, /href="#observe"/, 'the hero needs a way to the form');
  assert.match(notebook, /id="observe"/, 'and the form needs the anchor');
});

test('the export separates the authors\' record from observations', () => {
  /* A judge is asking what the student did. An observation is a note by
     somebody who is not an author of the project, which is already stored,
     and the plain copy is the authors\' own. */
  const exported = fs.readFileSync('src/pages/app/project/[id]/notebook.astro', 'utf8');

  assert.match(exported, /authorIds/, 'the export has to know who the authors are');
  assert.match(exported, /searchParams\.get\('observations'\)/, 'and which copy was asked for');
  assert.match(
    exported,
    /const shown = withObservations \? all : all\.filter/,
    'the plain copy is the default, so the common one answers the right question'
  );
});

test('a student with a project can start another', () => {
  /* The form was rendered only in the empty state, so the way to start a
     project vanished the moment somebody had one. A class is not a fair and
     only a fair refuses a student a second project. */
  const overview = fs.readFileSync('src/pages/app/index.astro', 'utf8');

  assert.match(overview, /Start another project/);

  /* Offered from a cohort that does not already hold their work, because a
     class keeps one place per student and the server refuses the second. */
  assert.match(overview, /startableCohorts/);
  assert.doesNotMatch(
    overview,
    /\{myMemberships\.map\(/,
    'the picker should read the startable cohorts rather than every membership'
  );
});

test('the oversight table says when the notebook was last written in', () => {
  /* Being behind on a notebook means not having written in three weeks, and
     the table could not say it: the link read `notebook` and gave no reason
     to open one. A date, not a computed standing (7.8).

     **Asserted on the date rather than on a column**, which is what the rule
     was always about. The table went from ten columns to four — ten does not
     fit a laptop, and a teacher dragging sideways lost the verdict and the
     verb off the right edge — and Notebook was one of the six that went. Its
     date moved onto the link in the title cell, which is where somebody
     opening a notebook was already clicking.

     Rewriting an assertion to match a change is usually how a guard dies.
     What makes it right here: the rule is that a teacher can see when the
     notebook was last written in, and that is still checked. */
  const overview = fs.readFileSync('src/pages/app/index.astro', 'utf8');
  assert.match(overview, /from\('field_notes'\)/, 'the count has to be read');
  assert.match(
    overview,
    /formatDate\(w\.notebook\.last/,
    'and the date has to be rendered somewhere on the row'
  );
});

test('a scoped role is not told it is looking at the school', () => {
  /* `watched` is filtered to the programs a person's roles name, so an elder
     of one class read a count of their class described as the school's. The
     number was right and the noun was wrong, on the line a teacher reads
     first. 22.27. */
  const overview = fs.readFileSync('src/pages/app/index.astro', 'utf8');

  const claims = [...overview.matchAll(/at the school/g)];
  assert.ok(claims.length > 0, 'the phrase should still exist for somebody unscoped');

  assert.match(
    overview,
    /const where = me\.anywhere\s*\n\s*\? 'at the school'/,
    'the claim has to be conditional on holding a role that reaches the school'
  );
});

test('the printed notebook says whose school it is', () => {
  /* The web pages open with the lockup and this did not, so a notebook
     handed to a judge named its school on the fifth line of a definition
     list. Not `Masthead.astro` itself, which carries navigation and a
     sign-out form: the same two elements, restated for paper. */
  const exported = fs.readFileSync('src/pages/app/project/[id]/notebook.astro', 'utf8');

  assert.match(exported, /class="lockup"/, 'the title page needs the lockup');
  assert.match(exported, /data-len=\{String\(org\.mark\.length\)\}/, 'sized by mark length');
  assert.match(exported, /\.lockup \.badge\[data-len='6'\]/, 'and a rule for the longest mark');
});

test('the printed page holds its margins where a print dialog cannot reach', () => {
  /* An `@page` margin alone was not enough: Chrome remembers the margin
     setting from whatever was printed last, and `Margins: None` overrides any
     stylesheet. Top and bottom have to stay in `@page`, because only a page
     margin repeats on every sheet; left and right live on the block, where
     nothing in the dialog can remove them. */
  const exported = fs.readFileSync('src/pages/app/project/[id]/notebook.astro', 'utf8');

  const page = exported.match(/@page \{\s*margin: ([^;]+);/);
  assert.ok(page, 'the export needs an @page rule');
  assert.match(page[1], /\b0\b/, 'the horizontal page margin belongs on the block');

  const book = exported.match(/\.book \{[^}]*padding: ([^;]+);[^}]*box-shadow: none/s);
  assert.ok(book, 'the print rule for .book should set padding');
  assert.match(book[1], /mm/, 'and it is a physical measure, because it is a page margin');
});

test('the masthead is one row wherever there is room for one', () => {
  /* `flex-wrap: wrap` was the whole answer, so the consent flag — about a
     hundred and fifty pixels of a row with none to spare — split the bar in
     two and left the rule between the sections in the middle of nowhere.
     Above the narrow breakpoint nothing wraps and the search field gives up
     width instead; below it, wrapping is the only honest behavior. */
  const ui = fs.readFileSync('src/styles/ui.css', 'utf8');
  const mast = fs.readFileSync('src/components/Masthead.astro', 'utf8');

  assert.match(ui, /\.mast-in \{ flex-wrap: nowrap; \}/, 'the outer row must not split');
  assert.match(mast, /\.mnav-bar \{ flex-wrap: nowrap; min-width: 0; \}/,
    'and the group must be allowed to shrink below its content');

  /* The field is what shrinks, and it can only do that if it is allowed to
     go smaller than its basis. A min-width removed here is a bar that
     overflows instead of wrapping, which is worse than what was there. */
  assert.match(mast, /\.mnav-find \{[^}]*min-width: [\d.]+rem/s, 'the search field sets a floor');
});

test('a pending guardian is visible on a page the server did not render', () => {
  /* The flag was rendered from the account, so it appeared on the app and
     not on the archive, the guides or the showcase — and a student waiting
     on a guardian is limited on all of them. The hint cookie already carries
     the name for exactly this reason; it carries the state beside it. */
  const hint = fs.readFileSync('src/lib/session-hint.ts', 'utf8');
  const mast = fs.readFileSync('src/components/Masthead.astro', 'utf8');

  assert.match(hint, /consentState/, 'the hint has to carry the state');
  assert.match(hint, /'pending' \|\| consentState === 'paused'/,
    'and write only the two states the masthead has a word for');

  assert.match(mast, /data-consent/, 'the prerendered cluster needs the element');
  assert.match(mast, /words\[state\]/, 'and the script has to choose the word');
});

test('the OAuth return address comes from configuration, not from a header', () => {
  /* `redirectTo` was built from `url.origin`, which is the Host the client
     sent — the one address on the deployment derived from a claim rather
     than from the tenant and the root domain. A request with an unexpected
     Host would build a return address to match it, and the only thing
     refusing the result would be Supabase's redirect allow list, which is a
     good backstop and a poor primary.
  
     `originFor` reads what the allow list is generated from, so the address
     sent to Google is on the list by construction rather than by two paths
     agreeing. The apex is its own case: the platform tenant is served at the
     root, and `originFor` would name a subdomain that does not exist. */
  const signin = fs.readFileSync('src/pages/auth/signin.ts', 'utf8');

  assert.match(signin, /originFor\(org\.subdomain \?\? org\.slug\)/, 'the tenant decides the origin');
  assert.match(signin, /org\.isPlatform \? apexOrigin\(\)/, 'and the apex is not a subdomain');
  assert.doesNotMatch(
    signin,
    /redirectTo:.*url\.origin/,
    'the Host header must not decide where Google returns somebody'
  );
});

test('the deadlines table has as many cells as it has headings', () => {
  /* Five headings and four cells: Status and Action were declared and one
     cell did both, so every row was short and the table carried a column
     that never held anything. Free on a wide screen, which is why it lasted,
     and part of why the page would not fit on a phone. */
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');

  const head = entry.slice(entry.indexOf('<table class="tbl phased">'));
  const headings = [...head.slice(0, head.indexOf('</thead>')).matchAll(/<th scope="col"/g)];

  /* From the data row, not from `<tbody>`. The first row after it is the
     phase heading, which is one `th` with a colspan and no cells at all —
     counting from there compared four headings against zero and failed on
     a table that was correct. */
  const row = head.slice(head.indexOf('group.rows.map('));
  const cells = [...row.slice(0, row.indexOf('</tr>')).matchAll(/<td[ >]/g)];

  assert.equal(cells.length, headings.length, 'a heading with no cell is an empty column');
  assert.match(head, /colspan="4"/, 'and the phase heading spans what is actually there');
});

test('the deadlines table stops being a table on a phone', () => {
  /* Four columns, one of them a form with a select and a button, is wider
     than a 390px screen — and a table that overflows widens the page rather
     than clipping, so every other section scrolls sideways with it. Not a
     horizontal scroller: this file already says why, of a different table.
     Stacked, each cell labelled by the heading it no longer sits under. */
  const entry = fs.readFileSync('src/pages/app/project/[id]/in/[program].astro', 'utf8');

  assert.match(entry, /data-label="Due"/, 'each cell carries its own heading');
  assert.match(entry, /data-label="Obligation"/);
  assert.match(entry, /data-label="Set by"/);
  assert.match(entry, /data-label="Status"/);

  assert.match(entry, /content: attr\(data-label\)/, 'and the narrow layout prints it');
  assert.match(
    entry,
    /@media \(max-width: 640px\) \{\s*\.phased,/,
    'the collapse belongs to the narrow breakpoint the rest of the page uses'
  );
});

test('every compliance surface says who is actually authoritative', () => {
  /* The platform reads a rulebook and works out which forms a project needs.
     That is useful and it is not authority: the Adult Sponsor signs, the SRC
     or IRB approves, the destination fair decides what it accepts, and any
     of them can be stricter than what is shown or can have changed since the
     template was written.
  
     The failure is specific. A student reads "nothing further required",
     does not ask their sponsor, and finds out at check-in — which is a
     season, against two lines of text.
  
     One component, so the wording is the same three authorities everywhere.
     The printed notebook restates it in its own styles, because that
     document carries no shared stylesheet and a component's CSS would print
     as nothing. */
  const surfaces = [
    'src/pages/app/project/[id]/in/[program].astro',
    'src/pages/app/program/[id].astro',
  ];

  for (const file of surfaces) {
    assert.match(
      fs.readFileSync(file, 'utf8'),
      /<Authority/,
      `${file} tells somebody what a rulebook requires and does not say who decides`
    );
  }

  const printed = fs.readFileSync('src/pages/app/project/[id]/notebook.astro', 'utf8');
  assert.match(printed, /remain authoritative/, 'the printed record needs it on the paper');

  /* And the sentence is one sentence. A second copy that drifts says
     something slightly weaker than the one beside it. */
  const component = fs.readFileSync('src/components/Authority.astro', 'utf8');
  assert.match(component, /Adult Sponsor, SRC\/IRB and\s+destination fair remain authoritative/);
});

test('a password reset says the same thing to everybody', () => {
  /* Whether an address has an account, and whether that account uses a
     password, are both things a stranger can learn by watching how this
     route replies. `signInWithPassword` already answers one way whoever is
     asking; this has to agree, or the pair of them still gives the answer.
  
     So the send is decided silently and the reply never varies — which
     means the result of `resetPasswordForEmail` must not be read. */
  const forgot = fs.readFileSync('src/pages/auth/forgot.ts', 'utf8');

  assert.doesNotMatch(
    forgot,
    /(const|let)\s*\{?\s*(data|error)[^\n]*await supabase\.auth\.resetPasswordForEmail/,
    'reading the result is how the reply comes to depend on it'
  );
  assert.match(forgot, /redirect\(`\/auth\/reset\/\?asked=1`/, 'one destination, always');
});

test('a Google account is not sent a password link', () => {
  /* Supabase will send a recovery link for an account that has never had a
     password, and following it sets one — turning one way in into two
     without anybody deciding that. `identities` records the provider for
     every way in that has been used, so it is the thing to ask. */
  const forgot = fs.readFileSync('src/pages/auth/forgot.ts', 'utf8');
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');

  /* Asked of the database, not read from the table.
  
     This selected from `identities` while signed out — a table whose only
     read policy is `identities_read_self` — so the query returned nothing
     for every address, and an empty result was read as "probably a password
     account". A Google-only account would have been mailed a link, and
     following it would have set a password on an account that never had
     one.
  
     An empty result and a negative answer are not the same thing, and this
     is the assertion that says so. */
  assert.doesNotMatch(
    forgot,
    /from\('identities'\)/,
    'a signed-out page cannot read that table and must not appear to'
  );
  assert.match(forgot, /rpc\('may_reset_password'/, 'it has to ask');
  assert.match(forgot, /mayReset === true/, 'and treat anything but a yes as a no');

  assert.match(sql, /and i\.provider = 'email'/, 'and the function has to check the provider');
});

test('the reset page builds its return address from the tenant', () => {
  /* Same reason as `signin.ts`: this address has to be the one on
     Supabase's redirect allow list, and deriving it from the request's Host
     means it can differ from the registered one in ways nothing catches. */
  const forgot = fs.readFileSync('src/pages/auth/forgot.ts', 'utf8');

  assert.match(forgot, /originFor\(org\.subdomain \?\? org\.slug\)/);
  assert.doesNotMatch(forgot, /redirectTo:.*url\.origin/);
});

test('a deletion is confirmed against something only its owner knows', () => {
  /* GitHub asks for a repository's name so that muscle memory cannot supply
     it. The equivalent here is the person's own address — and it is checked
     again on the server, because a screen is not a guard. */
  const route = fs.readFileSync('src/pages/app/account/delete.ts', 'utf8');

  assert.match(route, /typed !== expected/, 'the typed confirmation is compared server side');
  assert.match(route, /session\.email/, 'against the address on their own session');

  /* And the account acted on is never named by the request. A parameter
     here would mean the secret key could be pointed at anybody. */
  assert.match(route, /p_user_id: account\.id/);
  assert.doesNotMatch(
    route,
    /form\.get\('user_id'\)|p_user_id: .*form/,
    'whose account is deleted must come from the session, never from the body'
  );
});

test('the three things outside SQL are done by the route', () => {
  /* `delete_account` removes rows. The files, the authentication record and
     the search index are not rows, and the legal review names all three. A
     passing DB suite says nothing about any of them. */
  const route = fs.readFileSync('src/pages/app/account/delete.ts', 'utf8');

  assert.match(route, /bucket\.delete\(key\)/, 'the orphaned files have to be removed');
  assert.match(route, /auth\.admin\.deleteUser/, 'and the authentication record');

  /* Rows first. A failure the other way leaves rows pointing at files that
     are gone, which is a broken page for everybody else on a shared
     project. */
  assert.ok(
    route.indexOf("rpc('delete_account'") < route.indexOf('bucket.delete'),
    'the rows go before the files'
  );
});

test('nothing is deleted while somebody has still to answer', () => {
  /* The screen hides the form, and the route checks anyway: two different
     failures, and only one of them is visible. */
  const route = fs.readFileSync('src/pages/app/account/delete.ts', 'utf8');
  const screen = fs.readFileSync('src/pages/app/account/index.astro', 'utf8');

  /* Asked of the database, not selected from the table.
  
     The route used to read `account_deletion_approvals` directly, and the
     read policy on it exposes rows where the caller is the *approver* — not
     the person leaving. It counted approvals somebody was waiting to answer
     for other people, which is almost always none, so the guard passed and
     meant nothing. A query whose result is inverted from what its variable
     is called is the hardest kind to see. */
  assert.doesNotMatch(
    route,
    /from\('account_deletion_approvals'\)/,
    'that policy exposes the approver\'s rows, not the requester\'s'
  );
  assert.match(route, /rpc\('deletion_ready'\)/, 'the route has to ask');
  assert.match(route, /Number\(ready\.waiting\) > 0/, 'and act on the answer');
  assert.match(route, /Nothing has been deleted/, 'and say so plainly');
  assert.match(screen, /\{!needsAsking && \(/, 'the form appears only when nothing is shared');
});

test('nothing renders Markdown except the one renderer', () => {
  /* `RecordDetail.astro` called `marked.parse` directly, so a manuscript
     containing a literal script tag was published as a script tag — on the
     one surface where the author and the reader are different people.
  
     `tests/markdown.mjs` proves the renderer is safe. This proves nothing
     goes around it, which is the half a hostile-input suite cannot see. */
  /* Components as well as pages. `pages` walks `src/pages` only, and the
     file that had this bug lives in `src/components` — a suite that reads
     one directory cannot find a fault in the other. */
  const everywhere = pages.concat(walk('src/components'), walk('src/lib'));

  for (const file of everywhere) {
    const text = fs.readFileSync(file, 'utf8');

    /* The one place allowed to, and the reason the others need not. */
    if (path.basename(file) === 'notes.ts') continue;

    assert.doesNotMatch(
      text,
      /marked\.parse\(/,
      `${path.relative('.', file)} parses Markdown itself instead of using renderMarkdown`
    );
  }
});

test('setting a password needs a recovery link, not merely a session', () => {
  /* The page rendered its form whenever `getSession()` returned anything,
     and `updateUser({ password })` succeeds for any signed-in session. So
     somebody who had signed in with Google and never had a password could
     open this address and set one — two ways in, created without following
     any link and without the account's owner being asked. */
  const reset = fs.readFileSync('src/pages/auth/reset.astro', 'utf8');

  assert.match(reset, /const recovering = Boolean\(session\) &&/, 'a session alone is not enough');
  assert.match(reset, /cookies\.get\(RECOVERY\)/, 'the exchange has to have left proof');
  assert.match(reset, /if \(!recovering\)/, 'and the POST has to require it');

  /* httpOnly so no script can mint it, and cleared when spent so the window
     does not outlive what it was opened for. */
  assert.match(reset, /httpOnly: true/);
  assert.match(reset, /cookies\.delete\(RECOVERY/);
});

test('a school that admits by invitation requires one', () => {
  /* `signup_mode` had three values and `complete_signup` read none of them:
     a school set to `invite` accepted anybody who reached its subdomain.
     The mode was a label on a record with nothing enforcing it, and for such
     a school it is the entire admission policy. */
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');
  const signup = sql.slice(sql.indexOf('create or replace function public.complete_signup('));
  const body = signup.slice(0, signup.indexOf('$$;'));

  assert.match(body, /v_org\.signup_mode = 'invite'/, 'the mode has to be read');
  assert.match(body, /from public\.role_reservations/, 'and an invitation looked for');
  assert.match(body, /r\.claimed_at is null/, 'an invitation being one person\'s');
});

test('a refused under-13 signup leaves no identity behind', () => {
  /* The age question is asked after sign-in, because there is nowhere to ask
     it before — so by the time the answer arrives, Google or a password has
     already created a row in `auth.users`. Refusing and leaving it there
     means a twelve year old holds an authentication record at a service that
     has just told them it kept nothing. */
  const welcome = fs.readFileSync('src/pages/app/welcome.astro', 'utf8');

  assert.match(welcome, /auth\.admin\.deleteUser\(uid\)/, 'the identity has to be removed');
  assert.match(welcome, /if \(gone\) console\.error/, 'and the result checked, not assumed');
  assert.match(welcome, /await supabase\.auth\.signOut\(\)/, 'and the session ended');

  /* And the log says what happened without saying who. Whose refusal it was
     is exactly the thing not to write down about a child just declined. */
  assert.doesNotMatch(
    welcome,
    /console\.error\([^)]*(uid|email|session\.)/,
    'the log must not identify the person'
  );
});

test('no upload boundary trusts what the browser said a file was', () => {
  /* `file.type` and `file.name` are whatever the person posting put in the
     multipart body. An HTML page named `figure.png` and declared
     `image/png` was stored as an image and served from our origin. */
  const boundaries = [
    'src/pages/app/project/[id]/in/[program].astro',
    'src/pages/app/project/[id]/manuscript.astro',
    'src/pages/app/project/[id].astro',
  ];

  for (const file of boundaries) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes('blob.put(')) continue;

    assert.match(text, /await identify\(file\)/, `${file} stores without reading the bytes`);
    assert.doesNotMatch(
      text,
      /blob\.put\([^)]*file\.type/,
      `${file} stores the type the browser claimed`
    );
  }
});

test('media is served as bytes, not as a document', () => {
  /* A PDF opened inline runs in an origin holding somebody's notebook, and a
     type this route did not expect should never render as a document at
     all. */
  const media = fs.readFileSync('src/pages/app/media/[...path].ts', 'utf8');

  assert.match(media, /'X-Content-Type-Options': 'nosniff'/);
  assert.match(media, /attachment; filename=/, 'anything not an image is handed over');
  assert.match(media, /default-src 'none'; sandbox/, 'and nothing in it may run');
});

test('the privacy page does not claim more than the pages do', () => {
  /* It said reading the site stores nothing about you at all, while every
     page requests Google Fonts — which sends an IP address and a browser
     string to Google before anybody has clicked anything.
  
     The claim and the request are checked against each other rather than
     each being read alone, so self-hosting the fonts later lets the stronger
     sentence come back, and adding a third-party request tomorrow fails
     here rather than making the page untrue. */
  const privacy = fs.readFileSync('src/pages/[org]/policies/privacy.astro', 'utf8');
  const base = fs.readFileSync('src/layouts/Base.astro', 'utf8');

  const thirdParty = /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(base);

  if (thirdParty) {
    assert.match(
      privacy,
      /Google Fonts/,
      'the pages contact Google and the privacy page does not say so'
    );
  }
});

test('a deletion reports what it could not finish', () => {
  /* `deleteUser` returns `{ error }` rather than throwing, so the try/catch
     around it caught nothing and a failure to remove the authentication
     record was reported as success — leaving somebody able to sign in again
     after being told their account was permanently deleted.
  
     Neither can be undone from the route, because the row that would find
     them is already gone. So both are logged, loudly and without naming
     anybody: a failure nobody records is a failure nobody fixes. */
  const route = fs.readFileSync('src/pages/app/account/delete.ts', 'utf8');

  assert.match(route, /const \{ error: authError \} = await admin\.auth\.admin\.deleteUser/);
  assert.match(route, /if \(authError\) console\.error/, 'the result has to be read');
  assert.match(route, /stranded\.push\(key\)/, 'and a file that would not delete counted');
});

test('deleting an account takes its published pages down', () => {
  /* Rows in `records` going away changes nothing a reader can see: the
     archive is static, so a withdrawn record stays at its address, stays in
     the search index, and merely stops being listed — the worst of the three
     states, because it is still readable and no longer reachable by anybody
     who could ask for it to come down. */
  const route = fs.readFileSync('src/pages/app/account/delete.ts', 'utf8');
  const store = fs.readFileSync('src/lib/records-store.ts', 'utf8');
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');

  assert.match(sql, /'published', v_records/, 'the function has to name them');
  assert.match(store, /export function withdraw/, 'and the store has to be able to remove one');
  assert.match(route, /withdraw\(manifest, record\.id\)/, 'and the route has to do it');

  /* Listed, not derived. A record's directory accumulates figures and
     regenerated files, and deriving the names deletes the ones this code
     happens to know about. */
  assert.match(store, /export async function objectsFor/);
  assert.match(route, /objectsFor\(bucket, org, record\)/);

  /* The manifest is read once and written once, however many records go. A
     read-modify-write per record is a race with itself. */
  const reads = [...route.matchAll(/readManifest\(/g)].length;
  assert.equal(reads, 1, 'the manifest is read once, outside the loop');
});

test('both sides of a deletion request have a control', () => {
  /* The functions existed and nothing could call them: a student with a
     co-authored project reached a page that told them what was needed and
     gave them no way to ask, and a co-author had no way to answer. */
  const screen = fs.readFileSync('src/pages/app/account/index.astro', 'utf8');

  assert.match(screen, /rpc\('request_account_deletion'/, 'asking has to be possible');
  assert.match(screen, /rpc\('answer_deletion_approval'/, 'and so does answering');
  assert.match(screen, /name="act" value="leave"/, 'and leaving without asking');

  /* The screen asks the database what its own request is waiting on, for the
     same reason the route does: reading the approvals table here answers a
     different question that looks like the right one. */
  assert.match(screen, /rpc\('deletion_ready'\)/);
});

test('no braced comment sits among an element\'s attributes', () => {
  /* In attribute position the parser is reading attributes, so a brace opens
     an expression and the closing sequence closes nothing. It surfaces as
     "unterminated string literal" twenty lines further on, at a line holding
     no string — and the checker then reports a cascade of nonsense for the
     whole file, which is how one of these hid in `editorial/[id].astro`
     while its errors were dismissed as a parser artifact.
  
     A comment opening on a line whose previous non-blank line ends in a tag
     name or an attribute, rather than in `>` or `}`, is one of these. */
  const problems = [];

  for (const file of pages.concat(walk('src/components'), walk('src/layouts'))) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');

    lines.forEach((line, i) => {
      if (!line.trim().startsWith('{/*')) return;

      let back = i - 1;
      while (back >= 0 && lines[back].trim() === '') back -= 1;
      if (back < 0) return;

      const before = lines[back].trim();

      /* Inside a tag: the previous line opened one and has not closed it. */
      if (/^<[a-zA-Z][^>]*$/.test(before) || /=[^>]*$/.test(before)) {
        problems.push(`${path.relative('.', file)}:${i + 1}`);
      }
    });
  }

  assert.deepEqual(problems, [], 'move the comment above the element');
});

/**
 * **A recipient's own action must be dispatched before the staff gate.**
 *
 * `/app/` handles its POSTs as one `else if` chain, and part way down sits
 * `!me.runsTheClub`, which refuses anybody who is not an officer or the
 * advisor. Everything below it is staff work. `ack` was below it and is the
 * opposite: the card offers "I have this" only where there is nobody to pass
 * the ask to, which is a student, so the one branch reserved for students was
 * reachable only by the people it is never shown to. Every student who
 * pressed it was told that only an officer or their advisor can do that,
 * about a request addressed to them by name.
 *
 * Ordering rather than a permission check, because the permission is already
 * right: `acknowledge_nudge` hard-codes `recipient_id = auth.uid()`. The
 * chain was the only thing in the way.
 */
test('a nudge recipient can answer before the staff gate refuses them', () => {
  const source = fs.readFileSync('src/pages/app/index.astro', 'utf8');

  /* **The whole statement, not the token.**

     This anchored on `!me.runsTheClub` alone and found it first inside the
     comment above `ack`, which explains the bug by naming the gate. So the
     measured position was a sentence about the code rather than the code, and
     the `ack` assertion passed for that reason rather than for the right one.
     19.9 has this one twice already: a rule that reads prose, and a guard
     satisfied by an unrelated line elsewhere in the file. */
  const gate = source.indexOf('} else if (!me.runsTheClub) {');
  assert.notEqual(gate, -1, 'the staff gate was not found');
  assert.equal(
    source.indexOf('} else if (!me.runsTheClub) {', gate + 1),
    -1,
    'the gate anchor is not unique'
  );

  /* Both halves of the nudge loop. `ack` is offered only to somebody who
     runs nothing, and `nudge` says in its own comment that the database
     decides who may be reached — so neither belongs behind a role check. */
  for (const branch of ["action === 'ack'", "action === 'nudge'"]) {
    const at = source.indexOf(branch);
    assert.notEqual(at, -1, `${branch} was not found`);
    assert.equal(source.indexOf(branch, at + 1), -1, `the ${branch} anchor is not unique`);
    assert.ok(at < gate, `${branch} is dispatched after the staff gate`);
  }
});

/**
 * **The answer belongs below the nav, beside the thing it is about.**
 *
 * Every form on this page posts to `#outcome`, so the browser sends the
 * reader to it. The anchor sat at the top of `.wrap`, outside the signed-in
 * half, so a message about one card among forty painted itself above the
 * masthead. Nothing sets `error2` or `attached` without an account, so the
 * anchor belongs inside that half, after the nav.
 */
test('the outcome anchor sits below the app nav, not above the masthead', () => {
  const source = fs.readFileSync('src/pages/app/index.astro', 'utf8');

  const shell = source.indexOf('<AppShell org=');
  const outcome = source.indexOf('id="outcome"');

  assert.notEqual(shell, -1, 'the app nav was not found');
  assert.notEqual(outcome, -1, 'the outcome anchor was not found');
  assert.equal(source.indexOf('id="outcome"', outcome + 1), -1, 'the anchor is not unique');

  assert.ok(outcome > shell, 'the outcome anchor renders above the nav');
});

console.log(`${passed} ordering assertions passed. ${pages.length} pages read.`);
