export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../lib/supabase';
import { clearSessionHint } from '../../lib/session-hint';

export const POST: APIRoute = async ({ request, cookies, locals, redirect }) => {
  const runtime = (locals as Record<string, any>).runtime?.env;
  await serverClient(request, cookies, runtime).auth.signOut();
  clearSessionHint(cookies);
  return redirect('/');
};

export const GET = POST;
