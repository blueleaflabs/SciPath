export const prerender = false;

/**
 * THE PULSE (2.8).
 *
 * The newest moment among everything this person may read, as one
 * timestamp. The app shell asks every few seconds; a page re-reads its
 * live regions only when the answer changes, so a reply to a question
 * lands on the document page without anybody reloading it. `my_pulse()`
 * runs as the caller, so it says nothing the policies would not.
 */

import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/supabase';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

export const GET: APIRoute = async ({ request, cookies, locals }) => {
  if (!(locals as any).session) return json({ ok: false }, 401);
  const supabase = serverClient(request, cookies, (locals as any).runtime?.env);
  const { data, error } = await supabase.rpc('my_pulse');
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, at: data ?? null });
};
