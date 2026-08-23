/**
 * POST, REDIRECT, GET.
 *
 * Every form on the working surface posted to its own page and the page
 * rendered the result of that POST directly. The address bar then held a
 * POST, so a refresh asked the browser to send it again — *Confirm form
 * resubmission* — and the honest answer to that dialog is that nobody
 * knows, because the second send might record a second deliverable, grant a
 * second place, or publish a second record.
 *
 * The fix is as old as the web: answer a successful POST with a redirect,
 * and let the browser fetch the result as a GET. A refresh then re-reads a
 * page instead of repeating an action, and the back button stops walking
 * back through submissions.
 *
 * **303 rather than 302.** A 302 leaves the method to the browser and some
 * will repeat the POST at the new address; 303 says *go and GET this*,
 * which is the whole point.
 *
 * The outcome travels in the query string because there is nowhere else to
 * put it: a message is not worth a session, and a flash cookie is state to
 * expire, invalidate and reason about for the sake of one sentence. It is
 * capped so a long database error cannot build an address no proxy will
 * carry, and it is text a person just caused rather than anything private.
 *
 * It is displayed and never trusted: the browser renders it as text, so a
 * crafted link says something untrue to whoever clicks it and nothing more.
 * Anything that acts on an outcome would have to read it from the database
 * instead.
 */

const MAX = 300;

export interface Outcome {
  /** Something went wrong, in words a student can act on. */
  error?: string | null;
  /** It worked, and this says what happened. */
  note?: string | null;
  /**
   * The answer was no, and there is nothing to correct.
   *
   * A third kind, because it is not either of the others. An error is a
   * thing to fix and send again; a note is a thing that happened. A refusal
   * ends the exchange, and the page that renders one owes somebody a
   * different shape entirely rather than a red sentence they will try to
   * work around.
   *
   * A flag, not a sentence: the words belong to the page that knows what was
   * refused, and a message travelling in an address is a message somebody
   * can rewrite before sending the link on.
   */
  refused?: boolean;
}

/**
 * End a POST handler with this.
 *
 * Returns a redirect to the same path, carrying the outcome, anchored at
 * `#outcome` so a message rendered at the top of a long page is not three
 * screens above the control that produced it.
 */
export function afterPost(url: URL, outcome: Outcome): Response {
  const params = new URLSearchParams();

  if (outcome.refused) params.set('no', '1');
  else if (outcome.error) params.set('e', outcome.error.slice(0, MAX));
  else if (outcome.note) params.set('m', outcome.note.slice(0, MAX));

  const query = params.toString();

  return new Response(null, {
    status: 303,
    headers: { Location: `${url.pathname}${query ? `?${query}` : ''}#outcome` },
  });
}

/** Read back what the redirect carried. Seed the page's own variables here. */
export function outcomeFrom(url: URL): {
  error: string | null;
  note: string | null;
  refused: boolean;
} {
  return {
    error: url.searchParams.get('e'),
    note: url.searchParams.get('m'),
    refused: url.searchParams.get('no') === '1',
  };
}

/**
 * Going somewhere else after a POST.
 *
 * `afterPost` anchors at `#outcome` because it comes back to the same page,
 * where a message rendered three screens above the control that produced it
 * reads as nothing having happened. A redirect that *leaves* wants the
 * opposite, and gets it wrong by default.
 *
 * **A browser inherits the fragment.** When a redirect's `Location` carries
 * no fragment of its own, the fragment of the request URL is used instead,
 * so somebody who had just seen an outcome on `/app/#outcome` and then
 * joined a program arrived at `/app/entry/{id}/#outcome` — which on that
 * page is below the hero and all four cards, so the first thing they ever
 * saw of their own project was the middle of it.
 *
 * An empty fragment is not the same as no fragment. `#` parses to a fragment
 * of zero length, which is not null, so nothing is inherited and the browser
 * goes to the top of the document.
 */
export function leaveTo(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${path}#` },
  });
}
