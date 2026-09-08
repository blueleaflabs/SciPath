/**
 * Embeds that PostgREST cannot resolve.
 *
 * `select('..., users(display_name)')` asks PostgREST to follow a foreign key
 * from this table to `users`. If the table has two of them, there is no way
 * to know which, and PostgREST refuses the whole query rather than guessing.
 *
 * The failure is quiet in the worst way. The request returns an error, the
 * page destructures `data` and gets null, and the section renders as though
 * the answer were "none". `reviews` has `reviewer_id` and `assigned_by`, so
 * an editor's page showed no reviews at all while the reviews sat in the
 * table.
 *
 * The fix is to name the constraint, `users!reviews_reviewer_id_fkey(...)`.
 * This finds the ones that have not been named.
 *
 * Run: npm run test:embeds
 */

import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = 'supabase/migrations';
const ROOTS = ['src/pages', 'src/components', 'src/lib', 'src/layouts'];

/* table -> referenced table -> how many foreign keys point at it */
const links = new Map();

function note(from, to) {
  const perTable = links.get(from) ?? new Map();
  perTable.set(to, (perTable.get(to) ?? 0) + 1);
  links.set(from, perTable);
}

for (const file of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

  for (const block of sql.matchAll(/create table public\.([a-z_]+)\s*\(([\s\S]*?)\n\);/g)) {
    const [, table, body] = block;
    for (const ref of body.matchAll(/references\s+public\.([a-z_]+)/g)) {
      note(table, ref[1]);
    }
  }

  for (const block of sql.matchAll(/alter table (?:only )?public\.([a-z_]+)([\s\S]*?);/g)) {
    const [, table, body] = block;
    for (const ref of body.matchAll(/add column[\s\S]*?references\s+public\.([a-z_]+)/g)) {
      note(table, ref[1]);
    }
  }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(astro|ts|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const problems = [];
let checked = 0;

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;

  for (const file of walk(root)) {
    const source = fs.readFileSync(file, 'utf8');

    /* .from('table') ... .select('...') within the same chain. Selects are
       written on one line or as a template, so this reads to the closing
       quote of the select argument. */
    for (const chain of source.matchAll(
      /\.from\(\s*'([a-z_]+)'\s*\)[\s\S]{0,400}?\.select\(\s*(?:\/\*[\s\S]*?\*\/\s*)?'([^']*)'/g
    )) {
      const [, table, selection] = chain;
      const targets = links.get(table);
      if (!targets) continue;

      /* Embeds nest: projects(project_authors(users(id))) asks three
         different tables three different questions. An embed belongs to
         whichever table opened the parenthesis it sits inside, not to the
         one in .from(), so this walks the string keeping a stack. */
      const stack = [table];
      let word = '';

      for (const char of selection) {
        if (/[a-z_!]/.test(char)) {
          word += char;
          continue;
        }

        if (char === '(') {
          const parent = stack[stack.length - 1];
          /* A ! means the constraint has been named, which is the fix. */
          const named = word.includes('!');
          const to = word.split('!')[0];
          const count = links.get(parent)?.get(to);

          if (count) {
            checked += 1;
            if (count > 1 && !named) {
              problems.push(
                `${file}\n    ${parent} embeds ${to}(), and ${parent} has ${count} foreign keys to ${to}.\n` +
                  `    PostgREST cannot choose, so the whole query fails and the page renders empty.\n` +
                  `    Name the constraint: ${to}!${parent}_<column>_fkey(...)`
              );
            }
          }

          stack.push(to);
          word = '';
          continue;
        }

        if (char === ')') {
          if (stack.length > 1) stack.pop();
        }

        word = '';
      }
    }
  }
}

/* A filter on the embedded side of an `!inner` embed — `.eq('participations.project_id', …)`
   — is answered by scanning the outer table through the row policy before
   the join (2.9): every row of every tenant's, each one a `can_see_project`
   call. The load test found it twice (896 ms on the Workbench, 30–65 ms on
   every project page). Filter the outer table on its own indexed column,
   or read from the other side, as src/lib/sponsors.ts does. */
const embedFilter = /\.(eq|in|neq|is|gte|lte|gt|lt|not|contains|overlaps)\('([a-z_]+(?:\.[a-z_]+)*)\.[a-z_]+'/g;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(embedFilter)) {
      problems.push(`${file}\n    filters on the embedded ${m[2]} (${m[0]}…): PostgREST scans the outer table through its policy first. Filter the outer table's own column instead.`);
    }
  }
}

/* An order on a function's rows by a column the select does not name
   (2.9). On a table PostgREST orders by any column of the table; on the
   rows of an rpc (`milestones_of`, `projects_i_see`, `places_in`) it orders
   only by a column the select carries, and refuses the whole read
   otherwise — "column projects.created_at does not exist" — which a page
   that drops the error renders as nothing. The hosted site showed every
   Elder an empty care list this way while the database test, which asks
   the function in SQL, passed. Reproduced against PostgREST 13 with the
   same chain; the select names what the order uses, or the order goes. */
let rpcOrders = 0;
const rpcChain = /\.rpc\(\s*'([a-z_]+)'[\s\S]{0,300}?\.select\(\s*(?:\/\*[\s\S]*?\*\/\s*)?'([^']*)'([\s\S]*?)(?:;|\)\s*:|\bawait\b)/g;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(rpcChain)) {
      const [, fn, selection, rest] = m;
      /* The top-level columns of the select: what is outside every
         parenthesis, `alias:column` read as the column. */
      const top = new Set();
      let depth = 0;
      let word = '';
      for (const char of `${selection},`) {
        if (char === '(') { depth += 1; word = ''; continue; }
        if (char === ')') { depth -= 1; word = ''; continue; }
        if (char === ',' && depth === 0) {
          const name = word.trim().split(':').pop().split('!')[0].trim();
          if (name) top.add(name);
          word = '';
          continue;
        }
        if (depth === 0) word += char;
      }
      for (const o of rest.matchAll(/\.order\(\s*'([a-z_.]+)'/g)) {
        rpcOrders += 1;
        const column = o[1];
        if (column.includes('.')) continue; /* an embedded side's column: PostgREST's own rules */
        if (!top.has(column) && !top.has('*')) {
          problems.push(`${file}\n    orders the rows of rpc('${fn}') by ${column}, which its select does not name. PostgREST refuses the whole read on a function's rows; add ${column} to the select.`);
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('\nAmbiguous embeds:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} found.\n`);
  process.exit(1);
}

console.log(`${checked} embeds checked against ${links.size} tables. Every one resolves; ${rpcOrders} orders on rpc rows are on selected columns.`);
