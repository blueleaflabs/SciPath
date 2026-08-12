/**
 * ONE VIDEO, LOADED ONLY IF SOMEBODY ASKS.
 *
 * An ordinary YouTube iframe contacts Google before anybody presses play,
 * from a page about a minor's work, on a site whose search page says no query
 * is logged anywhere. That is a contradiction a visitor cannot see and cannot
 * decline.
 *
 * So the page shows a still frame and a play button, and the embed is created
 * on click. Nothing leaves the browser until somebody chooses to watch. The
 * still comes from the provider's own thumbnail service, which is one request
 * to a static image host rather than a tracking-capable player, and both
 * providers offer a privacy mode for the embed itself.
 *
 * We store a string and never fetch the video. 7.4.
 */

export type VideoHost = 'youtube' | 'vimeo';

export interface Video {
  host: VideoHost;
  id: string;
  /** The privacy-preserving embed address, used only after a click. */
  embed: string;
  /** Where to send somebody who would rather watch it there. */
  watch: string;
  /** A still, so the page has something to show before any embed exists. */
  poster: string | null;
}

/**
 * Parse an address into the pieces a page needs, or null.
 *
 * Null rather than throwing: a video that cannot be parsed should leave the
 * page without one, not take the page down.
 */
export function parseVideo(url: string | null | undefined): Video | null {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.replace(/^www\./, '');

  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const id = parsed.searchParams.get('v') ?? parsed.pathname.split('/embed/')[1];
    if (!id) return null;
    return youtube(id.split(/[/?&]/)[0]);
  }

  if (host === 'youtu.be') {
    const id = parsed.pathname.slice(1).split(/[/?&]/)[0];
    return id ? youtube(id) : null;
  }

  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    /* The numeric id, wherever it sits in the path. Vimeo addresses carry
       channels, albums, and an unlisted hash in front of it. */
    const id = parsed.pathname.split('/').find((part) => /^\d+$/.test(part));
    if (!id) return null;
    return {
      host: 'vimeo',
      id,
      /* dnt asks Vimeo not to track the session. */
      embed: `https://player.vimeo.com/video/${id}?dnt=1&title=0&byline=0`,
      watch: `https://vimeo.com/${id}`,
      /* Vimeo's still needs an API call. See `posterFor` below: it is
         fetched once when a record is published, by us, and stored with the
         record — so a reader's browser still requests nothing from Vimeo
         until they press play. Null here means "not resolved yet". */
      poster: null,
    };
  }

  return null;
}

function youtube(id: string): Video {
  return {
    host: 'youtube',
    id,
    /* nocookie is the domain that does not set one until playback. */
    embed: `https://www.youtube-nocookie.com/embed/${id}?rel=0&autoplay=1`,
    watch: `https://www.youtube.com/watch?v=${id}`,
    poster: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  };
}


/**
 * The still for a video, resolved once at publish time.
 *
 * YouTube publishes one at a predictable address and needs no call. Vimeo
 * does not, and its oEmbed endpoint answers with a thumbnail URL.
 *
 * The distinction that matters is who makes the request. A reader's browser
 * asking Vimeo for a thumbnail is a third party learning that somebody
 * opened this page; a server asking once, at the moment of publishing, on
 * behalf of the person publishing, is not. The stored file is served from
 * our own record store afterwards.
 *
 * **[VERIFY]** The oEmbed address below is Vimeo's documented endpoint as I
 * understand it, and it has not been checked against their current
 * documentation. If it changes, this returns null and the page falls back to
 * a drawn panel, which is the right failure: a missing still is a cosmetic
 * loss and a wrong fetch is not.
 */
export async function posterFor(
  video: Video,
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  if (video.poster) return video.poster;
  if (video.host !== 'vimeo') return null;

  try {
    const answer = await fetcher(
      `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(video.watch)}`,
      { headers: { accept: 'application/json' } }
    );

    if (!answer.ok) return null;

    const body = (await answer.json()) as { thumbnail_url?: unknown };
    const url = typeof body.thumbnail_url === 'string' ? body.thumbnail_url : null;

    /* Only from Vimeo's own image host, and only over https. An oEmbed
       response is somebody else's JSON, and a URL taken from it and rendered
       in an <img> is a request we would be making on a reader's behalf to
       wherever it points. */
    if (!url) return null;

    const parsed = new URL(url);
    const allowed = parsed.protocol === 'https:' && /(^|\.)vimeocdn\.com$/.test(parsed.hostname);

    return allowed ? url : null;
  } catch {
    /* No network, a changed endpoint, a video that has been removed. The
       page draws its own panel. */
    return null;
  }
}
