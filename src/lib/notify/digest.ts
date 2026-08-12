/**
 * A DIGEST, WHICH IS THE STATUS QUESTION ANSWERED BY MAIL.
 *
 * Composed here and nowhere else, from `projectStatus` — the same
 * computation the entry page and the overview render, so a student cannot be
 * told two different things about one project (20.1).
 *
 * **Pure.** It takes statuses and returns text, which is what lets the whole
 * thing be tested exactly: a seeded database and a fixed date produce a
 * specific message, written out and compared, rather than a check that a row
 * was enqueued.
 *
 * Plain text, no markup, no images, no tracking. That is partly cheapness
 * and mostly 20.8: **a notification is a pointer, never a copy.** Nothing
 * here carries a notebook, a manuscript, review comments or another
 * student's name, so a message read over a shoulder has said almost nothing.
 */

import type { Status, Item } from '../status.ts';
import { whenText } from '../status.ts';

export interface DigestInput {
  /** The person's own projects. */
  mine: Status[];
  /** Projects they look after, for an officer or an advisor. */
  watched: Status[];
  /** Absolute origin for this tenant, e.g. https://montavista.scipath.org */
  origin: string;
  /** The school, named in the subject so a shared inbox can tell. */
  schoolName: string;
  /**
   * Where a person changes how often this arrives.
   *
   * A path with `?at=`, never a fragment: everything in a message has to
   * survive the sign in it triggers, and a fragment does not reach a server
   * (20.10). The test caught this pointing at `#notifications`, in the one
   * file that exists to say links must not do that.
   */
  settingsPath?: string;
}

export interface Digest {
  subject: string;
  text: string;
}

/** Nothing to say. A message saying so teaches somebody to filter. */
export function isEmpty(input: DigestInput): boolean {
  const any = [...input.mine, ...input.watched];
  return any.every((s) => s.outstanding.length === 0);
}

/**
 * How often this should arrive, decided by what is in it rather than by a
 * setting nobody revisits (20.3).
 *
 * Anything late or inside its urgent window is worth hearing about today.
 * Everything else can wait for the weekly one.
 */
export function cadenceNeeded(input: DigestInput): 'daily' | 'weekly' | 'none' {
  const all = [...input.mine, ...input.watched].flatMap((s) => s.outstanding);
  if (all.length === 0) return 'none';
  if (all.some((i) => i.urgency === 'late' || i.urgency === 'urgent')) return 'daily';
  return 'weekly';
}

function line(item: Item, origin: string): string {
  const out: string[] = [];

  /* The interval wording is the escalation: the same row of state reads "in
     7 days", then "in 2 days", then "3 days late". Nothing was created and
     nothing cancelled, so it cannot contradict itself (20.6). */
  out.push(`  ${item.name}  —  ${whenText(item.days)}`);

  if (item.total > 1) {
    out.push(`    ${item.done} of ${item.total} recorded. Missing: ${item.missing.join(', ')}.`);
  } else if (item.missing.length > 0) {
    out.push(`    Missing: ${item.missing.join(', ')}.`);
  }

  /* Why being late costs something, where it does. A student who does not
     know which deadlines end a season treats all of them as advisory. */
  if (item.blocking && (item.urgency === 'urgent' || item.urgency === 'late')) {
    out.push('    Work done before this is approved cannot be entered.');
  }

  if (item.note) out.push(`    ${item.note}`);

  out.push(`    ${origin}${item.href}`);
  return out.join('\n');
}

function block(status: Status, origin: string): string | null {
  if (status.outstanding.length === 0) return null;

  const head = `${status.title}  ·  ${status.programName}`;
  const count =
    status.remaining === 0
      ? 'nothing outstanding'
      : `${status.remaining} of ${status.applicable} remaining`;

  return [`${head}\n${'-'.repeat(Math.min(head.length, 68))}\n(${count})`, '']
    .concat(status.outstanding.map((i) => line(i, origin)))
    .join('\n');
}

/**
 * The message.
 *
 * The subject names the school and what is in it, never the person: a
 * student's name in a subject line sits in a shared family inbox where
 * anybody can read it (20.8).
 */
export function renderDigest(input: DigestInput): Digest | null {
  if (isEmpty(input)) return null;

  const all = [...input.mine, ...input.watched].flatMap((s) => s.outstanding);
  const late = all.filter((i) => i.urgency === 'late').length;
  const urgent = all.filter((i) => i.urgency === 'urgent').length;

  const subject = late
    ? `${input.schoolName}: ${late} ${late === 1 ? 'thing is' : 'things are'} late`
    : urgent
      ? `${input.schoolName}: ${urgent} ${urgent === 1 ? 'thing needs' : 'things need'} you this week`
      : `${input.schoolName}: where your project stands`;

  const parts: string[] = [];

  const mine = input.mine.map((s) => block(s, input.origin)).filter(Boolean);
  if (mine.length > 0) parts.push(['YOURS', ''].concat(mine).join('\n'));

  /* Grouped by project, because somebody with nine of them reads nine short
     blocks rather than one long list. */
  const watched = input.watched.map((s) => block(s, input.origin)).filter(Boolean);
  if (watched.length > 0) parts.push(['LOOKED AFTER BY YOU', ''].concat(watched).join('\n'));

  if (input.settingsPath) {
    parts.push(`How often this arrives is yours to set:\n${input.origin}${input.settingsPath}`);
  }

  return { subject, text: parts.join('\n\n\n') };
}
