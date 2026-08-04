// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';

// output: 'static' with an adapter. Every route is prerendered unless it
// opts out with `export const prerender = false`, which keeps the archive
// static by default rather than by discipline. The adapter arrived with the
// first route under app/, exactly as 12.12 deviation 1 said it would.
export default defineConfig({
  site: 'https://scipath.pages.dev',
  output: 'static',
  adapter: cloudflare({
    imageService: 'compile',
    // Gives dev the real bindings from wrangler.jsonc, backed by a local
    // R2 on disk. Same code path as production, deliberately.
    platformProxy: { enabled: true },
  }),
  trailingSlash: 'always',
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
