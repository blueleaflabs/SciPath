/**
 * SENDING, WHICH IS ONE FILE ON PURPOSE.
 *
 * Everything above this knows how to decide what to say and to whom.
 * Nothing above this knows what carries it, which is what makes the provider
 * replaceable: SES, or a district relay, or something not invented yet
 * (20.9).
 *
 * **The default sends nothing.** `console` prints, and it is what runs
 * unless somebody has deliberately configured otherwise, because the cost of
 * a development run reaching a real student is not symmetric with the cost of
 * one not reaching a terminal.
 *
 * Three independent guards, and each one alone would be enough:
 *
 *   1. The transport is `console` unless `MAIL_TRANSPORT=resend` is set.
 *   2. Nothing is sent to an address ending `@demo.invalid`, which is every
 *      fixture. The domain is reserved by RFC 2606 and cannot resolve, but
 *      refusing it here means a misconfigured run fails loudly rather than
 *      bouncing quietly off a mail server.
 *   3. `MAIL_ALLOWLIST`, when set, is the only set of addresses that may be
 *      reached. During testing it holds one address: the person testing.
 *      Somebody else's student cannot receive a message from a laptop.
 *
 * There was briefly a fourth, `MAIL_REDIRECT`, which sent everything to one
 * address so that delivery could be tested apart from a school district's
 * filtering. It did its job and it is gone: **a message that goes somewhere
 * other than where the code says it goes is a hazard once the question it
 * answered has been answered**, and it survived being commented out of
 * `.dev.vars` because an exported variable beats a file. A setting that is
 * hard to turn off is worse than one that never existed.
 *
 * The third is the one that matters while this is new. It turns "I hope the
 * fixtures are all on demo.invalid" into a list somebody wrote on purpose.
 */

export interface Message {
  to: string;
  subject: string;
  text: string;
}

export interface Sent {
  ok: boolean;
  error?: string;
  /** True where a guard stopped it rather than a failure. */
  skipped?: boolean;
}

export interface Transport {
  name: string;
  send(message: Message): Promise<Sent>;
}

export interface MailEnv {
  MAIL_TRANSPORT?: string;
  MAIL_FROM?: string;
  MAIL_ALLOWLIST?: string;
  RESEND_API_KEY?: string;
}

const FIXTURE_DOMAIN = '@demo.invalid';

/** Whether this address may be written to at all, and why not. */
export function refuse(address: string, env: MailEnv): string | null {
  const to = address.trim().toLowerCase();

  if (!to || !to.includes('@')) return 'not an address';
  if (to.endsWith(FIXTURE_DOMAIN)) return 'a fixture address';

  const allowlist = (env.MAIL_ALLOWLIST ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  if (allowlist.length > 0 && !allowlist.includes(to)) {
    return 'not on MAIL_ALLOWLIST';
  }

  return null;
}

/** Prints and sends nothing. The default, and what tests run against. */
export function consoleTransport(): Transport {
  return {
    name: 'console',
    async send(message) {
      console.log(
        [
          '',
          '─'.repeat(72),
          `To:      ${message.to}`,
          `Subject: ${message.subject}`,
          '─'.repeat(72),
          message.text,
          '',
        ].join('\n')
      );
      return { ok: true };
    },
  };
}

/**
 * Resend, over HTTPS with an API key.
 *
 * No OAuth and no token to refresh, which is why this rather than Gmail: a
 * refresh token from an app in Testing status expires every seven days, and
 * unattended sending that breaks weekly is not sending (20.9).
 */
export function resendTransport(env: MailEnv): Transport {
  const key = env.RESEND_API_KEY ?? '';
  const from = env.MAIL_FROM ?? '';

  return {
    name: 'resend',
    async send(message) {
      if (!key) return { ok: false, error: 'RESEND_API_KEY is not set' };
      if (!from) return { ok: false, error: 'MAIL_FROM is not set' };

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        /* One recipient per message, always. A privacy rule first — two
           students on one project are two messages, and neither learns the
           other's address — and a provider recipient cap second (20.8). */
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });

      if (response.ok) return { ok: true };

      /* The body, not just the status. Resend says which field it disliked,
         and a drain that records "400" gives whoever reads `last_error`
         nothing to act on. */
      const detail = await response.text().catch(() => '');
      return { ok: false, error: `${response.status} ${detail}`.slice(0, 300) };
    },
  };
}

/**
 * The transport this environment asked for, wrapped in the guards.
 *
 * The wrapper is where the refusals live rather than inside each transport,
 * so a provider added later cannot forget them.
 */
export function transportFor(env: MailEnv): Transport {
  const chosen =
    env.MAIL_TRANSPORT === 'resend' ? resendTransport(env) : consoleTransport();

  return {
    name: chosen.name,
    async send(message) {
      const why = refuse(message.to, env);

      if (why) {
        console.log(`  skipped  ${message.to}  (${why})`);
        return { ok: true, skipped: true };
      }

      return chosen.send(message);
    },
  };
}
