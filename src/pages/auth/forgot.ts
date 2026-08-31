export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../lib/supabase';
import { activeOrg } from '../../lib/tenant';
import { originFor, apexOrigin } from '../../lib/deployment';

/**
 * ASK FOR A LINK THAT SETS A NEW PASSWORD.
 *
 * Only useful to somebody who signs in with a password. An account created
 * through Google has no password to reset, and Supabase will happily send a
 * recovery link for one anyway — which lets somebody set a password on an
 * account they reached through a Google address, and turns one way in into
 * two without anybody deciding that.
 *
 * **We answer the same way regardless.** Whether an address has an account,
 * and whether that account uses a password, are both things a stranger can
 * learn by watching how this route replies. So it always says the same
 * sentence, and the decision about whether to actually send is made silently
 * on the server. `signInWithPassword` already works this way; the two have
 * to agree or the pair of them still leaks the answer.
 *
 * The return address is built from the tenant rather than the request's Host,
 * for the same reason as `signin.ts`: it is the address that has to be on
 * Supabase's redirect allow list, and deriving it from a header means it can
 * differ from the registered one in ways nothing catches.
 */
export const POST: APIRoute = async ({ request, cookies, url, locals, redirect }) => {
  const runtime = (locals as Record<string, any>).runtime?.env;

  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();

  const org = activeOrg({ locals: locals as { org?: unknown } });
  const origin = org.isPlatform ? apexOrigin() : originFor(org.subdomain ?? org.slug);

  const supabase = serverClient(request, cookies, runtime);

  /* Only for an account that signs in with one.
  
     Asked of the database rather than read from it. This selected from
     `identities` while signed out — a table whose only read policy is
     `identities_read_self` — so the query returned nothing for *every*
     address, and the code then read the empty result as "no identities, so
     probably a password account" and sent. A Google-only account would have
     been mailed a link, and following it would have set a password on an
     account that never had one.
  
     An empty result and a negative answer are not the same thing, and any
     lookup that cannot tell them apart will eventually pick the wrong one. */
  const { data: mayReset } = await supabase.rpc('may_reset_password', {
    p_email: email,
  });

  if (mayReset === true && email) {
    /* The result is deliberately not read. A failure here — an address with
       no account, a rate limit — must not change what the person is told,
       because the difference between "sent" and "not sent" is the answer to
       *does this person have an account*. */
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: new URL('/auth/reset/', origin).href,
    });
  }

  return redirect(`/auth/reset/?asked=1`, 303);
};
