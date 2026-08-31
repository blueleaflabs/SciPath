/**
 * TENANCY BY HOSTNAME.
 *
 * An email domain cannot identify an organization. A school district issues
 * one pair of domains across every school it runs, so two schools in the same
 * district are indistinguishable by address and are told apart only by which
 * URL the person arrived on. The domain still establishes population and
 * affiliation, but only within an organization already resolved.
 *
 * Local development: every *.localhost name resolves to the loopback address
 * with no host file editing, so each tenant is reachable as
 * <slug>.localhost:4321.
 */

import { orgs, type Org } from '../config/orgs';

/** Slug for a hostname, or null when nothing matches. */
export function slugForHostname(hostname: string): string | null {
  const host = hostname.toLowerCase().split(':')[0];
  const label = host.split('.')[0];

  if (!label) return null;

  /* **The subdomain, not the hostname.**
   *
   * Each tenant used to name a whole hostname, and every one of them named a
   * `.localhost` — so the same build could not serve development and
   * production, and going live meant editing the config, which is the kind of
   * edit that gets made on the wrong branch at midnight.
   *
   * What is actually stable about a tenant is its label: `montavista` is
   * `montavista.localhost:4321` while developing, `montavista.scipath.org` in
   * production, and `montavista.<anything>` on a preview deployment. Matching
   * the label makes all three the same rule, and the deployment stops being a
   * thing the source has an opinion about.
   *
   * `subdomain` exists for a tenant whose label differs from its id. None does
   * today — the Open Program used to be `blueleaflabs` at `open.` and is now
   * the base tenant on the bare domain — and the field stays because the next
   * organization to want a label that is not its id should not need a code
   * change to get one.
   */
  for (const [slug, record] of Object.entries(orgs)) {
    if ((record.subdomain ?? slug).toLowerCase() === label) return slug;
  }

  return null;
}

/**
 * Falls back to PUBLIC_ORG so a single-tenant deployment and the static
 * build both keep working. A prerendered page has no request to read.
 */
export function resolveOrg(hostname?: string): { slug: string; org: Org } {
  const fromHost = hostname ? slugForHostname(hostname) : null;
  const fallback = (import.meta.env.PUBLIC_ORG as string) ?? 'scipath';
  const slug = fromHost ?? (orgs[fallback] ? fallback : 'scipath');
  return { slug, org: orgs[slug] };
}

/**
 * The organization for the current render.
 *
 * On an on-demand route the middleware has already resolved it from the
 * hostname, so this returns that. On a prerendered route there is no request
 * to read a hostname from, so it falls back to the build-time PUBLIC_ORG.
 * A static build is single tenant by definition; only the working surface
 * can be many tenants from one deployment.
 */
export function activeOrg(ctx?: {
  /* Astro's own params are `string | number | undefined`, because a route
     parameter can be numeric. Naming only `string` here meant every page
     passing `Astro` directly failed to typecheck while working perfectly —
     the value is read as a key either way. */
  params?: Record<string, string | number | undefined>;
  locals?: { org?: unknown };
}): Org {
  /* Prerendered: the [org] route parameter is the truth at build time. */
  const fromParams = ctx?.params?.org ? String(ctx.params.org) : undefined;
  if (fromParams && orgs[fromParams]) return orgs[fromParams];

  /* On demand: the middleware already resolved the hostname. */
  const fromRequest = ctx?.locals?.org as Org | undefined;
  if (fromRequest && fromRequest.slug) return fromRequest;

  return resolveOrg().org;
}
