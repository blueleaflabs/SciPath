/**
 * THE STATE MACHINE.
 *
 * A pure function over a table. No database, no clock, no session: the state,
 * the actor, and the facts come in, and what is allowed comes out.
 *
 * The same transitions are enforced in SQL, because the interface is not a
 * security boundary and somebody calling the RPC directly has to hit the same
 * wall. This half exists so a screen can ask "what can this person do next"
 * without a round trip, and so the answer can be tested without a queue full
 * of fixtures.
 *
 * There is exactly one table below, and every screen reads from it. A state
 * machine restated per page is a state machine with two answers.
 */

export type State =
  | 'draft'
  | 'submitted'
  | 'screening'
  | 'in_review'
  | 'revisions_requested'
  | 'editorial_review'
  | 'accepted'
  | 'scheduled'
  | 'exported'
  | 'published'
  | 'declined'
  | 'withdrawn';

export type Actor = 'author' | 'editor';

export interface Action {
  /** Matches the RPC name, so a screen cannot invent one. */
  id: string;
  label: string;
  by: Actor;
  from: State[];
  to: State | null;
  /** Shown to the person before they press it. */
  hint?: string;
  /** Loud, because it ends something. */
  grave?: boolean;
}

/** What an author sees on the tracker. Never the raw state. */
export const publicLabel: Record<State, string> = {
  draft: 'Not submitted',
  submitted: 'Received',
  screening: 'With the editor',
  in_review: 'With reviewers',
  revisions_requested: 'Back with the authors',
  editorial_review: 'With the editor for a decision',
  accepted: 'Accepted for publication',
  scheduled: 'In the publishing queue',
  exported: 'Being published',
  published: 'Published',
  declined: 'Not accepted',
  withdrawn: 'Withdrawn',
};

