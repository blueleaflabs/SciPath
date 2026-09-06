/**
 * THE TWO CLIENTS.
 *
 * No prerendered route may import this file. The public archive builds from
 * files in the repository and has to keep serving with the database gone
 * entirely. Enforced by tests/no-db-in-static.mjs, which is why that test is
 * not optional.
 */

import { createServerClient, createBrowserClient, parseCookieHeader } from '@supabase/ssr';
import type { AstroCookies } from 'astro';

/**
 * Cloudflare hands secrets to the request rather than to the build, so
 * runtime env wins where it exists and import.meta.env covers local dev.
 * Returns '' rather than throwing: a missing variable has to produce a page
 * that says so, never a build that fails.
 */
export function env(key: string, runtime?: Record<string, unknown>): string {
  const fromRuntime = runtime?.[key];
  if (typeof fromRuntime === 'string' && fromRuntime.length > 0) return fromRuntime;

  const fromBuild = (import.meta.env as Record<string, unknown>)[key];
  if (typeof fromBuild === 'string' && fromBuild.length > 0) return fromBuild;

  return '';
}

export function isConfigured(runtime?: Record<string, unknown>): boolean {
  return (
    env('PUBLIC_SUPABASE_URL', runtime) !== '' &&
    env('PUBLIC_SUPABASE_PUBLISHABLE_KEY', runtime) !== ''
  );
}

/**
 * Server client. Carries the caller's session, so every query it makes is
 * subject to row level security. This is the client almost everything uses.
 */
/**
 * HOW MANY TIMES A REQUEST WENT TO THE DATABASE, AND FOR HOW LONG.
 *
 * From a Worker every Supabase call is a full HTTPS request to PostgREST,
 * and they add serially: a page that makes eight in a row is eight round
 * trips before the first byte. Nothing measured that, so nothing could
 * say which page it was. This counts and times every call a request makes,
 * and the middleware reports it in a `Server-Timing` header the browser's
 * network panel shows and `scripts/load-test.mjs` reads.
 *
 * Keyed on the Request object rather than passed as a parameter, because
 * fourteen pages build their own client from `Astro.request` and the
 * middleware builds one from the same object. A WeakMap on the request is
 * the one thing both sides already hold.
 */
export interface Meter {
  /** Calls to Supabase, PostgREST and Auth alike. */
  calls: number;
  /** Milliseconds spent waiting on them, summed; overlapping calls count twice. */
  ms: number;
  /** Where the time went, one entry per call: path and milliseconds. */
  trace: { path: string; ms: number }[];
}

const meters = new WeakMap<Request, Meter>();

export function meterFor(request: Request): Meter {
  let m = meters.get(request);
  if (!m) {
    m = { calls: 0, ms: 0, trace: [] };
    meters.set(request, m);
  }
  return m;
}

/** A fetch that adds each call to the request's meter, and nothing else. */
function meteredFetch(meter: Meter): typeof fetch {
  return async (input, init) => {
    const started = Date.now();
    try {
      return await fetch(input, init);
    } finally {
      const ms = Date.now() - started;
      meter.calls += 1;
      meter.ms += ms;
      if (meter.trace.length < 40) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        meter.trace.push({ path: url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''), ms });
      }
    }
  };
}

export function serverClient(
  request: Request,
  cookies: AstroCookies,
  runtime?: Record<string, unknown>
) {
  return createServerClient(
    env('PUBLIC_SUPABASE_URL', runtime),
    env('PUBLIC_SUPABASE_PUBLISHABLE_KEY', runtime),
    {
      global: { fetch: meteredFetch(meterFor(request)) },
      cookies: {
        getAll: () =>
          parseCookieHeader(request.headers.get('Cookie') ?? '').map((c) => ({
            name: c.name,
            value: c.value ?? '',
          })),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) {
            cookies.set(name, value, { ...options, path: options?.path ?? '/' });
          }
        },
      },
    }
  );
}

/** Browser client. Publishable key only; policies do the rest. */
export function browserClient() {
  return createBrowserClient(
    env('PUBLIC_SUPABASE_URL'),
    env('PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  );
}

/**
 * A TO-ONE EMBED.
 *
 * PostgREST returns an object for an embed that can only match one row, and
 * the generated types describe every embed as an array. So
 * `submission.users?.display_name` is correct at run time and an error at
 * check time — twenty-seven of these read fine because they sit on values
 * already cast to `any`, and the three that did not were reported as the
 * property missing from `{ display_name: any }[]`.
 *
 * A function rather than a cast, because it is also true the other way: a
 * query written with a different foreign key can start returning an array,
 * and a cast would keep compiling while reading `.display_name` off it
 * returns undefined for ever.
 */
export function one<T>(embed: T | T[] | null | undefined): T | undefined {
  if (!embed) return undefined;
  return Array.isArray(embed) ? embed[0] : embed;
}
