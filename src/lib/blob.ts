/**
 * FILE STORAGE.
 *
 * Cloudflare R2 rather than Supabase Storage, for one decisive reason: on the
 * Supabase free tier, crossing the egress allowance applies the Fair Use
 * Policy and *every* service starts returning 402 until the billing period
 * resets. Not only images. Auth and the database go down with them.
 *
 * A club scrolling their own notebooks in March could therefore take the
 * whole system offline three days before judging, which is an unacceptable
 * failure mode for a system whose entire premise is not missing deadlines.
 * R2 charges nothing for egress, so that class of failure does not exist.
 *
 * What we give up is that Supabase Storage inherited row-level security and
 * R2 does not. Access control therefore lives in /app/media/, which is
 * arguably better: a signed URL stays valid for its whole lifetime even if
 * the person is removed from the project a minute after it was issued.
 */

export interface Blob {
  put(path: string, body: ArrayBuffer, contentType: string): Promise<void>;
  get(path: string): Promise<{ body: ReadableStream; contentType: string } | null>;
  available(): boolean;
}

type R2Like = {
  put(key: string, value: ArrayBuffer, opts?: any): Promise<unknown>;
  get(key: string): Promise<any>;
};

/** 5 MB. A phone photo of a notebook page compresses well below this. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function blobStore(locals: any): Blob {
  const bucket = locals?.runtime?.env?.NOTEBOOK as R2Like | undefined;

  return {
    available: () => Boolean(bucket),

    async put(path, body, contentType) {
      if (!bucket) throw new Error('No file storage is bound to this deployment');
      await bucket.put(path, body, { httpMetadata: { contentType } });
    },

    async get(path) {
      if (!bucket) return null;
      const object = await bucket.get(path);
      if (!object) return null;
      return {
        body: object.body as ReadableStream,
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      };
    },
  };
}

/**
 * Paths are namespaced by project so a listing can never span two of them,
 * and the filename is sanitized because it came from a person's phone.
 */
export function notePath(projectId: string, noteId: string, filename: string): string {
  const clean = filename.replace(/[^\w.-]/g, '_').slice(-80);
  return `projects/${projectId}/notes/${noteId}/${Date.now()}-${clean}`;
}

export function deliverablePath(entryId: string, filename: string): string {
  const clean = filename.replace(/[^\w.-]/g, '_').slice(-80);
  return `entries/${entryId}/deliverables/${Date.now()}-${clean}`;
}
