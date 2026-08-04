export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../lib/supabase';

/**
 * Sign in with an email address and a password.
 *
 * The second of two ways in, alongside Google. Demo fixtures use it, and so
 * does anyone whose account has a password set.
 *
 * Signing in is not the same as being admitted: an account still has to
 * exist and still has to have completed signup, which is where the domain
 * rules are enforced. This route only exchanges credentials for a session.
 */
export const POST: APIRoute = async ({ request, cookies, locals, redirect }) => {
  const runtime = (locals as Record<string, any>).runtime?.env;

  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');

  const supabase = serverClient(request, cookies, runtime);
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) return redirect('/app/?error=password');
  return redirect('/app/');
};
