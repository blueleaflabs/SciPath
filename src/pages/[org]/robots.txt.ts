import { orgPaths } from '../../lib/tenant-paths';
export const getStaticPaths = orgPaths;

import type { APIRoute } from 'astro';
import { siteUrl } from '../../config/site';

/**
 * The public surface is open to every crawler. The working surface and any
 * route holding a bearer token are disallowed and carry noindex headers of
 * their own, because a tracking URL must never reach a search result.
 */
export const GET: APIRoute = () => {
  const body = `User-agent: *
Allow: /
Disallow: /app/
Disallow: /track/

Sitemap: ${new URL('/sitemap-index.xml', siteUrl).href}
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
