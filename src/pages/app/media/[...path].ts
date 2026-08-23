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
  /**
   * Every table that can hold a storage path.
   *
   * `project_images` was added and this list was not, so every showcase
   * image 404'd: uploaded, stored, referenced, and unreachable. A list of
   * tables maintained by hand fails silently in exactly one direction —
   * nothing leaks, and something legitimate disappears — which is the safer
   * direction and the harder one to notice.
   *
   * `test:media` asserts this list against the schema.
   */
  const references = await Promise.all([
    supabase.from('note_media').select('id').eq('storage_path', path).maybeSingle(),
    supabase.from('project_images').select('id').eq('storage_path', path).maybeSingle(),
    supabase.from('deliverables').select('id').eq('storage_path', path).maybeSingle(),
    supabase.from('manuscript_figures').select('id').eq('storage_path', path).maybeSingle(),
    supabase.from('manuscripts').select('id').eq('pdf_path', path).maybeSingle(),
  ]);

  if (!references.some((r) => r.data)) {
    return new Response('Not found', { status: 404 });
  }

  const object = await blobStore(locals).get(path);
  if (!object) return new Response('Not found', { status: 404 });

  /* Shown, or handed over.
  
     An image is displayed inline because that is what it is for. Anything
     else is served as an attachment: a PDF opened inline runs in an origin
     that holds somebody's notebook, and a type this route did not expect
     should never be rendered as a document at all.
  
     The filename is the stored path's last segment, which was generated from
     the detected type rather than from what anybody typed. */
  const inline = object.contentType.startsWith('image/');
  const name = path.split('/').pop() ?? 'file';

  return new Response(object.body, {
    headers: {
      'Content-Type': object.contentType,
      /* Private, and revalidated. A cached copy in a shared cache would
         outlive the permission that allowed it. */
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': inline
        ? `inline; filename="${name}"`
        : `attachment; filename="${name}"`,
      /* Nothing served from here belongs in a frame, and nothing in it needs
         to run. Both are cheap on a route that returns bytes. */
      'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
    },
  });
};