/** What the queue calls it. Shorter, and for people who know the process. */
export const editorLabel: Record<State, string> = {
  draft: 'Draft',
  submitted: 'New',
  screening: 'Screening',
  in_review: 'In review',
  revisions_requested: 'With authors',
  editorial_review: 'Decision',
  accepted: 'Accepted for publication',
  scheduled: 'Queued',
  exported: 'Exported',
  published: 'Published',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

/**
 * What the authors are told, per state.
 *
 * This was three branches on the page: withdrawal asked for, back with you,
 * and everything else. Everything else said "Under editorial review", so an
 * accepted submission sat under a heading saying Accepted and a sentence
 * saying it was still being reviewed. A sentence per state, in the same file
 * as the labels, and a test that none is missing.
 */
export const authorGuidance: Record<State, string> = {
  draft: 'Not submitted yet.',
  submitted: 'Received. An editor will pick it up.',
  screening: 'An editor is reading it before it goes to reviewers.',
  in_review: 'With reviewers. Withdraw the existing submission if you need to make changes.',
  revisions_requested: 'Back with you. Make the changes below, then send it back.',
  editorial_review: 'With the editor for a decision.',
  accepted: 'Accepted for publication. It goes live once an officer prepares the record.',
  scheduled: 'Accepted and queued for publishing.',
  exported: 'Being published now.',
  published: 'Published. Corrections and retractions are handled separately.',
  declined: 'Not accepted.',
  withdrawn: 'Withdrawn.',
};

export const TERMINAL: State[] = ['published', 'declined', 'withdrawn'];

/** The order the queue is worked in, which is not alphabetical and not the enum order. */
export const QUEUE_ORDER: State[] = [
  'submitted',
  'screening',
  'in_review',
  'editorial_review',
  'revisions_requested',
  'accepted',
  'scheduled',
];

export const ACTIONS: Action[] = [
  {
    id: 'claim_submission',
    label: 'Take this one',
    by: 'editor',
    from: ['submitted'],
    to: 'screening',
    hint: 'You become the editor of record for it. An unclaimed queue is nobody\u2019s job.',
  },
  {
    id: 'screen_advance',
    label: 'Send to review',
    by: 'editor',
    from: ['screening'],
    to: 'in_review',
  },
  /* There was a second way to send a submission back from screening, before
     `request_revisions` was widened to work here too. Two buttons that did
     the same thing, one of which could also carry the list. Removed rather
     than renamed: the difference nobody could explain was that there was
     none. */
  {
    id: 'screen_decline',
    label: 'Decline at screening',
    by: 'editor',
    from: ['screening'],
    to: 'declined',
    grave: true,
  },
  {
    id: 'assign_reviewer',
    label: 'Assign a reviewer',
    by: 'editor',
    from: ['screening', 'in_review'],
    to: null,
    hint: 'Officers, editors, and the advisor. Assign any number of them.',
  },
  {
    id: 'request_revisions',
    label: 'Send it back to the authors',
    by: 'editor',
    /* Wherever the editor is holding it. There is no state where they can
       see a submission, want to send a one line correction, and have no way
       to do it. */
    from: ['screening', 'in_review', 'editorial_review'],
    to: 'revisions_requested',
    hint: 'The list, a note, or both. One of the two has to reach them.',
  },
  {
    id: 'to_editorial_review',
    label: 'Ready to decide',
    by: 'editor',
    from: ['in_review'],
    to: 'editorial_review',
    hint: 'Move when there is enough to act on. A reviewer who returns later is still recorded.',
  },
  {
    id: 'decide_accepted',
    label: 'Accept',
    by: 'editor',
    from: ['editorial_review'],
    to: 'accepted',
  },
  {
    id: 'decide_declined',
    label: 'Decline',
    by: 'editor',
    from: ['editorial_review'],
    to: 'declined',
    grave: true,
  },
  {
    id: 'confirm_withdrawal',
    label: 'Confirm the withdrawal',
    by: 'editor',
    from: [
      'submitted',
      'screening',
      'in_review',
      'revisions_requested',
      'editorial_review',
      'accepted',
      'scheduled',
    ],
    to: 'withdrawn',
    grave: true,
  },
  {
    id: 'resubmit',
    label: 'Send it back',
    by: 'author',
    from: ['revisions_requested'],
    to: null,
    hint: 'Every required change needs an answer first.',
  },
  {
    id: 'withdraw_submission',
    label: 'Withdraw',
    by: 'author',
    from: ['draft', 'submitted', 'screening'],
    to: 'withdrawn',
    grave: true,
  },
  {
    id: 'request_withdrawal',
    label: 'Ask to withdraw',
    by: 'author',
    from: ['in_review', 'revisions_requested', 'editorial_review', 'accepted', 'scheduled'],
    to: null,
    hint: 'An editor confirms it. Reviewers have already spent time on this.',
  },
];

/**
 * What just happened, in the past tense.
 *
 * "Done." tells somebody the click registered and nothing else. On a queue
 * where six actions look alike and three of them are irreversible, the useful
 * confirmation is what was done, when, and where the submission is now.
 *
 * Keyed by action id so a new action cannot ship without one, which the tests
 * enforce.
 */
export const actionDone: Record<string, string> = {
  claim_submission: 'Taken off the queue',
  screen_advance: 'Sent to review',
  screen_decline: 'Declined at screening',
  assign_reviewer: 'Reviewer assigned',
  request_revisions: 'Sent back to the authors',
  to_editorial_review: 'Moved to a decision',
  decide_accepted: 'Accepted for publication',
  decide_declined: 'Declined',
  confirm_withdrawal: 'Withdrawal confirmed',
  resubmit: 'Sent back to the editor',
  withdraw_submission: 'Withdrawn',
  request_withdrawal: 'Withdrawal requested',
};

/** Things that are not state transitions but still deserve a real answer. */
export const otherDone: Record<string, string> = {
  add_finding: 'Added to the list',
  respond: 'Answer saved',
  submit: 'Submitted for editorial review',
  submit_review: 'Review sent to the editor',
  meta: 'Record saved',
  section: 'Section saved',
  references: 'References saved',
  figure: 'Figure added',
  'figure-remove': 'Figure removed, and the rest renumbered',
  paper: 'Paper uploaded',
  start: 'Manuscript started',
  glance: 'Research at a glance saved',
  question: 'The question saved',
};

export function doneLabel(actionId: string): string {
  return actionDone[actionId] ?? otherDone[actionId] ?? 'Saved';
}

export interface Facts {
  /** Has the withdrawal already been asked for. */
  withdrawalRequested?: boolean;
  /** How many findings are on the current round\u2019s list. */
  findingCount?: number;
  /** Which round this is. Capped at two. */
  round?: number;
}

/**
 * What this person can do from here. Order is the order of ACTIONS, which is
 * roughly the order somebody works through them.
 */
export function actionsFor(state: State, actor: Actor, facts: Facts = {}): Action[] {
  return ACTIONS.filter((action) => {
    if (action.by !== actor) return false;
    if (!action.from.includes(state)) return false;

    /* Asking twice helps nobody, and neither does an editor confirming a
       withdrawal nobody asked for. */
    if (action.id === 'request_withdrawal' && facts.withdrawalRequested) return false;
    if (action.id === 'withdraw_submission' && facts.withdrawalRequested) return false;
    if (action.id === 'confirm_withdrawal' && !facts.withdrawalRequested) return false;

    return true;
  });
}

export function can(state: State, actionId: string, actor: Actor, facts: Facts = {}): boolean {
  return actionsFor(state, actor, facts).some((a) => a.id === actionId);
}

/**
 * May the authors still change the manuscript.
 *
 * Yes before it is submitted, and yes again the moment it comes back to them:
 * a submission returned for changes that cannot be changed is a dead end
 * dressed as a task. No while it is with the editors or the reviewers, so the
 * thing being read does not move underneath the person reading it, and no
 * once it is decided.
 */
export function authorMayEdit(state?: State | null): boolean {
  return !state || state === 'revisions_requested' || state === 'draft';
}

/** True where the submission is finished with, whichever way it went. */
export function isTerminal(state: State): boolean {
  return TERMINAL.includes(state);
}

/**
 * Rounds are counted, not budgeted.
 *
 * An earlier version capped this at two and forced a decision on the third,
 * to stop submissions living in the queue forever. That was the wrong lever:
 * a graveyard is made of submissions nobody is working on, and a short
 * correction sent back and returned the same day is the loop working as
 * intended. What actually prevents a graveyard is the editor being able to
 * decide from any point, which they can.
 */
export const UNLIMITED_ROUNDS = true;

/**
 * The reviewer form. Kept here rather than in the page so the questions, the
 * stored keys, and anything that later reads them cannot drift apart.
 *
 * The scales inform the reviewer's thinking. They are never averaged into a
 * score, because a number gets argued with and the prose stops being read.
 */
export interface ReviewQuestion {
  key: string;
  prompt: string;
}

export const REVIEW_QUESTIONS: ReviewQuestion[] = [
  { key: 'question', prompt: 'Is the research question clearly stated?' },
  { key: 'methods', prompt: 'Could somebody else repeat the methods from what is written?' },
  { key: 'conclusions', prompt: 'Do the conclusions follow from the data presented?' },
  { key: 'limitations', prompt: 'Are limitations stated honestly?' },
  { key: 'figures', prompt: 'Are figures and tables legible, labeled, and referenced?' },
  { key: 'contributions', prompt: 'Does the contributions statement match what the paper describes?' },
];

export const SCALE = [
  { value: 'yes', label: 'Yes' },
  { value: 'partly', label: 'Partly' },
  { value: 'no', label: 'No' },
  { value: 'unsure', label: 'Cannot tell' },
];

export const RECOMMENDATIONS = [
  { value: 'accept', label: 'Accept as it is' },
  { value: 'minor', label: 'Minor revisions' },
  { value: 'major', label: 'Major revisions' },
  { value: 'decline', label: 'Decline' },
];

export const recommendationLabel: Record<string, string> = Object.fromEntries(
  RECOMMENDATIONS.map((r) => [r.value, r.label])
);
