export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient, isConfigured } from '../../lib/supabase';
import { activeOrg } from '../../lib/tenant';
import { originFor, apexOrigin } from '../../lib/deployment';
import { safeNext, HOME } from '../../lib/next-path';

/**
 * Three scopes. Nothing else, ever. drive.file would put the project into
 * Google's verification review and recurring re-review, and external
 * documents are stored as URLs instead.
 */
const SCOPES = 'openid email profile';

export const GET: APIRoute = async ({ request, cookies, url, locals, redirect }) => {
  const runtime = (locals as Record<string, any>).runtime?.env;
  if (!isConfigured(runtime)) return redirect('/app/');

  /* Google's round trip cannot carry our own query parameter, and the
     `state` it does carry belongs to Supabase. So the destination waits in a
     short lived cookie and the callback picks it up.
  
     Validated on the way in as well as on the way out. A value written here
     is read there, and checking once is a habit that breaks the day
     somebody adds a third route. */
  const next = safeNext(url.searchParams.get('next'));

  if (next !== HOME) {
    cookies.set('scipath_next', next, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      /* Only where the connection is one. A browser drops a Secure cookie
         on plain http, and the destination would vanish with nothing said:
         the person signs in and lands on the overview, which is exactly the
         failure this route exists to prevent, arriving silently. Chromium
         treats *.localhost as trustworthy and other browsers do not, so the
         request decides rather than a constant. */
      secure: url.protocol === 'https:',
      maxAge: 600,
    });
  }

  const supabase = serverClient(request, cookies, runtime);

  /**
   * WHERE GOOGLE SENDS SOMEBODY BACK, AND WHERE THAT ADDRESS COMES FROM.
   *
   * It was `url.origin`, which is the Host header the client sent. That is
   * the wrong source for this one value: every other address on the
   * deployment is derived from the organization and the root domain, and
   * this one was derived from a claim made by whoever asked. A request
   * arriving with an unexpected Host would build a return address to match
   * it, and the only thing that would refuse the result is Supabase's
   * redirect allow list — which is a good backstop and a poor primary.
   *
   * `originFor` reads the same two facts the allow list is generated from:
   * the tenant that the middleware already resolved, and this deployment's
   * root domain. So the address sent to Google is the address on the list by
   * construction, rather than by two paths agreeing.
   *
   * The apex is its own case. The platform tenant is served at the root
   * rather than under a label, and `originFor('scipath')` would name a
   * subdomain that does not exist.
   */
  const org = activeOrg({ locals: locals as { org?: unknown } });
  const origin = org.isPlatform ? apexOrigin() : originFor(org.subdomain ?? org.slug);

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      scopes: SCOPES,
      redirectTo: new URL('/auth/callback/', origin).href,
    },
  });

  if (error || !data?.url) return redirect('/app/?signin=oauth');
  return redirect(data.url);
};
