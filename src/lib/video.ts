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
      /* Vimeo's thumbnail needs an API call, which is a fetch we have said we
         will not make. The page shows its own placeholder instead. */
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
