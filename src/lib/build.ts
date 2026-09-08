/**
 * WHICH BUILD THIS IS (2.9).
 *
 * `PUBLIC_BUILD` is defined in astro.config.mjs at build time — the commit
 * on Cloudflare, the moment of the build anywhere else — so the server and
 * the pages it renders carry the same short id. The middleware sends it on
 * every response as `x-scipath-build`; the app shell renders it on the
 * page and compares the two whenever a response happens to pass through,
 * so a page left open across a deploy reloads itself without asking the
 * server anything it was not already asking.
 */
export const BUILD: string = String((import.meta as any).env?.PUBLIC_BUILD ?? 'dev');
export const BUILD_HEADER = 'x-scipath-build';
