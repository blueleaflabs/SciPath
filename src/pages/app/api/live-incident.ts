export const prerender = false;

/**
 * THE SOCKET WOULD NOT CARRY (2.8).
 *
 * A page whose live socket failed, and fell back to the pulse, says so
 * here once. The database keeps the line (an hour's worth of the same
 * person's flapping is one line) and, when it is a new line and the
 * transport is configured, the same address the Feedback form writes to
 * (`FEEDBACK_TO`) gets a short mail, so whoever runs the platform hears
 * about a blocking network while the class is still in the room. The
 * recovery is kept as a line too, mailed only as a one-line follow-up.
 */

import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/supabase';
import { activeOrg } from '../../../lib/tenant';
import { transportFor, refuse, type MailEnv } from '../../../lib/notify/transport';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });

export const POST: APIRoute = async (ctx) => {
  const { request, cookies, locals } = ctx;
  const session = (locals as any).session;
  if (!session) return json({ ok: false }, 401);
  const runtime = ((locals as any).runtime?.env ?? {}) as Record<string, any>;
  const supabase = serverClient(request, cookies, runtime);

  let body: any;
  try { body = JSON.parse(await request.text()); } catch { return json({ ok: false, error: 'not JSON' }, 400); }
  const state = body?.state === 'recovered' ? 'recovered' : 'fallback';
  const page = String(body?.page ?? '').slice(0, 300);
  const detail = String(body?.detail ?? '').slice(0, 1000);
  const agent = (request.headers.get('User-Agent') ?? '').slice(0, 300);

  const { data: written, error } = await supabase.rpc('report_transport_incident', { p_state: state, p_page: page, p_detail: detail, p_agent: agent });
  if (error) return json({ ok: false, error: error.message }, 403);
  if (!written) return json({ ok: true, written: false });

  /* New line: tell the operator. Console transport prints; nothing is
     sent unless the environment says so, as with every other message. */
  const env: MailEnv = {
    MAIL_TRANSPORT: runtime.MAIL_TRANSPORT ?? import.meta.env.MAIL_TRANSPORT,
    MAIL_FROM: runtime.MAIL_FROM ?? import.meta.env.MAIL_FROM,
    MAIL_ALLOWLIST: runtime.MAIL_ALLOWLIST ?? import.meta.env.MAIL_ALLOWLIST,
    RESEND_API_KEY: runtime.RESEND_API_KEY ?? import.meta.env.RESEND_API_KEY,
    MAIL_FIXTURES: runtime.MAIL_FIXTURES ?? import.meta.env.MAIL_FIXTURES,
  };
  const to = String(runtime.FEEDBACK_TO ?? import.meta.env.FEEDBACK_TO ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const org = activeOrg(ctx as any);
  const who = (locals as any).account?.display_name ?? session.email ?? session.id;
  const text = state === 'fallback'
    ? [
        `Live updates fell back to polling for ${who} at ${org.name}.`,
        '',
        `Page: ${page || '(unknown)'}`,
        `Why: ${detail || '(no detail)'}`,
        `Browser: ${agent || '(unknown)'}`,
        '',
        'Reported only once the backup path has held for ninety seconds; a lid closing or a token refresh does not get this far.',
        'Most often this is a network that will not carry a WebSocket. The page keeps working on the pulse;',
        'the incident log at /app/live/ lists every person it happened to.',
      ].join('\n')
    : `The socket came back for ${who} at ${org.name} (${page || 'a page'})${detail ? `, ${detail}` : ''}.`;
  const failures: string[] = [];
  if (to.length > 0) {
    const transport = transportFor(env);
    for (const address of to) {
      const why = refuse(address, env);
      if (why) { failures.push(`${address}: ${why}`); continue; }
      const result = await transport.send({ to: address, subject: `[SciPath live] ${state === 'fallback' ? 'socket fell back' : 'socket recovered'} · ${who}`, text });
      if (!result.ok) failures.push(`${address}: ${result.error ?? 'not sent'}`);
    }
  }
  return json({ ok: true, written: true, mailed: to.length > 0 && failures.length === 0, failures });
};
