export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../lib/supabase';
import { adminClient } from '../../lib/supabase-admin';
import { safeNext } from '../../lib/next-path';
import { signupsClosed } from '../../lib/door';

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

  /**
   * **A school that signs up by domain admits nobody else, at the door.**
   *
   * The database refuses to create an account for an address off the
   * school's domains, and the welcome page says so and signs the person
   * out. Both are after the fact: Google has already authenticated the
   * address and Supabase has already written it to `auth.users`, so a
   * personal Gmail that was turned away still had an authentication record
   * here, could sign in again tomorrow, and would meet the same form.
   *
   * So the check runs here, the moment the code becomes a session, before
   * anything downstream: an address off the domain list, with no account
   * at this school, is signed out, its identity is removed with the admin
   * client, and the person is told in one sentence on the sign-in page.
   * An account that already exists (loaded by the pilot, or made before a
   * domain was added) goes through; the domain rule is for signups.
   */
  const org = (locals as Record<string, any>).org;

  /* A school that signs in by password alone (`sign_in: password`, 2.9)
     takes no Google session at all: the session just made is ended, and
     an identity Google created for an address with no account here is
     removed, as the closed door does. An account that exists is not
     harmed — it simply is not signed in this way. */
  if (org?.signIn === 'password') {
    const { data: { user: gu } } = await supabase.auth.getUser();
    if (gu) {
      const { data: existing } = await supabase.from('users').select('id').eq('id', gu.id).maybeSingle();
      if (!existing) {
        try {
          const { error: gone } = await adminClient(runtime).auth.admin.deleteUser(gu.id);
          if (gone) console.error('google refusal: identity was not removed');
        } catch {
          console.error('google refusal: identity removal raised');
        }
      }
    }
    await supabase.auth.signOut();
    cookies.delete('scipath_next', { path: '/' });
    return redirect('/app/?signin=password_only');
  }

  /* Closed (2.9) is the same refusal for everybody without an account,
     on-domain or off: the identity Supabase just made is removed, the
     session ended, and the sign-in page says the door is closed. */
  const closed = signupsClosed(org, runtime);
  if (closed || org?.signupMode === 'domain') {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const email = (user?.email ?? '').toLowerCase();
    const domain = email.split('@')[1] ?? '';
    const allowed = ((org?.verifiedDomains ?? []) as string[]).map((d: string) => d.toLowerCase());

    if (user && (closed || !allowed.includes(domain))) {
      const { data: existing } = await supabase.from('users').select('id').eq('id', user.id).maybeSingle();

      if (!existing) {
        try {
          const admin = adminClient(runtime);
          const { error: gone } = await admin.auth.admin.deleteUser(user.id);
          /* Logged without the address: what matters is that a refusal
             failed to clean up, not who was refused. */
          if (gone) console.error('domain refusal: identity was not removed');
        } catch {
          console.error('domain refusal: identity removal raised');
        }
        await supabase.auth.signOut();
        cookies.delete('scipath_next', { path: '/' });
        return redirect(closed ? '/app/?signin=closed' : '/app/?signin=domain');
      }
    }
  }


  /* Read once and cleared, so a destination cannot be replayed on a later
     sign in by somebody sharing a machine. */
  const next = safeNext(cookies.get('scipath_next')?.value);
  cookies.delete('scipath_next', { path: '/' });

  return redirect(next);
};
