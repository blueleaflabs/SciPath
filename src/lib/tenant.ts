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

  for (const [slug, record] of Object.entries(orgs)) {
    if (record.hostname && record.hostname.toLowerCase() === host) return slug;
  }

  /* First label of the hostname, so montavista.scipath.org and
     montavista.localhost both resolve without a second table. */
  const label = host.split('.')[0];
  if (label && orgs[label]) return label;

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
  params?: Record<string, string | undefined>;
  locals?: { org?: unknown };
}): Org {
  /* Prerendered: the [org] route parameter is the truth at build time. */
  const fromParams = ctx?.params?.org;
  if (fromParams && orgs[fromParams]) return orgs[fromParams];

  /* On demand: the middleware already resolved the hostname. */
  const fromRequest = ctx?.locals?.org as Org | undefined;
  if (fromRequest && fromRequest.id) return fromRequest;

  return resolveOrg().org;
}
