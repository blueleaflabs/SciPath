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
import { serverClient, isConfigured, meterFor } from './lib/supabase';
import { resolveOrg, hostIsOurs, slugForHostname } from './lib/tenant';
import { signupsClosed } from './lib/door';
import { BUILD, BUILD_HEADER } from './lib/build';
import { orgs } from './config/orgs';
import { originForOrg, rootDomain } from './lib/deployment';
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
/* Two reports from the hosted site's console on the pilot's eve (2.9),
   both report-only and so harmless, both fixed here so the log stays
   quiet enough to read: the Realtime socket is `wss:`, which `https:`
   does not cover in connect-src; and Cloudflare's Web Analytics beacon
   (switched on in the Pages dashboard, no GA) is a script from
   static.cloudflareinsights.com that reports to cloudflareinsights.com. */
const POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cloudflareinsights.com",
  /* Video embeds are click to load and only ever these two; a Google
     Doc, Sheet, Slides deck or Drive file linked to a document renders
     as Google's own read-only preview (src/lib/gdrive.ts). */
  'frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://docs.google.com https://drive.google.com',
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
  /* Which build answered (2.9): the shell compares it with its page's. */
  [BUILD_HEADER]: BUILD,
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

/**
 * WHERE THE TIME WENT, ON EVERY RESPONSE.
 *
 * `Server-Timing` is read by the browser's network panel and by
 * `scripts/load-test.mjs`, and it says three things per request: how long
 * the whole thing took, how much of that was waiting on Supabase, and how
 * many round trips that was. At the pilot's scale the risk is not
 * throughput; it is one page making eight sequential calls, and until this
 * existed nothing could name the page.
 *
 * Always on. It costs a header, and a measurement that has to be switched
 * on is one that is off on the day it is needed. The per-call trace is
 * printed to the log only when `TIMING_LOG` is set, because forty lines per
 * request is a bill on Cloudflare and noise everywhere else.
 */
function timing(context: Parameters<typeof handle>[0], response: Response, started: number): void {
  const meter = meterFor(context.request);
  const total = Date.now() - started;
  response.headers.set(
    'Server-Timing',
    `db;dur=${meter.ms};desc="${meter.calls} calls", total;dur=${total}`
  );

  /* The slowest call, named, when the caller asks for it (2.9). The load
     test sends `x-timing-trace: 1` and gathers these per route, so a run
     says not only that the Workbench spent 1.2 seconds in the database but
     which call it was waiting on. A browser never asks, so the path of a
     PostgREST call — no secret, but no business of a page's either — is
     not on every response. */
  if (context.request.headers.get('x-timing-trace') === '1' && meter.trace.length > 0) {
    const slowest = meter.trace.reduce((a, b) => (b.ms > a.ms ? b : a));
    response.headers.append('Server-Timing', `slow;dur=${slowest.ms};desc="${slowest.path.replace(/"/g, '')}"`);
  }

  const runtime = (context.locals as Record<string, any>).runtime?.env ?? {};
  const wanted = String(runtime.TIMING_LOG ?? import.meta.env.TIMING_LOG ?? '');
  if (wanted === '1' && meter.calls > 0) {
    console.log(
      JSON.stringify({
        timing: context.url.pathname,
        total,
        db: meter.ms,
        calls: meter.calls,
        trace: meter.trace.map((t) => `${t.path} ${t.ms}`),
      })
    );
  }
}

