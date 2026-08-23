/**
 * WHAT A FILE ACTUALLY IS.
 *
 * Upload handlers checked `file.size` and trusted `file.type` and the name.
 * Both come from the browser, and both are whatever the person posting chose
 * to put in the multipart body — so an HTML page named `figure.png` and
 * declared `image/png` was stored as an image and served from our origin.
 *
 * **SVG is refused outright.** It was in the served MIME map, and its own
 * comment said that list was "the allowlist as well as the lookup", so it was
 * permitted deliberately. An SVG is a document: it carries `<script>`, event
 * handlers and external references, and one served same-origin on a public
 * record page is stored cross-site scripting reachable by renaming a file.
 * Nothing in a science fair needs one that a PNG cannot do.
 *
 * The type this returns is the type that gets stored and the extension that
 * gets written, so the name a person chose never decides how their file is
 * later served.
 */

export interface Detected {
  /** The media type, from the bytes. */
  mime: string;
  /** The extension to store it under, also from the bytes. */
  ext: string;
}

/**
 * Signatures, in the order they must be tried.
 *
 * WebP and AVIF both begin `RIFF`/`ftyp` containers, so a prefix match alone
 * is not enough for either and each carries a second check below.
 */
const SIGNATURES: { ext: string; mime: string; bytes: number[] }[] = [
  { ext: 'png', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'pdf', mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((b, i) => bytes[i] === b);
}

function ascii(bytes: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...bytes.slice(from, from + length));
}

/**
 * Identify a file, or refuse it.
 *
 * Returns null for anything not on the list, which includes SVG, HTML, and a
 * renamed anything. The caller reports the refusal; this decides.
 */
export function detect(bytes: Uint8Array): Detected | null {
  for (const s of SIGNATURES) {
    if (startsWith(bytes, s.bytes)) return { ext: s.ext, mime: s.mime };
  }

  /* WebP: `RIFF....WEBP`. The four bytes between are the length, so this
     cannot be a single prefix. */
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }

  return null;
}

/**
 * A polyglot check, run after `detect` and independently of it.
 *
 * A file can satisfy a signature and still be a document: `GIF89a` followed
 * by `<script>` is a real technique, and so is a PDF with HTML appended.
 * Signature matching alone answers *does it begin correctly*, which is not
 * the same question as *is it only this*.
 *
 * The first kilobyte, because that is where a browser's own sniffing looks
 * and therefore where a disguised document has to put its opening tag to be
 * useful.
 */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024)).toLowerCase();

  return (
    head.includes('<script') ||
    head.includes('<html') ||
    head.includes('<!doctype') ||
    head.includes('<svg') ||
    head.includes('<?xml')
  );
}

/** Everything an upload boundary needs, in one call. */
export async function identify(file: File): Promise<Detected | null> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());

  if (looksLikeMarkup(head)) return null;
  return detect(head);
}
