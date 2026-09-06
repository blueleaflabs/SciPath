export const prerender = false;

/**
 * A FILE OR A PASTED IMAGE, INTO A DOCUMENT (6.16).
 *
 * Multipart: `document_id` and `file`. The type is read from the bytes,
 * never from the name (src/lib/filetype.ts); the object goes under the
 * project in the bucket; `add_document_media` writes the row that lets the
 * media route serve it, under the project's visibility, and refuses anybody
 * who is not an author. Answers the stored path and a name for the link.
 */

import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/supabase';
import { blobStore, MAX_UPLOAD_BYTES } from '../../../lib/blob';
import { identify } from '../../../lib/filetype';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

const ALLOWED = ['image/', 'application/pdf'];

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const runtime = (locals as any).runtime?.env;
  const supabase = serverClient(request, cookies, runtime);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ ok: false, error: 'not a form' }, 400);
  }

  const documentId = String(form.get('document_id') ?? '');
  const file = form.get('file') as File | null;
  if (!documentId || !file || file.size === 0) return json({ ok: false, error: 'document and file' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return json({ ok: false, error: 'too large' }, 413);

  const kind = await identify(file);
  if (!kind || !ALLOWED.some((a) => kind.mime.startsWith(a))) {
    return json({ ok: false, error: 'not a file we can show: use a JPEG, PNG, WebP, GIF or PDF' }, 415);
  }

  /* The project, for the path, through the document under the policies:
     a document a caller cannot read is a 404 here too. */
  const { data: doc } = await supabase.from('documents').select('id, project_id').eq('id', documentId).maybeSingle();
  if (!doc) return json({ ok: false, error: 'no such document' }, 404);

  const blob = blobStore(locals);
  if (!blob.available()) return json({ ok: false, error: 'file storage is not configured here' }, 503);

  const stem = (file.name || 'pasted').replace(/\.[^.]*$/, '').replace(/[^\w-]/g, '_').slice(-60) || 'file';
  const path = `projects/${doc.project_id}/documents/${doc.id}/${crypto.randomUUID()}-${stem}.${kind.ext}`;

  try {
    await blob.put(path, await file.arrayBuffer(), kind.mime);
  } catch (e: any) {
    return json({ ok: false, error: e.message }, 500);
  }

  const { error } = await supabase.rpc('add_document_media', { p_document_id: doc.id, p_storage_path: path });
  if (error) return json({ ok: false, error: error.message }, 403);

  return json({ ok: true, path, name: file.name || `image.${kind.ext}`, mime: kind.mime });
};
