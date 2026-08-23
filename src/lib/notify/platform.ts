/**
 * WHAT EACH KIND OF NOTIFICATION SAYS.
 *
 * The schema has named this file since the outbox was written — *a platform
 * kind from `src/lib/notify/platform.ts`, or 'digest'* — and it did not
 * exist. Nine kinds enqueued and nothing turned any of them into a sentence,
 * which is why nothing has ever been sent.
 *
 * **The row carries the few values the sentence needs and nothing else.** No
 * notebook, no manuscript, no review comments (20.8). So a message is built
 * from a title, a name and a date, and where the detail matters the message
 * says where to go and read it. That is a deliberate limit rather than a
 * missing feature: an outbox row is stored, retried, and lives in a log, and
 * private work should not be in any of those.
 *
 * One place per kind, and a kind with no entry here is not sent. A missing
 * case is a message nobody wrote, which is better than a subject line reading
 * `place_declined` arriving at a student.
 */

export interface Queued {
  kind: string;
  payload: Record<string, any>;
  /** Where to read the thing this is about, already absolute. */
  url: string;
  /** Who it is for, so the greeting is theirs. */
  to_name: string;
  /** Their school, because a student may hold accounts at more than one. */
  org_name: string;
}

export interface Written {
  subject: string;
  text: string;
}

/**
 * A closing line that is the same everywhere.
 *
 * Every message names where it came from and offers the way to stop it. Not
 * decoration: an unexpected email with no visible origin and no way out is
 * indistinguishable from a phishing attempt, and these arrive at parents.
 */
function footer(m: Queued): string {
  return (
    `\n\n${m.url}\n\n` +
    `Sent by ${m.org_name} through SciPath. ` +
    `You can change what reaches you in your profile.`
  );
}

