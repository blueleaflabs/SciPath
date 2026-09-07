/**
 * THE SOCKET, IN THE BROWSER (2.8).
 *
 * One connection per tab to Supabase Realtime, straight from the browser,
 * so the edge Worker carries none of it. The app shell joins the person's
 * own channel and the rooms of their projects and classes; a page joins
 * more (a document's room) through the same client. A message on any of
 * them is a change to something this page may read.
 *
 * Health is judged here and read by the shell. The socket is primary. A
 * channel that cannot subscribe within its deadline, or that errors three
 * times in quick succession, puts the transport in `fallback`, and the
 * shell then polls the pulse on the school's schedule and says so on the
 * page. The socket keeps trying underneath (the library reconnects with
 * backoff), and the first channel to come back moves the transport to
 * `live` again.
 *
 * Kept on `window` rather than in module state, because the shell's
 * script and a page's script are bundled apart and must share the one
 * socket.
 */

import { createBrowserClient } from '@supabase/ssr';

export type Health = 'starting' | 'live' | 'fallback' | 'off';

export interface LiveMessage { topic: string; event: string; payload: any }
type MessageHandler = (m: LiveMessage) => void;
type HealthHandler = (h: Health, detail: string) => void;

interface LiveState {
  client: any;
  channels: Map<string, any>;
  handlers: Set<MessageHandler>;
  health: Health;
  detail: string;
  onHealth: Set<HealthHandler>;
  errors: number[];
  everLive: boolean;
  me: string;
}

declare global { interface Window { __spLive?: LiveState } }

const DEADLINE = 12_000;
const ERRORS_TO_FALL = 3;
const ERROR_WINDOW = 90_000;

function setHealth(st: LiveState, h: Health, detail = '') {
  if (st.health === h && st.detail === detail) return;
  st.health = h;
  st.detail = detail;
  for (const fn of st.onHealth) { try { fn(h, detail); } catch {} }
}

/** The shared state, made on first use from the shell's data attributes. */
export function live(): LiveState | null {
  if (typeof window === 'undefined') return null;
  if (window.__spLive) return window.__spLive;
  const root = document.querySelector<HTMLElement>('[data-live-url]');
  const url = root?.dataset.liveUrl ?? '';
  const key = root?.dataset.liveKey ?? '';
  const me = root?.dataset.liveMe ?? '';
  if (!url || !key || !me) return null;
  let client: any;
  try {
    client = createBrowserClient(url, key, { realtime: { params: { eventsPerSecond: 5 } } } as any);
  } catch {
    return null;
  }
  const st: LiveState = { client, channels: new Map(), handlers: new Set(), health: 'starting', detail: '', onHealth: new Set(), errors: [], everLive: false, me };
  window.__spLive = st;
  return st;
}

/** Who this browser is signed in as (the shell knows; the page asks). */
export function liveMe(): string { return live()?.me ?? ''; }

/** Hear every message on every joined channel. */
export function onMessage(fn: MessageHandler): () => void {
  const st = live();
  if (!st) return () => {};
  st.handlers.add(fn);
  return () => st.handlers.delete(fn);
}

/** Hear the transport's health, and the current value at once. */
export function onHealth(fn: HealthHandler): () => void {
  const st = live();
  if (!st) { fn('off', 'no socket configured'); return () => {}; }
  st.onHealth.add(fn);
  fn(st.health, st.detail);
  return () => st.onHealth.delete(fn);
}

export function health(): Health { return live()?.health ?? 'off'; }

/** The shell gives up on the socket for a reason of its own (no topics, no session). */
export function fail(detail: string) {
  const st = live();
  if (st) setHealth(st, 'fallback', detail);
}

/* A tab in the background or a browser that says it is offline is not a
   network that refuses WebSockets (2.9): a laptop closing its lid drops
   the socket and the library's reconnects trip errors on the way back,
   which read as a transport failure and mailed the operator. Errors in
   that state do not count, and when the tab is seen again the channels
   get a fresh deadline before they are judged. */
