#!/usr/bin/env node
/**
 * WAIT FOR THE GATEWAY, RATHER THAN FAILING AT IT.
 *
 * `supabase db reset` ends by restarting the containers, and the CLI returns
 * as soon as it has issued that restart. Kong and PostgREST come back a few
 * seconds later. Everything in `npm run reset` after the reset itself talks
 * to them over HTTP, so the first one to do so gets:
 *
 *   demo: TypeError: fetch failed
 *
 * Which is the whole message. It names the first organization in
 * `src/config/orgs/`, because that is simply the first row the loop reached,
 * and it says nothing at all about the gateway — so it reads as a broken
 * organization file or a broken seed, and it is neither.
 *
 * Two things made it hard to see. `reset-storage` runs in between and prints
 * a success line, but locally it walks `.wrangler/state` on disk and never
 * opens a socket, so its success is not evidence that anything is listening.
 * And the failure is a race, so it depends on how busy the machine is and
 * does not reproduce reliably.
 *
 * ── Any answer counts ───────────────────────────────────────────────────
 *
 * The failure being waited out is a refused connection. A 401 from an
 * unauthenticated probe means the gateway is up and talking, which is the
 * only question here. So this accepts any HTTP response below 500 and does
 * not inspect the body: making the probe assert something about content
 * would be a second thing to keep right, and it is not the thing that
 * breaks.
 */

import { dockerState, dockerAdvice, supabaseContainers } from './docker.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;
const INTERVAL_MS = 500;

/**
 * Poll until the REST gateway answers.
 *
 * @param {object} options
 * @param {string} options.url        the Supabase origin
 * @param {string} [options.key]      sent as `apikey`, when there is one
 * @param {number} [options.timeout]  give up after this, in milliseconds
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ ok: boolean, waitedMs: number, detail: string }>}
 */
export async function waitForApi({
  url,
  key,
  timeout = DEFAULT_TIMEOUT_MS,
  log = console.log,
} = {}) {
  const started = Date.now();
  let announced = false;
  let last = 'no attempt made';

  while (Date.now() - started < timeout) {
    try {
      const response = await fetch(`${url}/rest/v1/`, {
        headers: key ? { apikey: key } : {},
        signal: AbortSignal.timeout(2000),
      });

      if (response.status < 500) {
        return {
          ok: true,
          waitedMs: Date.now() - started,
          detail: `answered ${response.status}`,
        };
      }

      last = `answered ${response.status}`;
    } catch (error) {
      last = error?.message ?? String(error);
    }

    /* Silent when it answers first time, which is the normal case and does
       not need a line. Said once when it does not, because a script that
       pauses without explaining looks like a script that has hung. */
    if (!announced) {
      log(`  Waiting for the API at ${url} to come back up.`);
      announced = true;
    }

    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }

  return { ok: false, waitedMs: Date.now() - started, detail: last };
}

/**
 * WHY IS NOTHING LISTENING, AND WHAT DO I START.
 *
 * A refused connection looks the same in four situations that need four
 * different answers, and the first version of this message guessed at one of
 * them. It said a container had not come back, which assumes containers
 * existed. They did not: `supabase db reset` recreates the database and the
 * gateway is not its job, so `npm run reset` against a stack that was never
 * started applies the migration cleanly and then fails at the first request.
 *
 * A wrong diagnosis is worse than none. It sends somebody to restart a stack
 * that is not running, and when that changes nothing they conclude the thing
 * that printed the message is broken.
 *
 * So: ask Docker, and say which of the four it is.
 *
 * @param {string} url
 * @param {{ waitedMs: number, detail: string }} result
 * @returns {string}
 */
function diagnose(url, result) {
  const docker = dockerState();

  if (!docker.ok) {
    return (
      `${dockerAdvice(docker)}\n\n` +
      'The API cannot answer while there is no runtime to serve it.'
    );
  }

  const containers = supabaseContainers();

  if (!containers.known) {
    return (
      'Docker is up, but its container list could not be read, so this cannot\n' +
      'say whether the stack is running.\n\n' +
      '  Try:  npx supabase status'
    );
  }

  if (containers.running.length === 0 && containers.stopped.length === 0) {
    return (
      'Docker is up and there are no Supabase containers at all, so the stack\n' +
      'has not been started on this machine since Docker last restarted.\n\n' +
      '`npm run reset` does not start it. It runs `db reset`, which recreates\n' +
      'the database, and the API gateway is a different container.\n\n' +
      '  Start it:  npm run db:start\n' +
      '  Then:      npm run reset'
    );
  }

  if (containers.running.length === 0) {
    return (
      `Docker is up and ${containers.stopped.length} Supabase ` +
      `${containers.stopped.length === 1 ? 'container exists' : 'containers exist'}, ` +
      'stopped:\n\n' +
      containers.stopped.map((name) => `    ${name}`).join('\n') +
      '\n\nThe stack is not running.\n\n' +
      '  Restart it:  npm run restart\n' +
      '  Then:        npm run reset\n\n' +
      'Not `db:start`: `supabase start` treats a project with containers as\n' +
      'already running and exits without starting anything.'
    );
  }

  const lines = [
    `${containers.running.length} Supabase ` +
      `${containers.running.length === 1 ? 'container is' : 'containers are'} running,`,
    'so the stack is up and the gateway still did not answer.',
  ];

  if (containers.stopped.length > 0) {
    lines.push('', 'These are not running, and one of them is the likely cause:', '');
    for (const name of containers.stopped) lines.push(`    ${name}`);
  }

  lines.push(
    '',
    'This is the state that reports itself as healthy. `supabase status` still',
    'prints every address, and `supabase start` answers `already running` and',
    'does nothing, because containers exist. A full stop and start is what',
    'brings the missing one back.',
    '',
    '  Restart it:  npm run restart',
    '  Then:        npm run reset'
  );

  /* Named from what Docker actually reported. A hardcoded container name is
     wrong the moment the project directory is renamed, and a command that
     answers "no such container" reads as the diagnosis being broken rather
     than the container being fine. */
  const suspect = containers.stopped[0] ?? containers.running[0];

  if (suspect) {
    lines.push(
      '',
      'If one container is dying, its own log says why:',
      '',
      `  docker logs ${suspect}`
    );
  }

  return lines.join('\n');
}

/**
 * Wait, or stop with a sentence that names the real problem.
 *
 * Exits rather than returning false: every caller is a seed about to write,
 * and a seed that runs against a gateway that is not there produces the
 * message this exists to replace.
 */
export async function requireApi(options) {
  const result = await waitForApi(options);
  if (result.ok) return result;

  const seconds = Math.round((options.timeout ?? DEFAULT_TIMEOUT_MS) / 1000);
  const waited = `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;

  console.error(
    `\nThe Supabase API at ${options.url} did not answer within ${waited}.\n` +
      `The last attempt said: ${result.detail}\n\n` +
      `${diagnose(options.url, result)}\n`
  );
  process.exit(1);
}
