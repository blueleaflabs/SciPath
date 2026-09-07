/**
 * BACK TO WHERE THEY CAME FROM (2.8).
 *
 * An export page is opened from somewhere (the project page, the Workbench's
 * care list, the class page) and its one link should return there, not to
 * a place the page guesses. The browser says where in the Referer header
 * when the page before was one of ours; this reads it, keeps it only when
 * it is a working-surface page on this host, and otherwise answers with the
 * page's own fallback. One place, so every export's "Back" behaves alike.
 */

export interface Back { href: string; label: string }

export function backFrom(request: Request, fallback: Back): Back {
  const ref = request.headers.get('Referer') ?? '';
  if (!ref) return fallback;
  let url: URL;
  try { url = new URL(ref); } catch { return fallback; }
  const here = new URL(request.url);
  if (url.host !== here.host) return fallback;
  if (!url.pathname.startsWith('/app/')) return fallback;
  if (url.pathname === here.pathname) return fallback;
  const path = url.pathname + url.search;
  return { href: path, label: labelFor(url.pathname, fallback.label) };
}

/** What the page before was called, for the link. */
function labelFor(pathname: string, fallback: string): string {
  if (pathname === '/app/' || pathname === '/app') return 'Back to the Workbench';
  if (/^\/app\/program\/[^/]+\/class\/?$/.test(pathname)) return 'Back to the class';
  if (/^\/app\/program\/[^/]+\/tracker\/?$/.test(pathname)) return 'Back to the tracker';
  if (/^\/app\/project\/[^/]+\/doc\//.test(pathname)) return 'Back to the document';
  if (/^\/app\/project\//.test(pathname)) return 'Back to the project';
  return fallback;
}
