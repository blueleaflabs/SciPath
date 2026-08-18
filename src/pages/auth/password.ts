export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../lib/supabase';
import { safeNext, HOME } from '../../lib/next-path';

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
export const POST: APIRoute = async ({ request, cookies, url, locals, redirect }) => {
  const runtime = (locals as Record<string, any>).runtime?.env;

  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');

  /* Where they were trying to go before they were asked to sign in.
     Validated rather than trusted: see src/lib/next-path.ts. */
  const next = safeNext(String(form.get('next') ?? ''));

  const supabase = serverClient(request, cookies, runtime);
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    /* The destination survives a wrong password, or somebody who mistypes
       once has to go back to their email and click the link again. */
    const again = next === HOME ? '' : `&next=${encodeURIComponent(next)}`;

    /* One answer, whoever is asking.
    
       A `demo.invalid` address used to get a longer message naming
       `npm run reset` and the fixture password, on the reasoning that the
       honest cause is almost always an unseeded database and that the
       domain cannot belong to a person. Both halves were true and it was
       still wrong: **it is a development note, and it renders on a page a
       student can reach.** Somebody who mistypes their own address into a
       demo tenant is told about a command they have never heard of, by
       software that has just failed to sign them in.
    
       Supabase answers the same way whether an account is absent or the
       password is wrong, so that a stranger cannot discover who has an
       account here. The interface should say the same. Whoever is running
       the fixtures is reading a terminal anyway, and the test data document
       has the password. */
    return redirect(`/app/?signin=password${again}`);
  }

  return redirect(next);
};
