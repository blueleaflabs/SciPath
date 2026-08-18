/**
 * STATIC PATHS, ONE SET PER TENANT.
 *
 * Every public route lives under src/pages/[org]/ and is prerendered once per
 * organization, so the build emits real HTML for /montavista/articles/ and
 * /svslc/articles/ alike. The middleware rewrites the hostname onto the
 * front, so the slug never appears in a URL anyone sees.
 *
 * **What this costs, stated plainly.** Adding a tenant needs a build, because
 * these paths are enumerated from the config at build time. That is a
 * deliberate trade for now and is written up in the brief (23.5): tenants in
 * the database, read per request, is the intended direction and it has
 * consequences worth testing before taking.
 *
 * The comment here used to argue that rendering per request "would put a
 * worker in front of a permanent record forever". That is no longer true and
 * was becoming misleading: `/records/`, `/showcase/`, `/articles/` and the
 * home page are all on-demand already. What is prerendered per tenant is the
 * chrome — about, contact, guides, policies, submit — none of which is a
 * permanent record.
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
