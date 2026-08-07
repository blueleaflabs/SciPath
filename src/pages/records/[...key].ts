import type { APIRoute } from 'astro';
import { activeOrg } from '../../lib/tenant';
import { bucketFrom, RECORDS_ROOT } from '../../lib/records-store';

/**
 * PUBLISHED ASSETS.
 *
 * PDFs and figures for published records, served out of the record store.
 * Scoped to the organization on the hostname, so one school's address cannot
 * reach another's files even by guessing a key: the prefix is prepended here
 * rather than taken from the URL.
 *
 * Cached hard. A published asset does not change; a correction writes a new
 * record and the manifest points at it.
 */
export const prerender = false;

export const GET: APIRoute = async (context) => {
  const org = activeOrg(context as any);
  const bucket = bucketFrom(context.locals);
  if (!bucket) return new Response('Not found', { status: 404 });

  const key = String(context.params.key ?? '');
  /* No traversal, and no reading outside this organization's prefix. */
  if (!key || key.includes('..')) return new Response('Not found', { status: 404 });

  const object = await bucket.get(`${RECORDS_ROOT}/${org.id}/${key}`);
  if (!object) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
};
