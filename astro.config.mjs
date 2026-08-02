// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// The public surface is entirely static and must build with no database
// environment variables present at all. The Cloudflare adapter arrives with
// the first authenticated route under app/, not before.
export default defineConfig({
  site: 'https://scipath.pages.dev',
  output: 'static',
  trailingSlash: 'always',
  integrations: [
    sitemap({
      // Bearer-token URLs and the working surface never enter a sitemap.
      filter: (page) => !page.includes('/app/') && !page.includes('/track/'),
    }),
  ],
  build: {
    format: 'directory',
  },
});