const KINDS: Record<string, (m: Queued) => Written> = {
  /* ── A place in a program ─────────────────────────────────────────────── */

  place_granted: (m) => ({
    subject: `Your place in ${m.payload.program_name ?? 'the program'} is confirmed`,
    text:
      `${m.to_name},\n\n` +
      `Your project has a place in ${m.payload.program_name ?? 'the program'}.` +
      (m.payload.note ? `\n\nFrom the teacher: ${m.payload.note}` : '') +
      `\n\nIts deadlines are on the project page now.` +
      footer(m),
  }),

  place_declined: (m) => ({
    /* Not "rejected". The answer is no and the sentence should be plain, but
       a subject line a student reads on a phone in a corridor does not need
       to be a verdict on them. */
    subject: `About your entry to ${m.payload.program_name ?? 'the program'}`,
    text:
      `${m.to_name},\n\n` +
      `Your entry was not accepted this time.` +
      (m.payload.note ? `\n\nThe reason given: ${m.payload.note}` : '') +
      `\n\nThe work itself is untouched, and you can enter it elsewhere.` +
      footer(m),
  }),

  /* ── A class or a club ───────────────────────────────────────────────── */

  membership_granted: (m) => ({
    subject: `You are in ${m.payload.cohort_name ?? 'the program'}`,
    text:
      `${m.to_name},\n\n` +
      `You have been accepted into ${m.payload.cohort_name ?? 'the program'}.` +
      (m.payload.note ? `\n\nFrom the teacher: ${m.payload.note}` : '') +
      `\n\nIts dates are yours from today, and a date moved later will not ` +
      `change what you were told.` +
      footer(m),
  }),

  membership_declined: (m) => ({
    subject: `About joining ${m.payload.cohort_name ?? 'the program'}`,
    text:
      `${m.to_name},\n\n` +
      `Your request to join was not accepted.` +
      (m.payload.note ? `\n\nThe reason given: ${m.payload.note}` : '') +
      footer(m),
  }),

  /* ── Editorial ───────────────────────────────────────────────────────── */

  reviewer_assigned: (m) => ({
    subject: `A manuscript is waiting for your review`,
    text:
      `${m.to_name},\n\n` +
      `You have been asked to review a submission` +
      (m.payload.due_on ? `, by ${m.payload.due_on}` : '') +
      `.\n\nThe manuscript is not attached. Read it on the site, where the ` +
      `authors' names are hidden from you and yours from them.` +
      footer(m),
  }),

  review_returned: (m) => ({
    subject: `A review has come back on your submission`,
    text:
      `${m.to_name},\n\n` +
      `A reviewer has returned comments.\n\n` +
      `The comments are not in this email — they are on the submission, ` +
      `where they can be answered point by point.` +
      footer(m),
  }),

  revisions_requested: (m) => ({
    subject: `Revisions requested on your submission`,
    text:
      `${m.to_name},\n\n` +
      `The editor has asked for revisions before a decision.` +
      (m.payload.due_on ? `\n\nThey are due by ${m.payload.due_on}.` : '') +
      footer(m),
  }),

  decision_made: (m) => ({
    subject: `A decision on your submission`,
    text:
      `${m.to_name},\n\n` +
      `The editor has decided on your submission.` +
      `\n\nThe decision and the reasons are on the submission page.` +
      footer(m),
  }),

  record_published: (m) => ({
    subject: `Your work is published`,
    text:
      `${m.to_name},\n\n` +
      `${m.payload.title ? `"${m.payload.title}"` : 'Your record'} is public, ` +
      `at an address that will not change.` +
      `\n\nIt is yours to link from anywhere.` +
      footer(m),
  }),

  /* ── Guardians ───────────────────────────────────────────────────────── */

  /**
   * The one message that goes to somebody who has no account.
   *
   * A parent who has never heard of this receives it, so it says who is
   * writing, why, what happens if they ignore it, and what the link does —
   * before it asks for anything.
   */
  guardian_consent: (m) => ({
    subject: `${m.payload.student_name ?? 'A student'} needs your permission for a research account`,
    text:
      `Hello,\n\n` +
      `${m.payload.student_name ?? 'A student'} gave this address as their ` +
      `parent or guardian when creating an account at ${m.org_name}, on ` +
      `SciPath — a tool for keeping a research notebook and tracking science ` +
      `fair deadlines.\n\n` +
      `They can work privately in the meantime. They cannot publish anything ` +
      `publicly until you confirm, and if nobody confirms, the account is ` +
      `paused and then deleted.\n\n` +
      `To confirm, follow this link:\n${m.url}\n\n` +
      `If you were not expecting this, you can ignore it and nothing will be ` +
      `published. Sent by ${m.org_name} through SciPath.`,
  }),

  /* ── Leaving ─────────────────────────────────────────────────────────── */

  /**
   * Somebody is asking to take shared work with them.
   *
   * The stake is stated in the first line, because a "please approve"
   * message skimmed and clicked is exactly the failure this ask exists to
   * prevent.
   */
  deletion_approval: (m) => ({
    subject: `${m.payload.who ?? 'Somebody'} is asking to delete ${m.payload.what ?? 'shared work'}`,
    text:
      `${m.to_name},\n\n` +
      `${m.payload.who ?? 'Somebody'} is deleting their SciPath account and ` +
      `has asked to take ${m.payload.what ?? 'work you share with them'} ` +
      `with them.\n\n` +
      `If you agree, it is deleted permanently and cannot be recovered. ` +
      `If you do not, they still leave — their name comes off it and the ` +
      `work stays with you.\n\n` +
      `Nothing happens until you answer.` +
      footer(m),
  }),
};

/**
 * Write one queued notification, or return null.
 *
 * Null for a kind with no entry, and the caller marks the row `skipped`
 * rather than failing: an unwritten kind is a gap in this file, not a fault
 * in the queue, and it should not stop the messages behind it.
 */
export function write(m: Queued): Written | null {
  const writer = KINDS[m.kind];
  return writer ? writer(m) : null;
}

/** The kinds this file can actually send. Read by the drain and by tests. */
export const KNOWN = Object.keys(KINDS);
