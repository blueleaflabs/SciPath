/**
 * ROUTE TREES THAT ARE NOT BUILT PER TENANT.
 *
 * Every public page is prerendered once per organization under
 * `src/pages/[org]/`, and the middleware pushes the tenant slug onto the
 * front of the path so nobody ever sees it. These are the exceptions:
 * rendered on demand, hostname aware at request time, one copy for everybody.
 *
 * This list existed twice, in the middleware and in `test:routes`. Adding the
 * tracker to one and not the other is how `/track/{uuid}` came to be
 * rewritten to `/montavista/track/{uuid}`, match nothing, and fall through to
 * a prerendered 404 that an on demand route may not serve. Both mechanisms
 * are supposed to guard the same rule, and each was reading its own copy of
 * it.
 *
 * One list. If a tree belongs here, it belongs here for both.
 */

export const NON_TENANT_TREES = [
  'app',
  'auth',
  'track',
  /* The archive. Records live in the store rather than in the repository, so
     these render on demand and resolve their organization from the hostname
     the way the working surface does. They are tenant scoped; they are not
     built once per tenant. */
  /* The combined index of both record kinds, which is what the nav points
     at. `articles` and `projects` survive as its filtered views and as the
     separate crawl paths 10.2 depends on. */
  'showcase',
  'articles',
  'projects',
  'authors',
  'topics',
  'records',
  'records-index',
  /* The three front door pages. They belong to the platform rather than to a
     school: a student at Monta Vista is not offered an independent account,
     a demonstration of their own school, or a pitch to adopt software they
     are already using. Each resolves the hostname and sends a school's
     visitor to that school's home page instead.

     Trees rather than files at the root, so one name serves both readers of
     this list: the middleware compares the first path segment, and
     `tests/tenant-routes.mjs` compares directory entries. A file called
     `demo.astro` would satisfy one of them and not the other. */
  'get-started',
  /* **Not `demo`, which is a tenant slug.** It was, for one session, and the
     collision showed up on the prerender pass: `isNonTenantPath` answered yes
     for `/demo/about/`, so every page of the demonstration tenant skipped the
     tenant guard and took the session branch, reading request headers that do
     not exist on a prerendered page. Twenty warnings in the deploy log, all of
     them on `/demo/` lines and none on any other tenant's.

     A tree name and a slug share one namespace, and `tests/paths.mjs` refuses
     an overlap now rather than trusting whoever adds the next school. */
  'try',
  'for-organizations',
  /* **A guardian is not a tenant's visitor.**
  
     `/consent/{token}/` is followed from an email by somebody with no
     account and no idea which subdomain they are on. Left tenant scoped it
     would be rewritten to `/{org}/consent/…`, which matches no route,
     and the one page in the system whose reader cannot recover from a dead
     link would be the page that 404s. The token names the organization; the
     URL does not have to. */
  'consent',
] as const;

export type NonTenantTree = (typeof NON_TENANT_TREES)[number];

/**
 * True where the path belongs to a tree that is not tenant scoped, and so
 * must not have an organization slug pushed onto the front of it.
 *
 * Compares the first segment rather than a `/tree/` prefix. The prefix form
 * required a trailing slash, so /projects was not recognized while
 * /projects/ was, and it was rewritten to /{org}/projects, which matches
 * nothing. Since `trailingSlash: 'ignore'` accepts both forms, that broke
 * every one of these trees at its bare address: the one somebody types, and
 * the one an external link uses.
 */
export function isNonTenantPath(pathname: string): boolean {
  const first = pathname.split('/')[1] ?? '';
  return (NON_TENANT_TREES as readonly string[]).includes(first);
}

/**
 * Files Astro requires at the root of `src/pages/`, which are not trees and
 * are not tenant scoped either.
 */
export const ROOT_FILES = [
  '404.astro',
  /* The home page. It shows published records, which live in the store, so it
     renders on demand and resolves its organization from the hostname. It
     cannot sit under [org]/ while doing that: an on-demand [org]/index is a
     catch-all that swallows every single-segment path on the site. */
  'index.astro',
] as const;