function quiet(): boolean {
  return typeof document !== 'undefined' && (document.hidden || (typeof navigator !== 'undefined' && navigator.onLine === false));
}

function noteError(st: LiveState, what: string) {
  if (quiet()) return;
  const now = Date.now();
  st.errors = st.errors.filter((t) => now - t < ERROR_WINDOW);
  st.errors.push(now);
  if (st.errors.length >= ERRORS_TO_FALL) setHealth(st, 'fallback', what);
}

/**
 * Join a private channel. Returns the channel; presence is on when asked,
 * keyed by the person, so a page can say who is in the room and where.
 */
export function join(topic: string, opts: { presence?: boolean } = {}): any {
  const st = live();
  if (!st) return null;
  const had = st.channels.get(topic);
  if (had) return had;
  const ch = st.client.channel(topic, { config: { private: true, ...(opts.presence ? { presence: { key: st.me } } : {}) } });
  ch.on('broadcast', { event: '*' }, (m: any) => {
    const msg: LiveMessage = { topic, event: m.event, payload: m.payload };
    for (const fn of st.handlers) { try { fn(msg); } catch {} }
  });
  let subscribed = false;
  let lost = false;
  let deadline = 0;
  const arm = () => {
    window.clearTimeout(deadline);
    deadline = window.setTimeout(() => {
      if (subscribed || st.health === 'live') return;
      /* Not yet, and not looking: judge it when somebody is. */
      if (quiet()) { arm(); return; }
      setHealth(st, 'fallback', 'no subscription within 12 seconds');
    }, DEADLINE);
  };
  arm();
  const again = () => { if (!subscribed && !quiet()) arm(); };
  document.addEventListener('visibilitychange', again);
  window.addEventListener('online', again);
  ch.subscribe((status: string, err?: any) => {
    if (status === 'SUBSCRIBED') {
      subscribed = true;
      window.clearTimeout(deadline);
      st.errors = [];
      const was = st.health;
      setHealth(st, 'live', '');
      /* Back after a gap: the page re-reads what it may have missed. */
      if (was === 'fallback' || lost) document.dispatchEvent(new CustomEvent('live:reconnected', { detail: { topic } }));
      lost = false;
      st.everLive = true;
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      if (subscribed) lost = true;
      subscribed = false;
      noteError(st, `${status}${err?.message ? `: ${err.message}` : ''}`);
    } else if (status === 'CLOSED') {
      if (subscribed) lost = true;
      subscribed = false;
    }
  });
  st.channels.set(topic, ch);
  return ch;
}

/** Leave a channel a page no longer needs. */
export function leave(topic: string) {
  const st = live();
  const ch = st?.channels.get(topic);
  if (!st || !ch) return;
  st.channels.delete(topic);
  try { st.client.removeChannel(ch); } catch {}
}

/**
 * The topics this person listens on, asked of the database directly and
 * kept for the session: the list changes when a project or a role is
 * added, which is rare, so one call an hour per browser, not one per
 * page. Keyed by the person, so a shared browser never inherits another
 * account's rooms (the policy would refuse them anyway).
 */
const TOPICS_TTL = 60 * 60 * 1000;
export async function myTopics(fresh = false): Promise<string[]> {
  const st = live();
  if (!st) return [];
  const key = `sp:topics:${st.me}`;
  if (!fresh) {
    try {
      const had = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      if (had && Array.isArray(had.topics) && Date.now() - had.at < TOPICS_TTL) return had.topics;
    } catch {}
  }
  const { data, error } = await st.client.rpc('my_live_topics');
  if (error) { noteError(st, `topics: ${error.message}`); return []; }
  const topics = Array.isArray(data) ? data : [];
  try { sessionStorage.setItem(key, JSON.stringify({ topics, at: Date.now() })); } catch {}
  return topics;
}
