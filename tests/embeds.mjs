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

if (problems.length > 0) {
  console.error('\nAmbiguous embeds:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} found.\n`);
  process.exit(1);
}

console.log(`${checked} embeds checked against ${links.size} tables. Every one resolves.`);
