// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';

// output: 'static' with an adapter. Every route is prerendered unless it
// opts out with `export const prerender = false`, which keeps the archive
// static by default rather than by discipline. The adapter arrived with the
// first route under app/, exactly as 12.12 deviation 1 said it would.
/* localhost is not reachable over TLS, and a canonical tag saying https to a
   laptop is a broken link. Everything else is. */
function siteUrl() {
  const root = process.env.PUBLIC_ROOT_DOMAIN ?? 'localhost:4321';
  const local = root.startsWith('localhost') || root.endsWith('.localhost');
  return `${local ? 'http' : 'https'}://${root}`;
}

export default defineConfig({
  /* Where this deployment lives, for canonical tags and the sitemap.
   *
   * Derived from PUBLIC_ROOT_DOMAIN, which is the single thing that differs
   * between where this runs. It was briefly three values in three committed
   * YAML files; two of them were derivable from the third, and a committed
   * file describing a deployment is configuration in source control. One
   * variable, set on the deployment. */
  site: siteUrl(),
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
    // Gives dev the real bindings from wrangler.jsonc, backed by a local
    // R2 on disk. Same code path as production, deliberately.
    platformProxy: { enabled: true },
  }),
  /* 'ignore' rather than 'always'.
   *
   * 'always' compiles every route to a pattern ending in a slash, which is
   * right for pages and wrong for anything that serves a file. A request for
   * /records-index/pagefind.js matched no route at all and fell through to
   * the 404 page, so search could never load its index and published PDFs and
   * figures would have failed the same way.
   *
   * Page URLs are unaffected: `build.format: 'directory'` still emits
   * directory-style paths, every link written here still carries its slash,
   * and the canonical tag on each page settles which form is authoritative.
   * What changes is only that a path without one is no longer a miss. */
  trailingSlash: 'ignore',
  integrations: [
    sitemap({
      // Bearer-token URLs and the working surface never enter a sitemap.
      filter: (page) =>
        !page.includes('/app/') &&
        !page.includes('/auth/') &&
        !page.includes('/track/'),
    }),
  ],
  build: {
    format: 'directory',
  },
});
