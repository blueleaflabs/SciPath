/**
 * SIGNED OUT AFTER AN HOUR AWAY (dev-151).
 *
 * A session on a shared laptop, or a school Chromebook left open in a
 * classroom, stays a session for as long as the refresh token lasts,
 * which is indefinitely. An hour with no request from the person is the
 * line: past it the next request signs them out and says why, and the
 * text they had on the page is on the device (the editor keeps every
 * unsaved field in local storage) for after they sign in again.
 *
 * The clock is a signed cookie, `sp_seen`: who, and when they were last
 * seen, under the same key as the context cookie. It is stamped on any
 * request the person makes and not on the ones the page makes by itself
 * — the pulse, the version check, the incident report — since a tab left
 * open polling would otherwise never be idle. The stamp is rewritten at
 * most once a minute, so the cookie does not ride on every autosave.
 *
 * The middleware does the judging; this is the arithmetic and the cookie.
 */

import type { AstroCookies } from 'astro';
import { seal, open } from './context-cache.ts';

export const IDLE_COOKIE = 'sp_seen';
export const IDLE_SECONDS = 60 * 60;
const RESTAMP_SECONDS = 60;

/** Requests a page makes on its own; none of them says the person is there. */
const AUTOMATIC = new Set(['/app/api/pulse/', '/app/api/version/', '/app/api/live-incident/']);

export function isAutomatic(pathname: string): boolean {
  return AUTOMATIC.has(pathname);
}

export type Idle = 'fresh' | 'seen' | 'expired';

/**
 * Judge the request, and stamp the cookie where the person is present.
 * Returns `expired` when the person has been away longer than the hour
 * (the caller signs them out), `fresh` when there was no stamp (a new
 * sign-in, or the first request after this shipped), `seen` otherwise.
 */
export async function judgeIdle(
  secret: string,
  userId: string,
  cookies: AstroCookies,
  pathname: string,
  secure: boolean,
  now = Date.now()
): Promise<Idle> {
  const stamped = await open(secret, userId, cookies.get(IDLE_COOKIE)?.value, now);
  const at = typeof stamped?.at === 'number' ? stamped.at : null;
  const automatic = isAutomatic(pathname);

  if (at !== null && now - at > IDLE_SECONDS * 1000) return 'expired';

  if (!automatic && (at === null || now - at > RESTAMP_SECONDS * 1000)) {
    const value = await seal(secret, userId, { at: now }, IDLE_SECONDS * 2, now);
    if (value) cookies.set(IDLE_COOKIE, value, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: IDLE_SECONDS * 2 });
  }
  return at === null ? 'fresh' : 'seen';
}

export function clearIdle(cookies: AstroCookies) {
  if (cookies.has(IDLE_COOKIE)) cookies.delete(IDLE_COOKIE, { path: '/' });
}
