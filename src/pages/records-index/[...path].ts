import type { APIRoute } from 'astro';
import { activeOrg } from '../../lib/tenant';
import { bucketFrom } from '../../lib/records-store';

/**
 * THE RECORDS SEARCH INDEX.
 *
 * Pagefind's client fetches index chunks over HTTP and does not care where
 * they come from. These come out of the record store, per organization, which
 * is what keeps one school's search from reaching another's work: the prefix
 * is prepended here from the hostname and never taken from the URL.
 *
 * Separate from the site's own index, which still comes from the build,
 * because the static pages change when code ships and records do not.
 */
export const prerender = false;

export const GET: APIRoute = async (context) => {
  const org = activeOrg(context as any);
  const bucket = bucketFrom(context.locals);
  if (!bucket) return new Response('Not found', { status: 404 });

  const path = String(context.params.path ?? '');
  if (!path || path.includes('..')) return new Response('Not found', { status: 404 });

  const object = await bucket.get(`records/${org.id}/pagefind/${path}`);
  if (!object) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      /* Short, because this is replaced whenever anything is published, and a
         stale index is a record nobody can find. */
      'Cache-Control': 'public, max-age=60, s-maxage=300',
    },
  });
};
