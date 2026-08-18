/**
 * SESSION RESOLUTION, AND FAILING CLOSED.
 *
 * Runs on every request. Public routes are prerendered and never reach a
 * database; this only does work for routes under /app/ and /auth/.
 *
 * The shape that matters: a person can hold a valid session and own no row
 * in public.users. That is not an error state. Signup is a separate step,
 * because a trigger on auth.users cannot resolve which organization a
 * personal email signup belongs to. Until complete_signup() runs, every
 * policy fails closed and the only reachable screen is signup.
 */

import { defineMiddleware } from 'astro:middleware';
import { serverClient, isConfigured } from './lib/supabase';
import { resolveOrg } from './lib/tenant';
import { tenantSlugs } from './lib/tenant-paths';

import { isNonTenantPath } from './config/routes';
import { signInWith } from './lib/next-path';
import { setSessionHint, clearSessionHint } from './lib/session-hint';

const GUARDED = '/app/';

const SIGNUP = '/app/welcome/';
/* The sign-in page, not the OAuth handoff. Bouncing someone straight to
   Google gives them no idea what they are agreeing to or which school they
   are signing in to. */
const SIGNIN = '/app/';

export const onRequest = defineMiddleware(async (context, next) => {
  const { url, request, cookies, locals } = context;

  /* Tenancy comes from the hostname, and it is resolved on every request
     rather than only on guarded ones. A layout that reads the organization
     from a module-level import renders the same school at every hostname,
     which is exactly the bug this ordering prevents. */
  const { slug, org } = resolveOrg(url.hostname);
  locals.orgSlug = slug;
  locals.org = org;

  /* Cancelling at Google, or an expired state, sends the person back to the
     project's Site URL with error parameters on whatever path that is. Site
     URL is one value and cannot be per tenant, so it lands on the bare host
     and looks like a broken homepage. Catch it anywhere and route it to the
     sign-in page with something readable. */
  /* Two namespaces, deliberately. `error` and `error_code` belong to the
     identity provider; `signin` is ours.
   
     They used to share one, and the result was a redirect loop on every
     failed sign in: our own /app/?error=password came back through here,
     matched `error`, and was redirected to /app/?error=oauth, which matched
     again. A password typed wrong took the browser round until it gave up.
     Nothing about that said "wrong password", which is the part that made it
     hard to see. */
  const providerError =
    url.searchParams.get('error_code') ?? url.searchParams.get('error');

  if (providerError) {
    const kind =
      providerError === 'access_denied' || providerError === 'bad_oauth_state'
        ? 'cancelled'
        : 'oauth';
    return context.redirect(`/app/?signin=${kind}`);
  }

  /* The tracker needs no session to work, and it does need one to render.
     Nobody is turned away from it, but somebody arriving from inside the
     application should not be shown a Sign in button they already used. */
  /* One list, in config/routes.ts, read by this and by test:routes. Keeping
     two copies is how the tracker came to be rewritten into a tenant path
     that matches nothing. */
  /* One address per page.
   *
   * `trailingSlash: 'ignore'` accepts both forms, which is what lets a file
   * route work at all, and it means /projects and /projects/ both render.
   * Two addresses for one page splits inbound links and gives a search engine
   * a duplicate to resolve, so the bare form redirects to the canonical one.
   *
   * A path whose last segment carries an extension is a file and keeps its
   * shape. Only GET and HEAD are redirected: a 308 on a POST would resend the
   * body, and a form that posts to a path without its slash should fail
   * loudly rather than submit twice. */
  const last = url.pathname.split('/').pop() ?? '';
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    url.pathname !== '/' &&
    !url.pathname.endsWith('/') &&
    !last.includes('.')
  ) {
    return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 308);
  }

  /**
   * The home page is on demand and needs a session.
   *
   * It moved out of `[org]/` when it started showing published records, so it
   * resolves its organization from the hostname like the working surface
   * does. Two things follow, and returning early from here got the second one
   * and missed the first: it must load a session, or somebody who is signed
   * in is shown a Sign in button they have already used; and it must not be
   * rewritten, because there is no tenant home page to rewrite to.
   *
   * The same fault took out the tracker, for the same reason.
   */
  const isHome = url.pathname === '/';
  const needsSession = isHome || isNonTenantPath(url.pathname);

  if (!needsSession) {
    /* Every public route is prerendered once per tenant under /[org]/, so a
       request for svslc.scipath.org/articles/ is served the file built at
       /svslc/articles/. The slug never appears in a URL anyone sees.

       Assets, the shared 404, and the search index are not tenant scoped and
       pass through untouched. */
    /* Middleware runs during prerendering as well as at request time, and a
       prerendered path already carries its tenant segment. Rewriting one
       again produces /scipath/svslc/about/, which matches no route and
       writes the 404 page into every tenant's files. Any path that already
       begins with a tenant slug passes through untouched. */
    const first = url.pathname.split('/')[1];
    if (
      tenantSlugs.includes(first) ||
      url.pathname.startsWith(`/${slug}/`) ||
      url.pathname.startsWith('/_astro/') ||
      /* Not exempt. Each tenant has its own index at /{org}/pagefind/, so
         this has to be rewritten like every other public path. Leaving it
         out was how three schools came to share one index. */
      url.pathname.startsWith('/pdf/') ||
      url.pathname === '/404.html' ||
      url.pathname.startsWith('/sitemap')
    ) {
      return next();
    }
    return next(`/${slug}${url.pathname}${url.search}`);
  }

  const runtime = (locals as Record<string, any>).runtime?.env;
  locals.org = org;

  locals.session = null;
  locals.account = null;
  locals.roles = [];

  if (!isConfigured(runtime)) {
    locals.configured = false;
    return next();
  }
  locals.configured = true;

  const supabase = serverClient(request, cookies, runtime);
  locals.supabase = supabase;

  /* getUser revalidates against the auth server. getSession only decodes a
     cookie the browser sent, which is not evidence of anything. */
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    /* An expired session leaves the hint behind, and the archive goes on
       greeting somebody who is signed out. Clearing it here is the only
       place that notices. */
    clearSessionHint(context.cookies);

    if (url.pathname.startsWith(GUARDED) && url.pathname !== SIGNIN) {
      /* Remembering where they were headed.
      
         This runs before any page does, so a page level guard never sees a
         request with no session: every one of them was unreachable for the
         case they were written for. A notification link therefore has to be
         remembered *here* or nowhere. */
      return context.redirect(signInWith(url));
    }
    return next();
  }

  locals.session = { id: user.id, email: user.email ?? null };

  const { data: account } = await supabase
    .from('users')
    .select('id, org_id, display_name, grad_year, population, status, ' +
            'affiliation_state, consent_state, author_slug')
    .eq('id', user.id)
    .maybeSingle();

  locals.account = account ?? null;

  /* So a prerendered page can greet somebody it cannot ask about.
  
     Here rather than in the sign in routes because the account is already
     loaded: no extra query, and a changed display name corrects itself on
     the next request rather than persisting until somebody signs out. */
  if (account?.display_name) {
    setSessionHint(context.cookies, account.display_name, url.protocol === 'https:');
  }

  if (!account) {
    /* Session without an account row. Signup is the only reachable page. */
    if (url.pathname.startsWith(GUARDED) && url.pathname !== SIGNUP) {
      return context.redirect(SIGNUP);
    }
    return next();
  }

  /* Cheap and idempotent: keeps the identity mirror current, and refreshes
     affiliation, since a login through a domain identity is the evidence
     that the person is still there. */
  await supabase.rpc('sync_identities');

  const { data: roles } = await supabase
    .from('user_roles')
    .select('role, scope_id')
    .eq('user_id', user.id)
    .is('revoked_at', null);

  locals.roles = roles ?? [];

  return next();
});
