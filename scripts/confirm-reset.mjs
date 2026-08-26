/**
 * WHAT THIS RESET IS ABOUT TO DESTROY, BEFORE IT DOES.
 *
 * `npm run reset` drops a database and recreates it, and which database that
 * is depends on `.dev.vars`, on the shell, and on which of those won. All
 * three are invisible at the moment somebody types the command — and the one
 * that decides is usually the one they have forgotten about.
 *
 * So: print the target, say where the value came from, and ask. A y/n after
 * seeing the address is a different act from a y/n before it.
 *
 * **The loopback check is not the confirmation.** It refuses outright, and
 * that stays: an accidental cloud address here is not a thing to offer
 * somebody a choice about at eleven at night. The prompt is for the ordinary
 * case, where the target is correct and worth reading anyway.
 *
 * `--yes` skips the prompt, for a chain that has already asked.
 *
 * Run: node scripts/confirm-reset.mjs
 */

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { loadDevVars } from './dev-vars.mjs';

const fromFile = loadDevVars();

const URL = process.env.PUBLIC_SUPABASE_URL ?? '(not set)';
const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL);

const source = fromFile.includes('PUBLIC_SUPABASE_URL')
  ? '.dev.vars'
  : fs.existsSync('.dev.vars')
    ? 'the shell, which wins over .dev.vars'
    : 'the shell (there is no .dev.vars)';

console.log(`
  Database    ${URL}
  From        ${source}

  This drops every table and recreates it from the migration, empties file
  storage, and removes every account. Then it seeds the organizations and
  their programs, the fixture people and every demonstration situation into
  the demo tenant alone, the published records, and any advisor accounts in
  local-data/people.yaml.

  Monta Vista, SVSLC and the platform come back with their programs and
  nobody in them. That is deliberate: they are about to hold real students.
`);

if (!loopback) {
  console.error(
    `  That is not a local address, and \`npm run reset\` only ever runs against\n` +
      `  the local stack. For a cloud project: npm run reset:cloud\n`
  );
  process.exit(1);
}

if (process.argv.includes('--yes')) process.exit(0);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('  Proceed? (y/n) ')).trim().toLowerCase();
rl.close();

if (answer !== 'y' && answer !== 'yes') {
  console.log('\n  Stopped. Nothing has been changed.\n');
  process.exit(1);
}

console.log('');
