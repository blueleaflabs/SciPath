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

test('a public page ends with a way in', () => {
  /* One file rather than two: `/deadlines/` is withdrawn. The rule is
     unchanged — a page that explains the work and then stops is a page that
     sends somebody back to a search engine. */
  const page = fs.readFileSync('src/pages/[org]/mistakes.astro', 'utf8');
  assert.match(page, /class="sec cta"/, 'no call to action');
  assert.match(page, /href="\/app\//, 'no link to signing in');

  /* And the season list on the front page, which is where the withdrawn one
     sent people. */
  const home = fs.readFileSync('src/pages/index.astro', 'utf8');
  assert.match(home, /Sign in to join one/);
});

test('no public page claims what nothing has earned', () => {
  /* This guarded `/for-schools/`, which is hidden: it was a pitch to a
     teacher written before the product had met one, and a pitch that has
     never met its audience is a guess (23.4). The rule outlives the page and
     applies to every public page instead, which is where it should have been.

     Numbers are the same argument. "28 deadlines across 3 programs" is a
     claim, and a claim typed into a page drifts away from the software the
     week somebody adds a program. */
  for (const file of ['src/pages/index.astro', 'src/pages/[org]/about.astro',
                      'src/pages/[org]/mistakes.astro']) {
    const page = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(page, /\b(hundreds|thousands|schools trust|trusted by)\b/i,
      `${file}: nothing here has users yet, so nothing here may imply it`);
  }
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
     to open one. A date, not a computed standing (7.8). */
  const overview = fs.readFileSync('src/pages/app/index.astro', 'utf8');
  assert.match(overview, /from\('field_notes'\)/, 'the count has to be read');
  assert.match(overview, /<th scope="col">Notebook<\/th>/, 'and the column has to exist');
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

console.log(`${passed} ordering assertions passed. ${pages.length} pages read.`);
