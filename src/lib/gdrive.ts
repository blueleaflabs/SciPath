/**
 * A GOOGLE DRIVE ADDRESS, RENDERED.
 *
 * A Doc, Sheet, Slides deck or Drive file linked to a document can be
 * shown on the page rather than opened in another tab: Google serves a
 * read-only preview at a `/preview` address for each, which renders for
 * whoever Google lets read the file (the author's family, if it is shared
 * with them; anybody, if it is shared with the link). We store the
 * address and never fetch it (7.4); the browser asks Google, not us.
 *
 * Only these hosts, only these shapes. Anything else is a link.
 */

const PATTERNS: { re: RegExp; make: (id: string) => string }[] = [
  { re: /^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]+)/, make: (id) => `https://docs.google.com/document/d/${id}/preview` },
  { re: /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/, make: (id) => `https://docs.google.com/spreadsheets/d/${id}/preview` },
  { re: /^https:\/\/docs\.google\.com\/presentation\/d\/([A-Za-z0-9_-]+)/, make: (id) => `https://docs.google.com/presentation/d/${id}/preview` },
  { re: /^https:\/\/docs\.google\.com\/forms\/d\/([A-Za-z0-9_-]+)/, make: (id) => `https://docs.google.com/forms/d/${id}/viewform?embedded=true` },
  { re: /^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/, make: (id) => `https://drive.google.com/file/d/${id}/preview` },
  { re: /^https:\/\/drive\.google\.com\/open\?id=([A-Za-z0-9_-]+)/, make: (id) => `https://drive.google.com/file/d/${id}/preview` },
];

/** The preview address for a Drive link, or null when it is not one. */
export function drivePreviewUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = String(url).trim();
  for (const { re, make } of PATTERNS) {
    const m = s.match(re);
    if (m) return make(m[1]);
  }
  return null;
}

/** What kind of thing it is, for the label. */
export function driveKind(url: string | null | undefined): string {
  const s = String(url ?? '');
  if (/docs\.google\.com\/document/.test(s)) return 'Google Doc';
  if (/docs\.google\.com\/spreadsheets/.test(s)) return 'Google Sheet';
  if (/docs\.google\.com\/presentation/.test(s)) return 'Google Slides';
  if (/docs\.google\.com\/forms/.test(s)) return 'Google Form';
  if (/drive\.google\.com/.test(s)) return 'Drive file';
  return 'link';
}
