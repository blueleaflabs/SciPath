/**
 * THE CONTEXT, REMEMBERED FOR A MINUTE (2.9).
 *
 * `my_context()` is the one call the middleware makes before every request
 * on the working surface: the account, the roles, the classes, the
 * families, the person's own projects and their places. It is the same
 * answer on every autosave — 23 ms of an autosave's 70 on the hosted
 * instance, and one of the two calls the pulse makes — and it changes when
 * a role is granted or a project is made, which is rare and always a form
 * post of its own.
 *
 * So the answer is kept in a cookie for a minute, signed, so the browser
 * can carry it but cannot write it. The signature is HMAC-SHA256 with a key
 * derived from the project's secret key (the Worker has it; the browser
 * never does) over the person's id, the expiry and the payload, so a cookie
 * cannot be lent to another account, kept past its minute, or edited.
 *
 * **What a minute of staleness means.** A role granted, a project made or
 * an account suspended is seen by the next request after the cookie
 * expires — or at once, because the middleware clears the cookie on every
 * write to the surface except the autosave and the pulse (the two that
 * never change the context), and every write redirects to a read. Row
 * level security is judged on every read regardless: the cookie decides
 * what the shell draws, never what the database answers.
 *
 * Skipped, never partial: a context too large for a cookie (an advisor with
 * a long list of places) is not cached, and a cookie that fails any check
 * is ignored and replaced.
 */

import type { AstroCookies } from 'astro';

export const CONTEXT_COOKIE = 'sp_ctx';
export const CONTEXT_TTL_SECONDS = 60;
const MAX_BYTES = 3800;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(text: string): Uint8Array {
  const s = text.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function key(secret: string): Promise<CryptoKey> {
  /* Derived, so the secret itself is never the MAC key. */
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const derived = await crypto.subtle.sign('HMAC', base, enc.encode('scipath context cookie v1'));
  return crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(secret: string, text: string): Promise<string> {
  const k = await key(secret);
  const mac = await crypto.subtle.sign('HMAC', k, enc.encode(text));
  return b64url(new Uint8Array(mac));
}

/** The cookie's value for this person and context, or null when it would not fit. */
/**
 * Seal a small JSON value for one person for `ttl` seconds (dev-151 made
 * this general: the context cookie and the idle stamp are the same
 * shape — who, until when, what — under the same derived key).
 */
export async function seal(secret: string, userId: string, value: unknown, ttl: number, now = Date.now()): Promise<string | null> {
  const exp = Math.floor(now / 1000) + ttl;
  const payload = b64url(enc.encode(JSON.stringify(value)));
  const body = `${userId}.${exp}.${payload}`;
  if (body.length > MAX_BYTES) return null;
  return `${body}.${await sign(secret, body)}`;
}

export async function open(secret: string, userId: string, value: string | undefined, now = Date.now()): Promise<Record<string, any> | null> {
  if (!value) return null;
  const at = value.lastIndexOf('.');
  if (at < 0) return null;
  const body = value.slice(0, at);
  const mac = value.slice(at + 1);
  const [id, expText] = body.split('.', 2);
  if (id !== userId) return null;
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  const expected = await sign(secret, body);
  if (expected.length !== mac.length) return null;
  let diff = 0;
  for (let i = 0; i < mac.length; i += 1) diff |= expected.charCodeAt(i) ^ mac.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const json = new TextDecoder().decode(unb64url(body.slice(id.length + 1 + expText.length + 1)));
    const ctx = JSON.parse(json);
    return ctx && typeof ctx === 'object' ? ctx : null;
  } catch {
    return null;
  }
}

export function sealContext(secret: string, userId: string, ctx: unknown, now = Date.now()): Promise<string | null> {
  return seal(secret, userId, ctx, CONTEXT_TTL_SECONDS, now);
}

export function openContext(secret: string, userId: string, value: string | undefined, now = Date.now()): Promise<Record<string, any> | null> {
  return open(secret, userId, value, now);
}

export function writeContextCookie(cookies: AstroCookies, value: string, secure: boolean) {
  cookies.set(CONTEXT_COOKIE, value, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: CONTEXT_TTL_SECONDS });
}

export function clearContextCookie(cookies: AstroCookies) {
  if (cookies.has(CONTEXT_COOKIE)) cookies.delete(CONTEXT_COOKIE, { path: '/' });
}

/** The writes that never change the context: the autosave and the pulse. */
const UNCHANGING = new Set(['/app/api/field/', '/app/api/pulse/']);

/** Whether a request may change the context, and so must clear the cookie. */
export function mayChangeContext(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD') return pathname.startsWith('/auth/');
  return !UNCHANGING.has(pathname);
}
