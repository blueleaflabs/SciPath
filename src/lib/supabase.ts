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
export function serverClient(
  request: Request,
  cookies: AstroCookies,
  runtime?: Record<string, unknown>
) {
  return createServerClient(
    env('PUBLIC_SUPABASE_URL', runtime),
    env('PUBLIC_SUPABASE_PUBLISHABLE_KEY', runtime),
    {
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
