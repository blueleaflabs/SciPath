/**
 * DRAINING THE OUTBOX.
 *
 * Nine kinds have enqueued into `notifications` since the table was written
 * and nothing has ever read it. This is the reader.
 *
 * **Why a drain and not a send at the moment of the click.** Every field on
 * that table presumes one: `send_after` so a burst becomes one message,
 * `dedupe_key` unique per recipient so a replay cannot double a message,
 * `attempts` and `last_error` so a failure can be retried. Sending inside the
 * request would leave all of it unused, and would put a mail provider's
 * latency inside a student's page load and its outage inside their click.
 *
 * **The cutoff, and why it is severe.** A queue that has been filling for
 * months would, on its first drain, mail everybody a year of arrears — every
 * decision, every membership, every publication, all at once, from a system
 * they have never received mail from. So nothing older than `SINCE_MINUTES`
 * is sent. Anything behind that is marked `skipped` and stays in the table as
 * a record that it was decided against rather than lost.
 *
 * Sixty minutes is deliberately tight while this is new. It is the difference
 * between a mistake that reaches one person and a mistake that reaches a
 * school.
 */

import { write, KNOWN, type Queued } from './platform.ts';
import { transportFor, type Message, type MailEnv } from './transport.ts';

/** How far back a message may be and still be worth sending. */
export const SINCE_MINUTES = 60;

/** How many attempts before a message is left alone. */
const MAX_ATTEMPTS = 3;

export interface DrainOptions {
  /** Print what would be sent and send nothing. */
  dryRun?: boolean;
  /** How many to take in one pass. */
  limit?: number;
  /** Overrides the cutoff. For a deliberate catch-up, never by default. */
  sinceMinutes?: number;
}

export interface DrainResult {
  sent: number;
  skipped: number;
  failed: number;
  lines: string[];
}

/**
 * A minimal client shape, so this can be driven from a script or a Worker.
 *
 * Typed structurally rather than importing a Supabase client, because the
 * two callers build theirs differently and neither should have to care.
 */
export interface Db {
  rpc(name: string, args: Record<string, unknown>): Promise<{ data: any; error: any }>;
  from(table: string): any;
}

export async function drain(
  db: Db,
  env: MailEnv,
  options: DrainOptions = {}
): Promise<DrainResult> {
  const { dryRun = false, limit = 50, sinceMinutes = SINCE_MINUTES } = options;

  const transport = transportFor(env);
  const out: DrainResult = { sent: 0, skipped: 0, failed: 0, lines: [] };

  /* Claimed in the database rather than selected and then updated here.
     Two drains overlapping — a cron trigger that has not finished when the
     next one starts — would otherwise both read the same rows and send them
     twice.
     
     `for update skip locked` alone does not prevent that, which is what the
     first version of this got wrong: the lock ends when the claim's own
     transaction returns, which is before anything has been sent. The claim
     moves rows to `processing` with a token and a lease, and settling
     requires that token back. */
  const { data: claimed, error } = await db.rpc('claim_notifications', {
    p_limit: limit,
    p_since_minutes: sinceMinutes,
    p_dry_run: dryRun,
  });

  if (error) throw new Error(`Could not claim: ${error.message}`);

  for (const row of claimed ?? []) {
    /* Too old to send, decided rather than lost. Marked by the claim itself
       so the row is not read again on the next pass. */
    if (row.verdict === 'stale') {
      out.skipped += 1;
      out.lines.push(`  skipped (too old)  ${row.kind} -> ${row.to_email}`);
      continue;
    }

    /* Nowhere to send it.
    
       A recipient whose identities have all been revoked, or who was created
       by a seed without one. The claim returns a null address rather than
       dropping the row, so that this is a decision made here and visible in
       `last_error`, rather than a message that quietly never existed. */
    if (!row.to_email) {
      out.skipped += 1;
      out.lines.push(`  skipped (no address) ${row.kind}`);
      if (!dryRun) await settle(db, row.id, row.claim_token, 'skipped', 'no address for this recipient');
      continue;
    }

    if (!KNOWN.includes(row.kind)) {
      out.skipped += 1;
      out.lines.push(`  skipped (no words) ${row.kind}`);
      if (!dryRun) await settle(db, row.id, row.claim_token, 'skipped', `no writer for ${row.kind}`);
      continue;
    }

    const written = write(row as Queued);
    if (!written) {
      out.skipped += 1;
      if (!dryRun) await settle(db, row.id, row.claim_token, 'skipped', `no writer for ${row.kind}`);
      continue;
    }

    const message: Message = {
      to: row.to_email,
      subject: written.subject,
      text: written.text,
    };

    if (dryRun) {
      out.lines.push(`  would send        ${row.kind} -> ${row.to_email}`);
      out.lines.push(`                    ${written.subject}`);
      out.sent += 1;
      continue;
    }

    try {
      await transport.send(message);

      /* Settled against the token this claim handed out. If the lease has
         expired and another drain has taken the row, this returns false —
         and that is worth saying out loud, because it means the message has
         probably gone twice and the window wants widening. */
      const held = await settle(db, row.id, row.claim_token, 'sent', null);
      if (!held) {
        out.lines.push(`  WARNING lease lost while sending ${row.kind} -> ${row.to_email}`);
      }

      out.sent += 1;
      out.lines.push(`  sent              ${row.kind} -> ${row.to_email}`);
    } catch (e: any) {
      const message = String(e?.message ?? e);

      /* Back to pending until the attempts run out, then left as failed.
         A message that has failed three times is not going to succeed on the
         fourth, and a queue that retries forever is a queue that hides a
         broken address behind a growing number. */
      const final = (row.attempts ?? 0) + 1 >= MAX_ATTEMPTS;
      await settle(db, row.id, row.claim_token, final ? 'failed' : 'pending', message);

      out.failed += 1;
      out.lines.push(`  failed            ${row.kind} -> ${row.to_email}: ${message}`);
    }
  }

  return out;
}

async function settle(
  db: Db,
  id: string,
  token: string,
  state: string,
  error: string | null
): Promise<boolean> {
  const { data, error: rpcError } = await db.rpc('settle_notification', {
    p_id: id,
    p_token: token,
    p_state: state,
    p_error: error,
  });

  /* Looked at. A settle that silently fails means the same message is
     claimed and sent again on the next pass, which is the one failure this
     whole design exists to prevent. */
  if (rpcError) throw new Error(`Could not settle ${id}: ${rpcError.message}`);

  /* False means the lease was lost — the row is somebody else's now. Not an
     error to raise on: the message went, and stopping the drain here would
     leave the rest of the batch held until their leases expire. */
  return data === true;
}
