/**
 * A FILE TAKEN OFF THE PAGE BY A TEACHER (dev-161).
 *
 * Anybody can photograph anything, and a class of minors with a teacher
 * in the loop needs the teacher to be able to act on what a student put
 * up — at once, without a database change, and without destroying the
 * record. So the removal is an `audit_log` row: action `media.removed`,
 * the `document_media` row as the entity, the path and the reason in the
 * body, the teacher as the actor. The bytes stay in storage and the
 * `document_media` row stays; what changes is that the media route serves
 * that path to nobody, and the document page shows the box as empty with
 * a line saying a teacher removed a file, so the author can upload
 * another.
 *
 * Read with the admin client, because a student's session may not read
 * the audit log and the page has to know either way. One indexed lookup
 * (`audit_log_entity_idx`) per document with media, none otherwise.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient } from './supabase-admin';

export const MEDIA_REMOVED = 'media.removed';

/** The removed paths of a document, with when: empty when none, or when the admin client is not configured. */
export async function removedMedia(session: SupabaseClient<any>, runtime: Record<string, unknown> | undefined, documentId: string): Promise<Map<string, { at: string }>> {
  const out = new Map<string, { at: string }>();
  const { data: media } = await session.from('document_media').select('id, storage_path').eq('document_id', documentId);
  if (!media || media.length === 0) return out;
  let admin: SupabaseClient<any>;
  try { admin = adminClient(runtime); } catch { return out; }
  const { data: rows } = await admin.from('audit_log').select('entity_id, occurred_at').eq('action', MEDIA_REMOVED).eq('entity_type', 'document_media').in('entity_id', media.map((m: any) => m.id));
  const byId = new Map((media as any[]).map((m) => [m.id, m.storage_path]));
  for (const r of rows ?? []) { const path = byId.get(r.entity_id); if (path) out.set(path, { at: r.occurred_at }); }
  return out;
}

/** Whether one path has been removed. For the media route: asked only for a path that is a document's. */
export async function isRemoved(runtime: Record<string, unknown> | undefined, mediaId: string): Promise<boolean> {
  let admin: SupabaseClient<any>;
  try { admin = adminClient(runtime); } catch { return false; }
  const { data } = await admin.from('audit_log').select('id').eq('action', MEDIA_REMOVED).eq('entity_type', 'document_media').eq('entity_id', mediaId).limit(1);
  return Boolean(data && data.length);
}

/** The teacher's act. The caller has already checked that they are a teacher. */
export async function removeMedia(admin: SupabaseClient<any>, a: { orgId: string; actorId: string; documentId: string; path: string; reason: string }): Promise<{ error: string | null }> {
  if (!a.path) return { error: 'Which file?' };
  const { data: media } = await admin.from('document_media').select('id, org_id, document_id').eq('storage_path', a.path).maybeSingle();
  if (!media || media.document_id !== a.documentId || media.org_id !== a.orgId) return { error: 'That file is not on this document.' };
  const { error } = await admin.from('audit_log').insert({
    org_id: a.orgId,
    actor_user_id: a.actorId,
    action: MEDIA_REMOVED,
    entity_type: 'document_media',
    entity_id: media.id,
    before: { path: a.path },
    after: null,
    reason: a.reason.trim() || 'removed by a teacher',
  });
  return { error: error ? error.message : null };
}
