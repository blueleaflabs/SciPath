/**
 * CACHING A PAGE THAT HAS A MASTHEAD ON IT.
 *
 * Twelve public pages set `Cache-Control: public, max-age=120`, which is
 * right for their content and wrong for the page. Every one of them renders
 * the masthead, and the masthead shows your name and a link to your work.
 *
 * So the browser stored the signed-out copy, and after signing in the reader
 * clicked back to the home page and was invited to sign in again. It looks
 * exactly like a session bug, which is where I went looking, three times.
 *
 * Two rules, and the second matters more than it looks.
 *
 * **A signed-in response is never stored.** It has a person's name in it.
 *
 * **A signed-out response varies by cookie.** Without that, a shared cache
 * that did store a signed-in copy would hand it to the next person, and the
 * consequence of getting this wrong is somebody else's name on your screen
 * rather than a stale button.
 */

import type { APIContext } from 'astro';

/** Roughly how long a published record page can be considered fresh. */
const BROWSER_SECONDS = 120;
const EDGE_SECONDS = 600;

/**
 * Cache a public page for anonymous readers, and never for a signed-in one.
 *
 * Call it after the session is on `locals`, which the middleware does before
 * any page runs.
 */
export function cachePublicPage(context: APIContext | { locals: any; response: Response }) {
  const locals = (context.locals ?? {}) as Record<string, unknown>;
  const headers = (context as any).response.headers as Headers;

  /* Vary on both, always. A response that omits it can be reused for the
     wrong person by any cache between here and the reader. */
  headers.set('Vary', 'Cookie, Accept-Encoding');

  if (locals.session) {
    headers.set('Cache-Control', 'private, no-store');
    return;
  }

  headers.set(
    'Cache-Control',
    `public, max-age=${BROWSER_SECONDS}, s-maxage=${EDGE_SECONDS}`
  );
}
