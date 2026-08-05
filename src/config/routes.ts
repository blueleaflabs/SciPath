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

export const NON_TENANT_TREES = ['app', 'auth', 'track'] as const;

export type NonTenantTree = (typeof NON_TENANT_TREES)[number];

/** Leading and trailing slash, which is what the middleware compares against. */
export const NON_TENANT_PREFIXES = NON_TENANT_TREES.map((tree) => `/${tree}/`);

/**
 * True where the path belongs to a tree that is not tenant scoped, and so
 * must not have an organization slug pushed onto the front of it.
 */
export function isNonTenantPath(pathname: string): boolean {
  return NON_TENANT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Files Astro requires at the root of `src/pages/`, which are not trees and
 * are not tenant scoped either.
 */
export const ROOT_FILES = ['404.astro'] as const;
