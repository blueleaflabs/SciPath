/**
 * THE SECRET KEY CLIENT.
 *
 * Bypasses row level security completely. It exists for three jobs performed
 * by somebody who is not signed in:
 *
 *   * the guardian clicking a confirmation link
 *   * the teacher sponsor clicking a confirmation link
 *   * the daily job
 *
 * Anything a signed-in person does goes through serverClient() and is subject
 * to policy. If this client starts appearing in ordinary request handling,
 * the policies are wrong and this is papering over it.
 *
 * **One exception, named so it stays one.** `/app/account/delete/` is used by
 * somebody who *is* signed in, and deliberately: deleting an account requires
 * privileges they must never hold — writing on other people's projects, and
 * removing an authentication record — so no policy could grant it without
 * granting far too much. What makes it safe is not the key but the argument:
 * the account acted on comes from their own session, and there is no
 * parameter naming whose account to delete. A second exception should be
 * argued the same way or not made.
 */

import { createClient } from '@supabase/supabase-js';
import { env } from './supabase';

export function adminClient(runtime?: Record<string, unknown>) {
  const key = env('SUPABASE_SECRET_KEY', runtime);
  if (!key) throw new Error('SUPABASE_SECRET_KEY is not set');

  return createClient(env('PUBLIC_SUPABASE_URL', runtime), key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
