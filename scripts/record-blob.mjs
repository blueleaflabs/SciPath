/**
 * THE TWO HELPERS EVERY SCRIPT THAT WRITES RECORDS NEEDS (dev-149).
 *
 * `seed-publish` and `seed-journal` each carried a copy of both; the
 * refresh made a third. One place now.
 */

/** The blob interface `assembleRecord` expects, over a bucket. */
export function blobOver(bucket) {
  return {
    available: () => Boolean(bucket),
    async get(path) {
      if (!bucket) return null;
      const object = await bucket.get(path);
      if (!object) return null;
      return {
        body: await object.arrayBuffer(),
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      };
    },
  };
}

/**
 * Miniflare's proxy asserts on a typed array whose byte offset is not zero,
 * and a Node Buffer almost never starts at zero. The remote path is
 * unaffected; this is only the local bucket.
 */
export function normalize(body) {
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  }
  return body;
}
