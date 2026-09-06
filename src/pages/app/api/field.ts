export const prerender = false;

/**
 * SAVE ONE FIELD OF A DOCUMENT (6.16).
 *
 * The document page's autosave posts here: document, field, value and the
 * version the field was read at. `save_field` decides everything (an
 * author, this school, the version matches) and answers either the new
 * version or the newer text somebody else wrote. This route adds nothing
 * to that rule; it only speaks JSON.
 *
 * Also the target of `sendBeacon` on the way out of the page, which is why
 * it reads a JSON body from any content type.
 */

import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/supabase';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

/* One field, read: what a page asks for when a broadcast said a field
   changed but was too big to ride along (2.8). The policies decide. */
export const GET: APIRoute = async ({ request, cookies, locals, url }) => {
  if (!(locals as any).session) return json({ ok: false }, 401);
  const supabase = serverClient(request, cookies, (locals as any).runtime?.env);
  const documentId = url.searchParams.get('document_id') ?? '';
  const fieldId = url.searchParams.get('field_id') ?? '';
  if (!documentId || !fieldId) return json({ ok: false, error: 'document and field' }, 400);
  const { data, error } = await supabase
    .from('document_fields')
    .select('value, version, updated_at, updated_by')
    .eq('document_id', documentId)
    .eq('field_id', fieldId)
    .maybeSingle();
  if (error) return json({ ok: false, error: error.message }, 403);
  return json({ ok: true, value: data?.value ?? null, version: data?.version ?? 0, at: data?.updated_at ?? null });
};

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const runtime = (locals as any).runtime?.env;
  const supabase = serverClient(request, cookies, runtime);

  let body: any;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return json({ ok: false, error: 'not JSON' }, 400);
  }

  const documentId = String(body?.document_id ?? '');
  const fieldId = String(body?.field_id ?? '');
  if (!documentId || !fieldId) return json({ ok: false, error: 'document and field' }, 400);

  /* Bounded. A field is a paragraph or a list, never a file. */
  const raw = JSON.stringify(body?.value ?? null);
  if (raw.length > 200_000) return json({ ok: false, error: 'too long' }, 413);

  const { data, error } = await supabase.rpc('save_field', {
    p_document_id: documentId,
    p_field_id: fieldId,
    p_value: body?.value ?? null,
    p_version: Number(body?.version ?? 0),
  });

  if (error) return json({ ok: false, error: error.message }, 403);
  if (data && data.ok === false) return json({ ok: false, conflict: true, version: data.version, value: data.value, by: data.by, at: data.at });
  return json({ ok: true, version: data?.version, at: data?.at });
};
