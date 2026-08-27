#!/usr/bin/env node
/**
 * The Supabase CLI, with `.dev.vars` in its environment.
 *
 * `supabase/config.toml` substitutes `env(GOOGLE_CLIENT_ID)` when the
 * containers start, reading the **shell**. That used to work because the
 * instructions said to run `set -a; source .dev.vars; set +a` first.
 *
 * Then the node scripts learned to read `.dev.vars` themselves, so sourcing
 * became unnecessary for them and the habit stopped — and the CLI, which
 * nothing had taught, started receiving an empty client id. Google's answer
 * to an empty client id is `invalid_client`, which reads as a broken OAuth
 * setup rather than a missing variable.
 *
 * The lesson is narrower than "read the file": **everything that needs the
 * configuration has to get it the same way**, including the things that are
 * not ours.
 *
 * Usage: node scripts/supabase.mjs db reset
 */

import { spawn } from 'node:child_process';
import { loadDevVars } from './dev-vars.mjs';
import { requireDocker } from './docker.mjs';

const applied = loadDevVars();

/**
 * **BEFORE ANYTHING IS SPAWNED, AND ONLY FOR THE LOCAL STACK.**
 *
 * The local stack is containers, and the CLI's answer to a missing daemon
 * names the socket it could not open rather than the application that is not
 * running — the same failure mode as `invalid_client` above, reported by the
 * layer that noticed instead of the layer that knows what it means.
 *
 * **This ran unconditionally, and that was wrong.** The note here claimed
 * every command routed through this file needs the local stack, and listed
 * the ones in `package.json` as evidence. `reset-cloud.mjs` also spawns this
 * file — for `db reset --linked`, which targets the hosted project and needs
 * no container at all — and it was not in that list because the list was
 * read off the wrong source. So a cloud reset stopped partway through, after
 * the confirmation, with a message telling somebody to start Docker Desktop
 * for a command that never wanted it.
 *
 * That is the exact failure the diagnosis in `api-ready.mjs` was written to
 * avoid: a wrong answer sends somebody to fix the wrong thing, and when that
 * changes nothing they conclude the tool is broken.
 *
 * `--linked` is the discriminator, and it is the CLI's own vocabulary rather
 * than a list of subcommands this repository maintains. A list would have
 * grown a case the next time a script spawned this file, which is precisely
 * what just happened.
 */
if (!process.argv.includes('--linked')) {
  requireDocker();
}

/* Named once, because a missing one produces an error from Google rather than
   from here, and nothing in that error says which variable is absent. */
const OPTIONAL = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const missing = OPTIONAL.filter((name) => !process.env[name]);

if (missing.length > 0) {
  console.log(
    `Note: ${missing.join(' and ')} not set, so Google sign-in will not work ` +
      'locally. Password sign-in is unaffected. See .dev.vars.example.'
  );
}

const child = spawn('npx', ['supabase', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', async (code) => {
  /* After a reset, check that the running container agrees with the file.
     `supabase/config.toml` is read when the auth container STARTS, and a
     reset restarts the database rather than rebuilding that configuration,
     so a container that came up before these variables existed keeps the
     empty value it was given. Nothing says so, and Google's answer to an
     empty client id is `invalid_client`, which reads as a broken OAuth
     setup. */
  if (code === 0 && process.env.GOOGLE_CLIENT_ID) {
    await warnIfContainerIsStale();
  }
  process.exit(code ?? 1);
});
async function warnIfContainerIsStale() {
  const url = process.env.PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';

  try {
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return;

    const settings = await response.json();
    if (settings?.external?.google) return;

    console.log(
      '\nGOOGLE_CLIENT_ID is set, but the running auth container does not ' +
        'have it.\nconfig.toml is read when the container starts, and a reset ' +
        'does not rebuild it.\nRun: npm run db:restart\n'
    );
  } catch {
    /* The service may not be up yet, which is not worth an opinion. */
  }
}

child.on('error', (error) => {
  console.error(`Could not run the Supabase CLI: ${error.message}`);
  process.exit(1);
});
