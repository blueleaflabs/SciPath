export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../lib/supabase';

/**
 * Exchanges the authorization code for a session and sets the cookies.
 * Where the person lands afterwards is decided by whether they own a row in
 * public.users, which the middleware answers on the next request.
 */
export const GET: APIRoute = async ({ request, cookies, url, locals, redirect }) => {
  const code = url.searchParams.get('code');
  if (!code) return redirect('/app/?signin=no_code');

  const runtime = (locals as Record<string, any>).runtime?.env;
  const supabase = serverClient(request, cookies, runtime);

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return redirect('/app/?signin=exchange');

  return redirect('/app/');
};
