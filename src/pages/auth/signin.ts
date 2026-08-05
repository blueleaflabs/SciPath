export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient, isConfigured } from '../../lib/supabase';

/**
 * Three scopes. Nothing else, ever. drive.file would put the project into
 * Google's verification review and recurring re-review, and external
 * documents are stored as URLs instead.
 */
const SCOPES = 'openid email profile';

export const GET: APIRoute = async ({ request, cookies, url, locals, redirect }) => {
  const runtime = (locals as Record<string, any>).runtime?.env;
  if (!isConfigured(runtime)) return redirect('/app/');

  const supabase = serverClient(request, cookies, runtime);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      scopes: SCOPES,
      redirectTo: new URL('/auth/callback/', url.origin).href,
    },
  });

  if (error || !data?.url) return redirect('/app/?signin=oauth');
  return redirect(data.url);
};
