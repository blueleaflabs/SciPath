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

/**
 * RESPONSE HEADERS, ON EVERY RESPONSE.
 *
 * There were none. No frame restriction, no referrer policy, no content
 * policy, nothing limiting what a page may load or where it may be embedded.
 *
 * **Report-only for the content policy, deliberately.** An enforced policy on
 * a site that has never had one breaks whatever it happens to be wrong about,
 * and the wrongness surfaces as a blank page for a student rather than as a
 * line in a log. Report-only surfaces the same information and breaks
 * nothing; switching it to enforcing is one word here once the reports are
 * quiet.
 *
 * The others are enforced from the start because each is a refusal rather
 * than a restriction on our own pages: nothing here is meant to be framed, no
 * plugin content is meant to load, no page needs to rewrite its own base, and
 * a full URL has no business travelling to another site in a Referer.
 *
 * `unsafe-inline` for styles is Astro's scoped styles, which are emitted
 * inline per component. For scripts it is the handful of small inline blocks
 * this app uses — the masthead's name fill, the print button. Both are worth
 * removing with a nonce later; neither is worth blocking the rollout of
 * everything else now, and saying so is better than a policy that quietly
 * permits more than it looks like it does.
 */
const POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://*.supabase.co",
  /* Video embeds are click to load and only ever these two. */
  'frame-src https://www.youtube-nocookie.com https://player.vimeo.com',
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const HEADERS: Record<string, string> = {
  'Content-Security-Policy-Report-Only': POLICY,
  /* Enforced, and not the same rule as `frame-ancestors`: an older browser
     honors one and not the other. */
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  /* The origin, never the path. A student's project id in a Referer header
     travelling to a fair's website is a leak nobody would predict. */
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  /* Nothing here uses any of them. */
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/**
 * One place where every response gets them.
 *
 * Wrapping the handler rather than adding a header at each `return next()`:
 * there are four of those, and a fifth added later would be a response
 * without headers that looks exactly like the others.
 *
 * **A response that did not come from a render has immutable headers, and
 * `set` on one throws.** This is where every prerendered public page went.
 * The assets binding hands back a `Response` whose headers are guarded, as
 * does `Response.redirect`, and the loop below reached straight past that and
 * called `set` on it. The `TypeError` propagated out of the middleware, Astro
 * rendered its error page, the middleware threw again on the way out, and
 * Astro retried with middleware switched off. What a reader saw was a 404 on
 * `/about/`, `/guides/`, `/policies/` and every other public page, on every
 * tenant, while `/` — the one page whose response is freshly rendered and
 * therefore mutable — worked perfectly.
 *
 * **The tell was the absent headers, not the 404.** A response carrying
 * `X-Astro-Noop: true` and none of these five is Astro's second attempt, and
 * the only way to reach the second attempt is for the first to have thrown.
 * That is 19.9's rule about a trace whose absence is the informative part,
 * arriving from the opposite direction: in 1.66 the headers were missing
 * because the middleware never ran, and here because it ran and died.
 *
 * The copy is made only when the original refuses, so an ordinary rendered
 * response is not rebuilt on every request. Rebuilding unconditionally would
 * also be wrong for the statuses that must carry no body.
 */
function stamp(response: Response): void {
  for (const [name, value] of Object.entries(HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const response = await handle(context, next);

  try {
    stamp(response);
    return response;
  } catch {
    /* Immutable. Rebuild it, which is the only way to carry both the body
       somebody asked for and the headers every response here promises. */
    const copy = new Response(response.body, response);
    stamp(copy);
    return copy;
  }
});

const handle = async (context: any, next: any) => {
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
      /* The not-found route, which is on demand now (see 404.astro) and has
         no tenant copy to rewrite to. `.html` was the only spelling exempted
         while it was a file. */
      url.pathname === '/404' ||
      url.pathname === '/404/' ||
      url.pathname === '/404.html' ||
      url.pathname.startsWith('/sitemap')
    ) {
      return next();
    }
    const target = `/${slug}${url.pathname}${url.search}`;

    /**
     * Fetched as a file, because `next()` cannot reach one.
     *
     * A public page is prerendered once per organization under `/[org]/`, and
     * a reader asks for it without the slug. Rewriting with `next()` does not
     * work: it asks the worker's route table, and a prerendered page is a
     * file on the asset server, not a route. Astro refuses the rewrite
     * outright — an on-demand route may not rewrite into a prerendered one —
     * so the throw has to be caught rather than relied upon.
     *
     * The assets binding is how the adapter itself reaches static files, and
     * it is the mechanism here.
     *
     * **This code was correct for a long time and never once ran.** A static
     * `dist/404.html` was answered by Cloudflare before the worker was
     * invoked at all, so every request for a public page was resolved by that
     * file and the middleware never got a turn. Three fixes were written
     * inside a function nothing was calling. The tell, when a trace was
     * finally stamped onto every response, was that the trace headers did not
     * appear either. `404.astro` is on demand now, which is what gives this
     * its turn, and `tests/search-scope.mjs` holds both halves of that rule
     * together.
     *
     * Three spellings, because a page is written as `guides/index.html` and a
     * file is written as `robots.txt`. The directory form answers a page; the
     * bare form answers a file; the explicit index is between them. The first
     * hit returns, so the ordinary case is one lookup.
     */
    const bare = `/${slug}${url.pathname}`.replace(/\/+$/, '');

    const spellings = [
      `${bare}/${url.search}`,
      `${bare}/index.html${url.search}`,
      `${bare}${url.search}`,
    ];

    const assets = (locals as Record<string, any>).runtime?.env?.ASSETS;

    if (assets?.fetch) {
      for (const spelling of spellings) {
        try {
          const served = await assets.fetch(new URL(spelling, url.origin).toString());
          if (served.status !== 404) return served;
        } catch {
          /* A binding that is not what it looked like. Try the next
             spelling, then fall through: a missing page is a 404, not a
             500. */
        }
      }
    }

    /**
     * The rewrite, which Astro may refuse.
     *
     * Reached when nothing above answered — a genuinely missing page, or a
     * build with no runtime, which is what prerendering is. `next(target)`
     * renders it if the route is on demand and throws if it is prerendered,
     * and a throw here must not become a blank site.
     */
    try {
      return await next(target);
    } catch {
      /**
       * **THE DEVELOPMENT SERVER HAS NO ASSETS BINDING.**
       *
       * `ASSETS` is supplied by the platform to a worker deployed beside
       * static output. `astro dev` is not that: the binding is absent, the
       * loop above never runs, and every tenant page falls through to
       * `next(target)` — which throws, because the target is prerendered and
       * an on-demand route may not rewrite into one.
       *
       * So the catch answered every public page with a 404 in development
       * while production served them correctly. `/guides/`, `/about/`,
       * `/policies/`, `/how-it-works/` and every other page under `[org]/`,
       * all of them, on the one surface a demonstration is given from.
       * `/scipath/guides/` answered 200 the whole time, which is what makes
       * it look like a routing fault rather than a missing binding.
       *
       * The dev server is itself an origin, so the page can be fetched the
       * way the assets binding would have fetched it. Safe from recursion by
       * the guard above: a path already beginning with a tenant slug returns
       * `next()` before reaching any of this.
       *
       * Development only, deliberately. In production the binding exists and
       * has already answered, and a worker fetching its own origin to serve a
       * page is a request loop waiting for the day the binding is missing.
       */
      if (import.meta.env.DEV) {
        try {
          const served = await fetch(new URL(target, url.origin).toString(), {
            headers: request.headers,
          });
          if (served.status !== 404) return served;
        } catch {
          /* No origin to reach, which is the build. Fall through. */
        }
      }

      return next();
    }
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

  const { data: accountRow } = await supabase
    .from('users')
    .select('id, org_id, display_name, grad_year, population, status, ' +
            'affiliation_state, consent_state, author_slug')
    .eq('id', user.id)
    .maybeSingle();

  /* Cast once, at the boundary.
  
     The generated client types a selected row as a union with an error
     shape, so every property read below is otherwise an error about
     `GenericStringError` — a type that describes a failure the destructuring
     above has already discarded. Every other page here does the same, and
     naming the shape rather than reaching for `any` keeps the fields
     checked. */
  const account = accountRow as {
    id: string;
    org_id: string;
    display_name: string;
    grad_year: number | null;
    population: string;
    status: string;
    affiliation_state: string;
    consent_state: string;
    author_slug: string | null;
  } | null;

  locals.account = account ?? null;

  /* So a prerendered page can greet somebody it cannot ask about.
  
     Here rather than in the sign in routes because the account is already
     loaded: no extra query, and a changed display name corrects itself on
     the next request rather than persisting until somebody signs out. */
  if (account?.display_name) {
    setSessionHint(
      context.cookies,
      account.display_name,
      url.protocol === 'https:',
      account.consent_state ?? null
    );
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
};
