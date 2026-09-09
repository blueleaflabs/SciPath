/**
 * GUESSES AT A PASSWORD, COUNTED (2.9).
 *
 * The change-password page and the sign-in form both take a password for
 * a named account, and both are pages a stranger can type at. Every
 * attempt is recorded with the secret key (`password_attempts`), and an account with
 * too many recent failures is refused before the credential is even
 * checked — refused with the same sentence a wrong password gets, so the
 * only thing a guesser learns is that guessing stopped working.
 *
 * Fails open, and says so: a database hiccup while judging a sign-in
 * must not lock the class out, and the log names every time it happened.
 */

import { adminClient } from './supabase-admin';

/** One sentence for every failure on the change page, whatever the cause. */
export const CHANGE_FAILED = 'Password change failed. Check every field and try again.';

export async function passwordAllowed(runtime: Record<string, unknown> | undefined, email: string): Promise<boolean> {
  try {
    const { data, error } = await adminClient(runtime).rpc('password_gate', { p_email: email });
    if (error) { console.error(JSON.stringify({ password_gate: error.message })); return true; }
    return data !== false;
  } catch (e: any) {
    console.error(JSON.stringify({ password_gate: e?.message ?? String(e) }));
    return true;
  }
}

export async function notePasswordAttempt(runtime: Record<string, unknown> | undefined, email: string, ok: boolean): Promise<void> {
  try {
    const { error } = await adminClient(runtime).rpc('password_attempt', { p_email: email, p_ok: ok });
    if (error) console.error(JSON.stringify({ password_attempt: error.message }));
  } catch (e: any) {
    console.error(JSON.stringify({ password_attempt: e?.message ?? String(e) }));
  }
}

/** A short, uneven pause after a refusal, so timing says nothing either. */
export const pause = () => new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 500)));