export const onRequest = defineMiddleware(async (context, next) => {
  const started = Date.now();
  /* A hostname this deployment does not answer for (2.9) gets nothing:
     not the platform's front door under a stranger's name, which the
     fallback in resolveOrg used to render for any host pointed here.
     Before the handler, since there is no tenant to render for. */
  /* A prerender has no host to refuse: the build renders every public
     page once, under whatever address `site` names, and a refusal there is
     a page written to disk as "Not found". Both gates below are for
     requests, which arrive with the Worker's runtime; the build has none. */
  const atRuntime = Boolean((context.locals as Record<string, any>).runtime?.env);
  if (atRuntime && !hostIsOurs(context.url.hostname, rootDomain)) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  /* And only the tenants the deployment names (2.9): TENANTS=montavista,demo
     answers those two schools' addresses and the platform's own, and
     nothing for any other school in the files. Unset means every school
     in src/config/orgs, as before.

     Read from the Worker's runtime variables only, never from the build:
     the first deployment with this read `import.meta.env` too, and a
     build that had TENANTS set prerendered every public page as "Not
     found" — the bare domain resolves to the platform's own slug, which
     the list did not name. So the platform is never refused, and at build
     time there is no runtime and nothing to refuse with. */
  const env = (context.locals as Record<string, any>).runtime?.env;
  const tenants = String(env?.TENANTS ?? '').split(',').map((t: string) => t.trim().toLowerCase()).filter(Boolean);
  if (atRuntime && tenants.length > 0) {
    const label = slugForHostname(context.url.hostname);
    if (label && !tenants.includes(label) && !orgs[label]?.isPlatform) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
  }
  /* Which build is serving, for a page that asks (2.9): answered here,
     before the handler, so it costs no database call. The header is on
     every response anyway; this is the one a tab asks for when it is
     looked at again after a night away. */
  const response = context.url.pathname === '/app/api/version/'
    ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } })
    : await handle(context, next);

  try {
    stamp(response);
    timing(context, response, started);
    return response;
  } catch {
    /* Immutable. Rebuild it, which is the only way to carry both the body
       somebody asked for and the headers every response here promises. */
    const copy = new Response(response.body, response);
    stamp(copy);
    timing(context, copy, started);
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
  locals.showcases = [];
  locals.classes = [];
  locals.projects = [];
  locals.families = [];

  if (!isConfigured(runtime)) {
    locals.configured = false;
    return next();
  }
  locals.configured = true;

  const supabase = serverClient(request, cookies, runtime);
  locals.supabase = supabase;

  /* **The token is checked, and checked here rather than at the auth server.**

     `getSession` only decodes a cookie the browser sent, which is not
     evidence of anything. `getUser` is evidence, and it was what ran here:
     a round trip to Supabase Auth on every page load, in front of every
     other call the page would make. `getClaims` verifies the token's
     signature against the project's public keys, fetched once and cached,
     so a request carrying a forged or expired token is refused without
     leaving the Worker.

     The trade is that a session revoked at the server stays valid until the
     token expires, an hour at most. For a product where signing out is the
     revocation that happens, that is the right trade; the alternative is a
     network hop on every request for every person.

     Only where the project signs with an asymmetric key. On a project still
     on the legacy shared secret the library cannot verify locally and asks
     the server instead, which is `getUser` under another name and costs the
     same. Turning the key on is a dashboard setting (12.15). */
  const { data: claims } = await supabase.auth.getClaims();
  const user = claims?.claims
    ? { id: String(claims.claims.sub), email: (claims.claims.email as string | undefined) ?? null }
    : null;

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

  /* `organizations(slug)` joined, not `org_id` compared.
  
     `users.org_id` is a uuid the database generated; `org.slug` in
     `src/config` is the tenant's slug. Comparing the two is always unequal,
     which would have locked every account out of every tenant — a fix worse
     than the bug it was written for, and one that looks correct in a diff.
     The config field was called `id` when this was written, which is what
     made the two look comparable; it is `slug` now, for that reason and
     because the record store had already been caught by it. Nothing in
     `src/` reads `organizations` anywhere else, so there is no uuid on this
     side to compare against. The slug is the name both sides know. */
  /* Through my_account() (2.9): the columns that say who a person is to
     the school (population, status, consent) left the session's reach on
     the table, so the person's own row comes from the definer, with the
     school's slug beside it. */
  /* Through my_context() (2.9): the account and everything else the
     middleware needs — roles, showcases, classes, families, own projects
     and their places, and the identity sync — in one round trip rather
     than seven, since from a Worker each one is a network hop and they add
     serially before any page can start. */
  const { data: ctxJson, error: accountError } = await supabase.rpc('my_context');
  const ctx = (ctxJson ?? {}) as Record<string, any>;
  const accountJson = ctx.account ?? null;

  /* **A call that failed is not a person with no row.**

     The error was dropped here, so a PostgREST hiccup — a pool with nothing
     free, a timeout, a restart — read exactly like a brand-new account, and
     the request below sent a signed-in student to the welcome screen to
     sign up again. The first load test found it: 32 of 40 sign-ins were
     answered by a 302 the moment the database was busy. A failed read is
     answered as one — briefly, with a retry — and never as a decision about
     who the person is. */
  if (accountError) {
    console.error(JSON.stringify({ my_account: accountError.message, path: url.pathname }));
    if (url.pathname.startsWith(GUARDED)) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>One moment</title><body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>One moment</h1><p>The database did not answer in time. This page tries again in a few seconds; nothing you wrote has been lost.</p></body>',
        { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3' } }
      );
    }
    return next();
  }
  const accountRow = accountJson
    ? { ...(accountJson as any), organizations: { slug: (accountJson as any).org_slug ?? null } }
    : null;

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
    organizations: { slug: string } | null;
  } | null;

  /**
   * **AN ACCOUNT BELONGS TO ONE SCHOOL. A SESSION DID NOT.**
   *
   * Authentication is global: there is one `auth.users` across every tenant,
   * because a person has one set of credentials. Membership is not global —
   * `public.users.org_id` says which school an account is at.
   *
   * This attached the account to the request on `auth.uid()` alone and never
   * compared the two. So a teacher created for Monta Vista signed in at the
   * platform's own address and was admitted: `/app/` rendered, the masthead
   * said SciPath, and the roles from another school came with them. Reported
   * against `www.scipath.org`, which resolves to the platform tenant through
   * the `PUBLIC_ORG` fallback because `www` matches no label — so it was the
   * platform's tenant, correctly resolved, admitting somebody who is not in
   * it.
   *
   * **Row level security was not the thing holding the line.** `app.org_id()`
   * reads `users.org_id` for the caller, so the data returned was Monta
   * Vista's. The tenant boundary in the interface was a lie in the other
   * direction: one school's roster, rendered under another school's name, at
   * an address that school's students use.
   *
   * The session stays valid — it is a real session, and signing somebody out
   * of everywhere because they opened the wrong hostname is a punishment for
   * a typo. What they do not get is an account *here*. Guarded routes send
   * them to their own school rather than to a refusal, because the fix is a
   * different address and the software knows which one.
   */
  /**
   * **AND IT FAILS CLOSED.**
   *
   * The first version read `account && accountSlug && accountSlug !== slug`.
   * The middle term is the bug: when the embed comes back without a slug —
   * a policy that refuses the join, a rename, a query edited elsewhere — the
   * condition is false and the account is admitted. A tenancy guard whose
   * unknown case is *let them in* is a guard that reports success in exactly
   * the situation nobody is watching.
   *
   * Now an account with no readable school is admitted to no school. That is
   * the safe direction, and it is loud: somebody locked out of their own
   * tenant reports it within a minute, where somebody admitted to a tenant
   * that is not theirs reports it never.
   *
   * Compared against `slug`, which is what `resolveOrg` returns as the
   * tenant's name. That is now the field's own name on the config record, so
   * the two cannot drift apart the way they could while it was called `id`.
   */
  const accountSlug = account?.organizations?.slug ?? null;

  if (account && accountSlug !== slug) {
    locals.account = null;
    locals.roles = [];
    locals.showcases = [];
    locals.classes = [];
    locals.projects = [];
    locals.families = [];

    /* The hint is a greeting on prerendered pages and it is drawn from the
       account. Cleared, or the archive greets somebody by name at a school
       they do not belong to. */
    clearSessionHint(context.cookies);

    if (url.pathname.startsWith(GUARDED)) {
      /**
       * Their own school, and **not the path they were on**.
       *
       * This carried `url.pathname` across, which is wrong the moment a path
       * contains a resource id: `scipath.org/app/project/abc/` became
       * `montavista.scipath.org/app/project/abc/`, and that project id
       * belongs to the platform tenant's namespace. Row level security
       * refuses it, so nothing leaks — but somebody lands on a dead page
       * immediately after a redirect they did not ask for, which reads as
       * the software being broken rather than as being sent home.
       *
       * `/app/` is the only destination that means the same thing in every
       * tenant.
       *
       * **And it says so on arrival.** The redirect was silent: you typed one
       * address, arrived at another, and nothing explained it. Somebody who
       * does not notice keeps the wrong bookmark forever; somebody who does
       * notice assumes something went wrong. The slug is passed so the
       * landing page can name the school — read back through `orgs`, so what
       * is rendered is the organization's own name and never the parameter.
       */
      const home = accountSlug ? orgs[accountSlug] : null;
      if (home) {
        return context.redirect(`${originForOrg(home)}/app/?at=${accountSlug}`);
      }
      return context.redirect('/');
    }

    return next();
  }

  locals.account = account ?? null;

  /* Suspended is suspended here too (2.9). The database refuses a
     suspended account's writes and reads of its projects; the pages say
     so plainly rather than rendering an empty Workbench. The account and
     the public archive stay reachable, and signing out still works. */
  if (account?.status === 'suspended' && url.pathname.startsWith('/app/') && !url.pathname.startsWith('/app/account/')) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>Account suspended</title><body style="font-family:system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>This account is suspended</h1><p>Your teacher or the club advisor can tell you why and what happens next. Nothing you wrote has been removed.</p><form method="POST" action="/auth/signout/"><button type="submit">Sign out</button></form></body>',
      { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
    );
  }

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
    /* **A session with no row is either a new person or a stale token, and
       the two look identical from here.**

       `getClaims` verifies the signature locally and never asks the auth
       server whether the user still exists. Ordinarily that is the point.
       It is wrong in exactly one case: a token issued before the accounts
       were rebuilt underneath it. `npm run reset` drops `auth.users`, the
       browser keeps a cookie that is signed correctly and an hour from
       expiring, and the first page after the reset met a valid session for
       a person who is not there, sent them to the signup screen, and
       `complete_signup` read a null email off a row that did not exist.

       So the no-row case, and only that case, pays the round trip that
       `getUser` used to pay on every request. A new person passes it and
       goes to signup as before; a ghost fails it, is signed out, and lands
       on the door with the reason named. */
    const { data: live } = await supabase.auth.getUser();
    if (!live?.user) {
      await supabase.auth.signOut();
      clearSessionHint(context.cookies);
      locals.session = null;
      if (url.pathname.startsWith(GUARDED)) return context.redirect('/app/?signin=stale');
      return next();
    }

    /* Closed (2.9): a session with no account gets no welcome page. The
       callback refuses first; this catches a session made before the door
       closed, or a password sign-in to an identity with no account. */
    if (signupsClosed(org, runtime)) {
      await supabase.auth.signOut();
      clearSessionHint(context.cookies);
      locals.session = null;
      if (url.pathname.startsWith(GUARDED)) return context.redirect('/app/?signin=closed');
      return next();
    }

    /* Session without an account row. Signup is the only reachable page. */
    if (url.pathname.startsWith(GUARDED) && url.pathname !== SIGNUP) {
      return context.redirect(SIGNUP);
    }
    return next();
  }

  /* All of it came with my_context(): the identity sync ran inside it,
     and the rows below are the caller's own, read as the definer with the
     same filters the session used to apply. */
  const roles = (ctx.roles ?? []) as { role: string; scope_id: string | null }[];
  locals.roles = roles;

  /* The class showcases this person may open, for the tab beside the
     Workbench; empty for almost everybody, since only a program flagged
     `private` has one. And the classes they run. */
  locals.showcases = ctx.showcases ?? [];
  locals.classes = ctx.classes ?? [];

  /* The classes this person is an Elder in: an officer role scoped to a
     cohort program. For the tracker tab, which is theirs to fill in. */
  locals.families = url.pathname.startsWith('/app/') ? (ctx.families ?? []) : [];

  /* The reader's own projects and where each one is, for the tab bar and
     for where a bare /app/ lands them. A student with one project in one
     class gets that project's pages as tabs rather than two abstract
     nouns, and the model is untouched: the notebook belongs to the
     project, the calendar to the place, and a second place is a third
     tab. Only on the working surface, where the bar renders. */
  locals.projects = [];
  if (url.pathname.startsWith('/app/')) {
    const own = (ctx.own ?? []) as { id: string; title: string }[];
    const places = (ctx.places ?? []) as any[];
    locals.projects = own.map((p) => ({
      project_id: p.id,
      title: p.title,
      places: places
        .filter((r: any) => r.project_id === p.id && r.programs?.status === 'open')
        .map((r: any) => ({
          participation_id: r.id,
          program_id: r.program_id,
          name: r.programs.name,
          short_name: r.programs.short_name ?? null,
          cohort: r.programs.program_role === 'cohort',
        }))
        .sort((a: any, b: any) => Number(b.cohort) - Number(a.cohort) || a.name.localeCompare(b.name)),
    }));
  }

  return next();
};
