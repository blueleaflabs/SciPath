
import { orgPaths } from '../../lib/tenant-paths';
export const getStaticPaths = orgPaths;

import type { APIRoute } from 'astro';
import { activeOrg } from '../../lib/tenant';
import { originForOrg } from '../../lib/deployment';

/**
 * The public surface is open to every crawler. The working surface and any
 * route holding a bearer token are disallowed and carry noindex headers of
 * their own, because a tracking URL must never reach a search result.
 */
export const GET: APIRoute = (context) => {
  const org = activeOrg(context as any);
  const body = `User-agent: *
Allow: /
Disallow: /app/
Disallow: /track/

Sitemap: ${new URL('/sitemap-index.xml', originForOrg(org)).href}
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
