#!/usr/bin/env node
/**
 * STOP EVERYTHING AND BRING IT BACK.
 *
 * The local stack half-dies. `supabase db reset` restarts a subset of the
 * containers at the end, and when one of them does not come back the CLI
 * says so in a line above a table of URLs that all look correct:
 *
 *   Stopped services: [supabase_kong_SciPath supabase_imgproxy_SciPath ...]
 *   supabase local development setup is running.
 *
 * Kong is the API gateway on 54321. With it stopped, `supabase status` still
 * prints every address, the database is genuinely healthy, and every seed
 * fails with a refused connection.
 *
 * ── Why this is its own command ─────────────────────────────────────────
 *
 * **`supabase start` does not fix it.** It sees a project it considers
 * running, prints `supabase start is already running`, lists the stopped
 * services, and exits 0 without starting anything. So the obvious remedy is
 * a no-op in exactly the state that needs it, which is worse than an error:
 * somebody runs it, reads "already running", and concludes the diagnosis was
 * wrong.
 *
 * What works is a full stop and a full start. That is a bigger act than
 * `db:start` and a different one from `reset`, so it gets its own name rather
 * than being folded into either. `reset` stays exactly as it is: it drops
 * data, this does not, and a command that sometimes drops data and sometimes
 * does not is a command nobody can type confidently.
 *
 * ── What it does not do ─────────────────────────────────────────────────
 *
 * Nothing to your data. `supabase stop` keeps the volume, so the database
 * comes back holding what it held. If it comes back empty, that is worth
 * knowing and `npm run reset` is the answer; this command will not have been
 * the cause.
 *
 * Run: npm run restart
 */

import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';

import { loadDevVars } from './dev-vars.mjs';
import { requireDocker, supabaseContainers } from './docker.mjs';
import { waitForApi } from './api-ready.mjs';

const fromFile = loadDevVars();

/* Before anything is described, let alone stopped. Every sentence below
   assumes a runtime, and without one this should say so rather than describe
   containers it cannot see. */
requireDocker();

const API = process.env.PUBLIC_SUPABASE_URL ?? '(not set)';
const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(API);

const source = fromFile.includes('PUBLIC_SUPABASE_URL')
  ? '.dev.vars'
  : 'the shell, which wins over .dev.vars';

/* The same refusal `confirm-reset` makes, for the same reason. This one
   cannot reach a cloud project — it drives local containers and a hosted
   project has none — but printing a cloud address and then restarting
   something else entirely is the confusion worth refusing outright. */
if (!loopback) {
  console.error(
    `\n  PUBLIC_SUPABASE_URL is ${API}, from ${source}.\n\n` +
      '  This restarts the local containers and cannot act on a hosted\n' +
      '  project, so a cloud address here means the environment is not the\n' +
      '  one you think it is. Nothing has been changed.\n'
  );
  process.exit(1);
}

const before = supabaseContainers();

/* What is actually true right now, not what the CLI's summary implies.
   `supabase status` prints the whole table of addresses whether or not the
   thing serving them is running, which is how a stopped gateway reads as a
   healthy stack. */
const describe = () => {
  if (!before.known) return '  Containers  could not be read from Docker';
  if (before.running.length === 0 && before.stopped.length === 0) {
    return '  Containers  none exist';
  }

  const lines = [`  Running     ${before.running.length}`];

  if (before.stopped.length > 0) {
    lines.push(`  Stopped     ${before.stopped.length}`);
    for (const name of before.stopped) lines.push(`              ${name}`);
  }

  return lines.join('\n');
};

const probe = await waitForApi({ url: API, timeout: 2000, log() {} });

/* Built above the template rather than inside it.
 
   `tests/scripts.mjs` blanks strings before looking for calls, and its
   template-literal pattern stops at the first backtick it meets, so a
   template nested inside another leaves its tail exposed as code: the phrase
   `not answering (` read as a call to a function named `answering`. The rule
   is right about the class it guards and wrong about nesting; keeping the
   nesting out of the file is cheaper than changing a tokenizer that 27 other
   scripts are checked by. */
const apiLine = probe.ok ? probe.detail : `not answering, ${probe.detail}`;
const port = new URL(API).port || '54321';

console.log(`
  Stack       ${API}
  From        ${source}
  API         ${apiLine}
${describe()}

  This stops every container and starts them again. It does not drop the
  database: the volume survives a stop, so the data comes back with it.

  Use this when a container is stopped and \`supabase start\` reports the
  project as already running, which is the one state that reports itself
  as healthy while nothing answers on ${port}.
`);

if (!process.argv.includes('--yes')) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('  Proceed? (y/n) ')).trim().toLowerCase();
  rl.close();

  if (answer !== 'y' && answer !== 'yes') {
    console.log('\n  Stopped. Nothing has been changed.\n');
    process.exit(1);
  }
}

console.log('');

/** The CLI, inheriting the environment `loadDevVars` has already filled. */
function cli(args) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['supabase', ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/* `stop` first, and its failure is not fatal.
 
   A stack with a container already gone can answer non-zero here while
   having done exactly what was asked, and refusing to start again because
   the stop was untidy would leave somebody worse off than before they ran
   this. The start is the step that has to work, and the probe after it is
   what decides whether this succeeded. */
const stopped = await cli(['stop']);
if (stopped !== 0) {
  console.log('\n  The stop reported a problem. Starting anyway.\n');
}

const started = await cli(['start']);

if (started !== 0) {
  console.error('\n  The stack did not start. Its output above says why.\n');
  process.exit(1);
}

/* The CLI prints its table of addresses on the way out whether or not the
   gateway is behind them, so the run is not over until something answers.
   This is the assertion the whole command exists to make. */
const ready = await waitForApi({
  url: API,
  key: process.env.SUPABASE_SECRET_KEY,
  timeout: 60_000,
});

const after = supabaseContainers();

if (!ready.ok) {
  console.error(
    `\n  The API at ${API} still did not answer, ${Math.round(ready.waitedMs / 1000)}s ` +
      'after the start.\n' +
      (after.known && after.stopped.length > 0
        ? `  These are not running:\n\n` +
          after.stopped.map((name) => `      ${name}`).join('\n') +
          `\n\n  Its own log says why:  docker logs ${after.stopped[0]}\n`
        : '  Check: npx supabase status\n')
  );
  process.exit(1);
}

console.log(
  `\n  The API at ${API} ${ready.detail}` +
    (after.known ? `, ${after.running.length} containers running` : '') +
    '.\n'
);
