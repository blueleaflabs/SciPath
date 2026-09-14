/**
 * THE SURVEY'S QUESTIONS AND ITS CADENCE (dev-156).
 *
 * A short bank, in code, so a question can be reworded or retired with a
 * deploy and no migration; and the numbers that keep it rare. The rules
 * that read these are in src/lib/survey.ts and are tested there.
 *
 * Why rare. A card that comes up every time somebody submits is part of
 * the submit workflow within a week, and the answers say so. The practice
 * the survey tools converge on is the opposite: tie a question to a moment,
 * ask any one person seldom, show it on a fraction of the moments that
 * qualify, and treat a dismissal as an answer to the question *should I
 * ask you now* — which it is.
 *
 * Why these questions. Each one measures a mechanism the pilot claims:
 * that writing here is easier than writing in Drive alone; that a person
 * knows what to do next (the reason deadlines stop being missed); that an
 * Elder can review in one sitting; and, later, whether the class would
 * keep it. One open line, once, for what the numbers miss.
 */

export type Moment = 'after_submit' | 'after_feedback' | 'workbench';
export type Audience = 'student' | 'elder' | 'teacher';

export interface SurveyAnswer { value: 1 | 2 | 3; label: string }

export interface SurveyQuestion {
  /** Stable id; the database keeps it, so never reuse one for a new text. */
  id: string;
  text: string;
  /** Three buttons, one line of text, or one number. */
  kind: 'scale' | 'line' | 'number';
  /** For a number: what it counts. */
  unit?: string;
  /**
   * Weekly (dev-157): asked once a week, from Friday, until answered or
   * put off for the week; outside the warm-up, the cap, the cooldown and
   * the sampling, which are for the students' and Elders' questions. The
   * teacher's Friday minute count is the one so far.
   */
  cadence?: 'weekly';
  answers?: SurveyAnswer[];
  moment: Moment;
  audience: Audience;
  /** Not before this many days into the person's account. */
  notBeforeDay?: number;
}

export const YES_MOSTLY_NO: SurveyAnswer[] = [
  { value: 3, label: 'Yes' },
  { value: 2, label: 'Mostly' },
  { value: 1, label: 'No' },
];

export const BETTER_SAME_WORSE: SurveyAnswer[] = [
  { value: 3, label: 'Better' },
  { value: 2, label: 'About the same' },
  { value: 1, label: 'Worse' },
];

export const KEEP_MAYBE_NO: SurveyAnswer[] = [
  { value: 3, label: 'Yes' },
  { value: 2, label: 'Maybe' },
  { value: 1, label: 'No' },
];

/** In order of preference: the first eligible question is the one asked. */
export const QUESTIONS: SurveyQuestion[] = [
  { id: 'submit_easier', text: 'Did SciPath make this submission easier than doing it in Drive alone?', kind: 'scale', answers: YES_MOSTLY_NO, moment: 'after_submit', audience: 'student' },
  { id: 'review_easy', text: 'Was this easy to review here?', kind: 'scale', answers: YES_MOSTLY_NO, moment: 'after_feedback', audience: 'elder' },
  { id: 'know_next', text: 'Do you know what you should be working on next?', kind: 'scale', answers: YES_MOSTLY_NO, moment: 'workbench', audience: 'student' },
  { id: 'waiting_clear', text: 'Is it clear what is waiting on you?', kind: 'scale', answers: YES_MOSTLY_NO, moment: 'workbench', audience: 'elder' },
  { id: 'vs_without', text: 'Compared with how you would do this without SciPath, is your research going better, the same, or worse?', kind: 'scale', answers: BETTER_SAME_WORSE, moment: 'workbench', audience: 'student', notBeforeDay: 14 },
  { id: 'one_change', text: 'What is the one thing you would change?', kind: 'line', moment: 'workbench', audience: 'student', notBeforeDay: 21 },
  { id: 'keep_using', text: 'If SciPath were optional, would you keep using it next semester?', kind: 'scale', answers: KEEP_MAYBE_NO, moment: 'workbench', audience: 'student', notBeforeDay: 28 },
  { id: 'teacher_minutes', text: 'About how many minutes did SciPath save you this week, compared with running this class without it? A rough number is fine, and zero counts too.', kind: 'number', unit: 'minutes', moment: 'workbench', audience: 'teacher', cadence: 'weekly' },
];

/** The weekly question is asked from this weekday (1 Monday … 7 Sunday) to the week's end. */
export const WEEKLY_FROM_WEEKDAY = 5;
export const NUMBER_MAX = 9999;

export const CADENCE = {
  /** No question until the account is this old, and never before a first save. */
  warmupDays: 3,
  /** Days between any two questions to one person; a dismissal counts. */
  cooldownDays: 7,
  /** Questions shown to one person, ever, across the bank. */
  capPerPerson: 6,
  /** On the Workbench, one eligible page load in this many shows a card. */
  workbenchOneIn: 4,
  /** A question dismissed this many times is never asked of that person again. */
  retireAfterDismissals: 2,
  /** This many dismissals in a row, of anything, double the cooldown. */
  backOffAfterDismissals: 3,
};

export const COMMENT_MAX = 240;

export function questionById(id: string): SurveyQuestion | null {
  return QUESTIONS.find((q) => q.id === id) ?? null;
}
