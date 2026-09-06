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
