export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../lib/supabase';
import { safeNext, HOME } from '../../lib/next-path';
import { pause } from '../../lib/password-gate';
import { signupsClosed } from '../../lib/door';

/**
 * MAKE AN ACCOUNT WITH AN EMAIL ADDRESS AND A PASSWORD (dev-167).
 *
 * The third way in, for a tenant whose door is open and whose people have
 * no district address: the research club. The person types an address
 * and chooses a password; the address gets a message; the link in it
 * opens /auth/confirm/, where one press proves the address and signs
 * them in; the welcome page then asks the questions every account
 * answers (name, age, a guardian for a minor) and `complete_signup`
 * makes the account under this school's rules. Nothing is an account
 * until that last step, exactly as with Google.
 *
 * Only where the file says so: `signup_mode: open`. A class on a loaded
 * roster (`closed`), a school on district domains (`domain`) and a
 * council by invitation (`invite`) refuse this route outright; their
 * doors are what they were.
 *
 * What the address is told is the same whether it is new or already
 * taken: "check your mail". The auth service answers the same way for
 * both, so that a stranger cannot learn who has an account here, and
 * this route keeps that answer.
 */

const MIN = 8;

export const POST: APIRoute = async ({ request, cookies, url, locals, redirect }) => {
  const runtime = (locals as Record<string, any>).runtime?.env;
  const org = (locals as Record<string, any>).org;

  if (!org || org.signupMode !== 'open' || signupsClosed(org, runtime)) {
    await pause();
    return redirect('/app/?signin=closed');
  }

  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const again = String(form.get('again') ?? '');
  const next = safeNext(String(form.get('next') ?? ''));
  const back = (why: string) => redirect(`/app/?signin=${why}${next === HOME ? '' : `&next=${encodeURIComponent(next)}`}#create`);

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return back('bad_email');
  if (password.length < MIN) return back('short_password');
  if (password !== again) return back('mismatch');

  /* The link in the message carries the token itself, not a code (as the
     recovery mail does, 2.9): a code can only be exchanged by the browser
     that asked, and a link opened in a phone's mail app would fail. The
     template (supabase/templates/confirmation.html) builds the link from
     this address. */
  const supabase = serverClient(request, cookies, runtime);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${url.origin}/auth/confirm/` },
  });

  if (error) {
    await pause();
    /* A password the service refuses (its own minimum, or one on its
       leaked list) is the one failure worth a different sentence. */
    if (/password/i.test(error.message)) return back('weak_password');
    console.error(JSON.stringify({ signup: error.message }));
    return back('signup_failed');
  }

  /* With confirmations off at the service, a session comes back at once
     and the welcome page is next. With them on (the setting to run with),
     nothing is signed in until the link is followed. */
  if (data.session) {
    cookies.set('scipath_next', next, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 600 });
    return redirect('/app/welcome/');
  }
  return redirect('/app/?signin=check_mail');
};
