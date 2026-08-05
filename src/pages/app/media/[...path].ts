export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/supabase';
import { blobStore } from '../../../lib/blob';

/**
 * THE ONLY WAY BYTES LEAVE THE BUCKET.
 *
 * R2 carries no row-level security, so the check happens here: the object is
 * served only if it is referenced by a row the caller is already allowed to
 * read. The reference is the authorization, which means access is revoked
 * the moment somebody is detached from a project rather than whenever a
 * signed URL happens to expire.
 */
export const GET: APIRoute = async ({ params, request, cookies, locals }) => {
  const path = params.path;
  if (!path) return new Response('Not found', { status: 404 });

  const runtime = (locals as any).runtime?.env;
  const supabase = serverClient(request, cookies, runtime);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return new Response('Not found', { status: 404 });

  /* Policies on these two tables already answer "may this person see it".
     If neither returns a row, either the object is not ours or they are not
     allowed to see it, and both answers are 404. */
  const [{ data: media }, { data: deliverable }, { data: figure }, { data: paper }] =
    await Promise.all([
      supabase.from('note_media').select('id').eq('storage_path', path).maybeSingle(),
      supabase.from('deliverables').select('id').eq('storage_path', path).maybeSingle(),
      supabase.from('manuscript_figures').select('id').eq('storage_path', path).maybeSingle(),
      supabase.from('manuscripts').select('id').eq('pdf_path', path).maybeSingle(),
    ]);

  if (!media && !deliverable && !figure && !paper) {
    return new Response('Not found', { status: 404 });
  }

  const object = await blobStore(locals).get(path);
  if (!object) return new Response('Not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'Content-Type': object.contentType,
      /* Private, and revalidated. A cached copy in a shared cache would
         outlive the permission that allowed it. */
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    },
  });
};
