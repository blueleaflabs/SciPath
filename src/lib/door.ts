/**
 * THE DOOR (2.9).
 *
 * Whether somebody who signs in without an account here gets one. A
 * school's file says `signup_mode`; `closed` means nobody does — the
 * pilot's setting, since the class was loaded before the students arrived
 * and a forwarded link must not make an account for whoever opens it.
 * `SIGNUPS=closed` in the deployment closes every tenant at once, whatever
 * the files say, and is the switch to flip first if anything looks wrong.
 *
 * Read in three places, so the answer is one function: the OAuth callback
 * (the moment a code becomes a session), the middleware (a session that
 * has no account row) and the welcome page (the form itself).
 */
export function signupsClosed(org: { signupMode?: string } | null | undefined, runtime?: Record<string, unknown>): boolean {
  const fromBuild = typeof import.meta !== 'undefined' && (import.meta as any).env ? (import.meta as any).env.SIGNUPS : undefined;
  const global = String(runtime?.SIGNUPS ?? fromBuild ?? '').trim().toLowerCase();
  return global === 'closed' || org?.signupMode === 'closed';
}
