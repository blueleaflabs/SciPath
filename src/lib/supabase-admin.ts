/**
 * THE SECRET KEY CLIENT.
 *
 * Bypasses row level security completely. It exists for exactly three jobs,
 * all of which are performed by somebody who is not signed in:
 *
 *   * the guardian clicking a confirmation link
 *   * the teacher sponsor clicking a confirmation link
 *   * the daily job
 *
 * Anything a signed-in person does goes through serverClient() and is subject
 * to policy. If this client starts appearing in ordinary request handling,
 * the policies are wrong and this is papering over it.
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
