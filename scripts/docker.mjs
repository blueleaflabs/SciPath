#!/usr/bin/env node
/**
 * IS THE THING UNDERNEATH RUNNING.
 *
 * The local Supabase stack is containers, so every command that touches it
 * needs a container runtime. When there is not one, the CLI answers with the
 * socket it failed to open:
 *
 *   failed to inspect service: failed to connect to the docker API at
 *   unix:///Users/rishi/.docker/run/docker.sock; check if the path is
 *   correct and if the daemon is running
 *
 * Which reads as a broken path. It is not a broken path; it is Docker
 * Desktop not being open. The sentence spends its whole length on the
 * least likely of its two causes, and the cost of that is a morning spent
 * looking at socket paths.
 *
 * This is the same shape as the `invalid_client` problem `doctor.mjs` was
 * written for: a real failure reported by the layer that noticed rather than
 * by the layer that knows what it means. So it gets the same treatment,
 * which is to ask the question ourselves and say the answer in a sentence.
 *
 * ── Why `docker info` rather than a socket path ─────────────────────────
 *
 * The socket is in a different place under Docker Desktop, OrbStack, Colima
 * and a Linux daemon, `DOCKER_HOST` overrides all four, and a check that
 * knew those paths would be a list to maintain that is wrong the first time
 * somebody switches runtime. Asking the client whether it can reach a daemon
 * works for every one of them and knows nothing about any of them.
 *
 * ── Why there is no exemption list ──────────────────────────────────────
 *
 * `supabase --help` does not need a daemon and this refuses it anyway. An
 * exemption list is the thing that grows a case every time somebody finds a
 * subcommand it forgot, and every command this repository actually routes
 * through `supabase.mjs` — start, stop, db reset, db query, migration up —
 * needs the stack. Reaching for `npx supabase --help` directly on the one
 * day that matters is cheaper than maintaining the list.
 */

import { spawnSync } from 'node:child_process';

/**
 * Whether a container runtime is reachable.
 *
 * Three outcomes rather than two, because "no docker command" and "docker
 * command, no daemon" are different problems with different fixes and the
 * caller has to be able to say which.
 *
 * @returns {{ ok: boolean, reason: 'ok' | 'absent' | 'down', detail: string }}
 */
export function dockerState() {
  let result;

  try {
    result = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
      /* A daemon that is starting can sit on this for a while, and a check
         that hangs is worse than one that is wrong. Long enough for a cold
         Docker Desktop to answer, short enough to notice. */
      timeout: 10_000,
    });
  } catch (error) {
    return { ok: false, reason: 'absent', detail: error.message };
  }

  if (result.error?.code === 'ENOENT') {
    return {
      ok: false,
      reason: 'absent',
      detail: 'no docker command on PATH',
    };
  }

  if (result.status === 0) {
    return {
      ok: true,
      reason: 'ok',
      detail: `daemon ${String(result.stdout ?? '').trim() || 'reachable'}`,
    };
  }

  /* The daemon's own complaint, first line only. It is usually the socket
     sentence above, and the rest is a stack of retries nobody reads. */
  const said = String(result.stderr ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0];

  return { ok: false, reason: 'down', detail: said || 'the daemon did not answer' };
}

/**
 * WHICH SUPABASE CONTAINERS EXIST, AND WHAT THEY ARE DOING.
 *
 * Written because a wait for the API gateway timed out and the message
 * guessed. It said one of the containers had not come back, which assumes
 * they were there; they were not. `supabase db reset` recreates the
 * *database*, and Kong, PostgREST, auth and storage are not its job, so a
 * stack that was never started produces a clean migration and nothing
 * listening on 54321.
 *
 * Two states that look identical from a refused connection and need
 * opposite responses: start the stack, or restart a container that died.
 * Asking Docker is the only way to tell them apart, and it is cheap.
 *
 * Names are matched on the `supabase_` prefix the CLI gives its containers.
 * A prefix rather than a list of service names: the set changes between CLI
 * versions, and a list would report a healthy stack as broken the first time
 * one was renamed.
 *
 * @returns {{ known: boolean, running: string[], stopped: string[] }}
 *          `known` is false when Docker could not be asked at all, which is
 *          different from a stack with no containers and must not be
 *          reported as one.
 */
export function supabaseContainers() {
  let result;

  try {
    result = spawnSync(
      'docker',
      ['ps', '--all', '--format', '{{.Names}}\t{{.State}}'],
      { encoding: 'utf8', timeout: 10_000 }
    );
  } catch {
    return { known: false, running: [], stopped: [] };
  }

  if (result.error || result.status !== 0) {
    return { known: false, running: [], stopped: [] };
  }

  const running = [];
  const stopped = [];

  for (const line of String(result.stdout ?? '').split('\n')) {
    const [name, state] = line.split('\t');
    if (!name || !name.startsWith('supabase_')) continue;
    (state === 'running' ? running : stopped).push(name);
  }

  return { known: true, running, stopped };
}

/** What to tell somebody, given a state that is not ok. */
export function dockerAdvice(state) {
  if (state.reason === 'absent') {
    return (
      'Docker is not installed, or is not on PATH.\n' +
      'The local Supabase stack runs in containers and cannot start without one.\n' +
      'Install Docker Desktop, or point DOCKER_HOST at the runtime you use.'
    );
  }

  return (
    'Docker is installed but no daemon is answering.\n' +
    'Start Docker Desktop and wait for it to finish starting, then run this again.\n' +
    `The daemon said: ${state.detail}`
  );
}

/**
 * Refuse to go on without a runtime, saying why.
 *
 * Called before the CLI is spawned rather than after it fails, so the
 * sentence somebody reads is this one and not the socket path.
 */
export function requireDocker() {
  const state = dockerState();
  if (state.ok) return state;

  console.error(`\n${dockerAdvice(state)}\n`);
  process.exit(1);
}
