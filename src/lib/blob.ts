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
 * and the **extension is generated from the detected type**, never taken from
 * the name.
 *
 * The name came from a person's phone and could equally have come from a
 * script: `report.png` holding HTML was stored under `.png`, served as an
 * image type, and only a browser's own sniffing stood between that and a
 * page running from our origin. Sanitizing the name stopped it breaking a
 * path; it never made the name true.
 *
 * `stem` keeps something human in the middle so a listing is readable, and
 * the extension after it is the one `src/lib/filetype.ts` read from the
 * bytes.
 */
function stem(filename: string): string {
  return filename.replace(/\.[^.]*$/, '').replace(/[^\w-]/g, '_').slice(-60) || 'file';
}
export function notePath(projectId: string, noteId: string, filename: string, ext: string): string {
  return `projects/${projectId}/notes/${noteId}/${Date.now()}-${stem(filename)}.${ext}`;
}

export function figurePath(manuscriptId: string, filename: string, ext: string): string {
  return `manuscripts/${manuscriptId}/figures/${Date.now()}-${stem(filename)}.${ext}`;
}

/** Showcase images live under the project, not the manuscript: they outlast
 *  any paper and belong to the project whether one is ever written. */
export function projectImagePath(projectId: string, _filename: string, ext: string): string {
  return `projects/${projectId}/images/${crypto.randomUUID()}.${ext}`;
}

export function manuscriptPdfPath(manuscriptId: string, filename: string, ext: string): string {
  return `manuscripts/${manuscriptId}/paper/${Date.now()}-${stem(filename)}.${ext}`;
}

export function deliverablePath(entryId: string, filename: string, ext: string): string {
  return `entries/${entryId}/deliverables/${Date.now()}-${stem(filename)}.${ext}`;
}
