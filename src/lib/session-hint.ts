/**
 * TELLING A STATIC PAGE THAT SOMEBODY IS SIGNED IN.
 *
 * The public surface is prerendered and must build with the database absent
 * entirely (12.3), so a guide or an article is a file with no session behind
 * it. The masthead therefore rendered "Sign in" to somebody who had signed
 * in a minute earlier, on every page outside `/app/`.
 *
 * The session itself cannot help. Supabase's auth cookies are the session
 * and are not for reading in a browser, and querying from a prerendered page
 * is the one thing the archive rule forbids.
 *
 * So this is a hint: a cookie the browser can read, carrying the display
 * name and nothing else.
 *
 * **It held only a flag until 1.57**, on the argument that a static page
 * should learn somebody is signed in and never who. That was the more
 * careful choice and it produced a worse page: signing in and then opening
 * a guide showed a bare Workbench link, which reads as *not you* rather than
 * as *you, elsewhere*. The name is the only thing that makes the masthead
 * consistent with every other page.
 *
 * What is actually being weighed: a person's own display name, in their own
 * browser, on our own origin, which every page they were just looking at
 * already showed them. It is not an identifier, it is not an address, and
 * anything able to read it can already read the session beside it. That is a
 * different proposition from writing a name into a mail, which 20.8 still
 * refuses.
 *
 * Set by the middleware rather than by the sign in routes, because the
 * middleware is where the account is already loaded: no extra query, and a
 * changed name corrects itself on the next request rather than persisting
 * until somebody signs out.
 *
 * It can go stale: a session that expires leaves the name behind, and the
 * archive then greets somebody who is no longer signed in. That is the right
 * direction to be wrong in. The reverse — telling somebody they are signed
 * out when they are not — is the failure being fixed.
 */

export const SESSION_HINT = 'scipath_in';

interface CookieJar {
  set: (name: string, value: string, options?: Record<string, unknown>) => void;
  delete: (name: string, options?: Record<string, unknown>) => void;
}

/** After a successful sign-in, by either route. */
export function setSessionHint(
  cookies: CookieJar,
  displayName: string,
  secure = true
): void {
  /* Encoded, because a cookie value may not carry a comma, a semicolon or a
     space, and a display name may carry all three. */
  cookies.set(SESSION_HINT, encodeURIComponent(displayName), {
    path: '/',
    /* Readable by the script in the masthead, which is the entire point. The
       session cookies beside it stay as Supabase set them, and anything able
       to read this can already read those. */
    httpOnly: false,
    sameSite: 'lax',
    /* Passed in rather than assumed. A browser drops a Secure cookie on
       plain http, and the masthead would go on offering to sign in somebody
       who had. */
    secure,
    /* A school year. The session is shorter and governs everything that
       matters; this only decides which word the masthead prints. */
    maxAge: 60 * 60 * 24 * 365,
  });
}

/** On sign out, and anywhere a session is known to be gone. */
export function clearSessionHint(cookies: CookieJar): void {
  cookies.delete(SESSION_HINT, { path: '/' });
}
