/**
 * WHERE SOMEBODY WAS TRYING TO GO.
 *
 * A student clicking a link at nine in the evening has no session. Without
 * this they are sent to sign in and then dropped on the overview, having to
 * hunt for the thing the link named. Every notification link would lose its
 * destination at the door, which makes the link decorative and the message
 * pointless (20.10).
 *
 * So the destination travels as `?next=`, through both ways in, and is
 * honored on return.
 *
 * **The validation is the whole of this file.** A redirect parameter that
 * accepts anything is an open redirect, and an open redirect in a link we
 * mailed to a child is worse than having no link at all: it lends our
 * hostname, in an email a school told them to trust, to somewhere else
 * entirely.
 *
 * The rule is deliberately narrow. A destination is one of our own paths:
 * it begins with a single slash, carries no scheme and no host, and lives
 * under `/app/`. Everything else is discarded silently and the person lands
 * on the overview, which is where they would have landed anyway.
 *
 * `//evil.example` is the case people miss. A browser reads a
 * protocol-relative URL as another origin, and it satisfies "starts with a
 * slash", so the second character is checked as carefully as the first.
 */

/** Where somebody goes when there is no destination, or a bad one. */
export const HOME = '/app/';

/**
 * A destination we are willing to send somebody to after signing in.
 *
 * Returns `HOME` rather than null, so a caller cannot forget to handle the
 * rejection and accidentally pass an unchecked value onward.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value) return HOME;

  /* Percent encoding is how `%2f%2fevil.example` gets past a check that only
     looks at the literal characters. Decode first, and treat a malformed
     sequence as hostile rather than as empty. */
  let path: string;
  try {
    path = decodeURIComponent(value);
  } catch {
    return HOME;
  }

  /* A control character or a newline can split a header. Nothing legitimate
     here contains one. */
  if (/[\u0000-\u001f\u007f]/.test(path)) return HOME;

  /* One leading slash, and the next character is not another one and not a
     backslash: `//evil.example` and `/\evil.example` are both read as
     another origin by at least one browser. */
  if (!path.startsWith('/')) return HOME;
  if (path.startsWith('//') || path.startsWith('/\\')) return HOME;

  /* No scheme, no authority, no matter how it is spelled. */
  if (/^\/+[a-z][a-z0-9+.-]*:/i.test(path)) return HOME;

  /* The working surface only. A notification never points anywhere else,
     and a public page needs no session to read, so there is nothing for
     this to carry somebody to outside `/app/`. */
  if (!path.startsWith('/app/')) return HOME;

  return path;
}

/**
 * The sign-in destination, with the current address remembered.
 *
 * Used by a page that finds no session: it sends somebody to sign in and
 * says where they were headed.
 */
export function signInWith(url: URL): string {
  const here = `${url.pathname}${url.search}${url.hash}`;
  const next = safeNext(here);
  return next === HOME ? HOME : `${HOME}?next=${encodeURIComponent(next)}`;
}
