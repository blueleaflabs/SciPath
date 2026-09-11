export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../lib/supabase';
import { clearSessionHint } from '../../lib/session-hint';
import { clearContextCookie } from '../../lib/context-cache';
import { clearIdle } from '../../lib/idle';

export const POST: APIRoute = async ({ request, cookies, locals, redirect }) => {
  const runtime = (locals as Record<string, any>).runtime?.env;
  await serverClient(request, cookies, runtime).auth.signOut();
  clearSessionHint(cookies);
  clearContextCookie(cookies);
  clearIdle(cookies);
  /* The page's own clock ran out (dev-151): back to the sign-in page,
     which says so, rather than the front door. */
  if (new URL(request.url).searchParams.get('idle') === '1') return redirect('/app/?signin=idle');
  return redirect('/');
};

export const GET = POST;
