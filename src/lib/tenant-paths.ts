/**
 * STATIC PATHS, ONE SET PER TENANT.
 *
 * Every public route lives under src/pages/[org]/ and is prerendered once per
 * organization, so the build emits real HTML for /montavista/articles/ and
 * /lynbrook/articles/ alike. The middleware rewrites the hostname onto the
 * front, so the slug never appears in a URL anyone sees.
 *
 * This is what keeps one deployment and static output from being a choice.
 * Rendering the archive per request would also serve many tenants, and it
 * would put a worker in front of a permanent record forever.
 */

import { orgs } from '../config/orgs';
import type { GetStaticPaths } from 'astro';

export const tenantSlugs = Object.keys(orgs);

/** For a route with no other parameters. */
export const orgPaths: GetStaticPaths = () =>
  tenantSlugs.map((org) => ({ params: { org } }));

/**
 * For a route that already has parameters: cross the existing set with every
 * tenant. Pass the original getStaticPaths body as `base`.
 */
export function withTenants(base: () => any | Promise<any>): GetStaticPaths {
  return async () => {
    const paths = await base();
    return tenantSlugs.flatMap((org) =>
      paths.map((p: any) => ({ ...p, params: { ...p.params, org } }))
    );
  };
}
