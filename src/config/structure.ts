/**
 * THE STRUCTURAL RULES.
 *
 * Completeness checking, not quality judgment. It runs before submission so
 * that a reviewer's time goes to substance rather than to reporting a missing
 * methods section.
 *
 * ONE SOURCE, DELIBERATELY.
 *
 * The brief modelled these as a database table with a per-organization
 * override. That is not what shipped, and the reason is worth stating rather
 * than leaving as a silent deviation.
 *
 * A rule set in the database cannot be read by the public checklist page,
 * because a prerendered route may never touch the database. So the table
 * would have needed a twin in the repository, and the two would drift, which
 * is the failure `test:drift` exists to catch and cannot catch across
 * languages. The alternative is to notice what this check actually is: a
 * completeness gate, not a permission. A student who bypasses it submits an
 * incomplete paper, which the editor sees at screening. The gates that are
 * security boundaries, authorship acceptance and guardian consent, live in
 * the database where they belong.
 *
 * So the rules live here, once. The public checklist renders from this array,
 * which makes 9.2's promise literally true: if it is on that list, the system
 * checks it, because the list *is* the checks.
 *
 * Per-organization overrides are supported and currently empty.
 */

export type RecordKind = 'article' | 'project';

export type RuleKind =
  /** A field on the manuscript itself. */
  | 'meta'
  /** A prose section, checked for presence and length. */
  | 'section'
  /** Something no machine can judge. Flagged for the reviewer, never blocking. */
  | 'human';

export interface Rule {
  /** Stable. Findings quote it, so it must not be renamed casually. */
  id: string;
  kind: RuleKind;
  /** A manuscript field name, or a section key. */
  key: string;
  label: string;
  required: boolean;
  /** Sections only. */
  minWords?: number;
  /** Counted things: keywords, references, figures. */
  min?: number;
  max?: number;
  /** Words. Abstracts have ceilings at every fair worth entering. */
  maxWords?: number;
  /**
   * Only asked for when the writing lives here. A paper arriving as a
   * finished PDF carries its own references and its own account of who did
   * what, inside the file, and asking somebody to retype them into this
   * form to satisfy a checklist is the wall 8.6a exists to remove.
   */
  prose?: boolean;
  guidance: string;
  appliesTo: RecordKind[];
}

const BOTH: RecordKind[] = ['article', 'project'];
const ARTICLE: RecordKind[] = ['article'];

/**
 * Section order follows the judging conversation rather than the shape of a
 * journal article: what the question was and why it matters, what was already
 * known, what you did, what happened, what it means and where it falls down,
 * what you concluded, what comes next.
 *
 * Writing the paper in this order is rehearsal for being judged.
 */
export const defaultRules: Rule[] = [
  /* ── The record itself ────────────────────────────────────────────────── */
  {
    id: 'meta.title',
    kind: 'meta',
    key: 'title',
    label: 'Title',
    required: true,
    min: 8,
    guidance:
      'Sentence case. Say what the work is about rather than what makes it sound impressive.',
    appliesTo: BOTH,
  },
  {
    id: 'meta.authors',
    kind: 'meta',
    key: 'authors',
    label: 'Every author has accepted',
    required: true,
    min: 1,
    guidance:
      'Adding somebody is an invitation, not an assignment. Nobody is listed until they say yes.',
    appliesTo: BOTH,
  },
  {
    id: 'meta.abstract',
    kind: 'meta',
    key: 'abstract',
    label: 'Abstract',
    required: true,
    minWords: 100,
    maxWords: 350,
    guidance:
      'The question, what you did, what you found, and what it means. A reader should be able to stop here and know whether to keep going.',
    appliesTo: BOTH,
  },
  {
    id: 'meta.keywords',
    kind: 'meta',
    key: 'keywords',
    label: 'Keywords',
    required: true,
    min: 3,
    max: 6,
    guidance:
      'Three to six. The method is a keyword; the field is the discipline, which is a separate thing.',
    appliesTo: BOTH,
  },
  {
    id: 'meta.discipline',
    kind: 'meta',
    key: 'discipline',
    label: 'Discipline',
    required: true,
    guidance:
      'Classify by the domain of the question. Machine learning applied to protein folding is biology, and the method is a keyword.',
    appliesTo: BOTH,
  },
  {
    id: 'meta.contributions',
    kind: 'meta',
    key: 'contributions',
    label: 'Contributions statement',
    required: true,
    prose: true,
    minWords: 10,
    guidance:
      'What each author did, and what any mentor did. This is the written form of what judges are probing when they ask how much of this was yours, and it is what the existing archive most conspicuously lacks. How you write it is yours.',
    appliesTo: BOTH,
  },
  {
    id: 'meta.references',
    kind: 'meta',
    key: 'references',
    label: 'References',
    required: true,
    prose: true,
    min: 5,
    guidance:
      'At least five. Work with no prior art behind it is either a first in the field or a literature search that did not happen.',
    appliesTo: ARTICLE,
  },
  {
    id: 'meta.entries',
    kind: 'meta',
    key: 'entries',
    label: 'Competition record',
    required: true,
    min: 1,
    guidance:
      'A project entry records one fair: the program, the season, the category, and what happened.',
    appliesTo: ['project'],
  },

  /* ── The prose ────────────────────────────────────────────────────────── */
  {
    id: 'section.background',
    kind: 'section',
    key: 'background',
    label: 'Introduction and background',
    required: true,
    minWords: 150,
    guidance:
      'The problem, why it matters, and your hypothesis or design goal, stated plainly enough that somebody outside your field follows it.',
    appliesTo: ARTICLE,
  },
  {
    id: 'section.prior_work',
    kind: 'section',
    key: 'prior_work',
    label: 'Prior work',
    required: true,
    minWords: 100,
    guidance:
      'What is already known, and the specific gap you are working in. Not a list of everything you read.',
    appliesTo: ARTICLE,
  },
  {
    id: 'section.methods',
    kind: 'section',
    key: 'methods',
    label: 'Methods',
    required: true,
    minWords: 200,
    guidance:
      'Enough that somebody else could repeat it. This is the section reviewers most often send back, and the test is specific: could a stranger run your experiment from this text alone.',
    appliesTo: ARTICLE,
  },
  {
    id: 'section.results',
    kind: 'section',
    key: 'results',
    label: 'Results',
    required: true,
    minWords: 150,
    guidance:
      'What happened, with the data that supports it. What it means belongs in the next section.',
    appliesTo: ARTICLE,
  },
  {
    id: 'section.discussion',
    kind: 'section',
    key: 'discussion',
    label: 'Discussion and limitations',
    required: true,
    minWords: 150,
    guidance:
      'What the results mean, and where they fall down. Stating a limitation honestly is worth more than hiding it, and every judge knows it is there.',
    appliesTo: ARTICLE,
  },
  {
    id: 'section.conclusion',
    kind: 'section',
    key: 'conclusion',
    label: 'Conclusion',
    required: true,
    minWords: 75,
    guidance: 'What you now know that you did not before. Short is fine.',
    appliesTo: ARTICLE,
  },
  {
    id: 'section.future_work',
    kind: 'section',
    key: 'future_work',
    label: 'Future work',
    required: true,
    minWords: 50,
    guidance:
      'What you would do next with more time. Judges ask this out loud, so having written it down is rehearsal.',
    appliesTo: ARTICLE,
  },

  /* ── What no machine can judge ────────────────────────────────────────── */
  {
    id: 'human.axes',
    kind: 'human',
    key: 'axes',
    label: 'Every axis is labeled, with units',
    required: false,
    guidance: 'A plot with an unlabeled y-axis is the most common single defect at any fair.',
    appliesTo: BOTH,
  },
  {
    id: 'human.error',
    kind: 'human',
    key: 'error',
    label: 'Error is represented, and the text says what kind',
    required: false,
    guidance:
      'Standard deviation, standard error, and a confidence interval are three different claims and look identical on a chart.',
    appliesTo: BOTH,
  },
  {
    id: 'human.legible',
    kind: 'human',
    key: 'legible',
    label: 'Figures are readable from three feet away',
    required: false,
    guidance: 'Print one and stand back. This takes a minute and it is never wasted.',
    appliesTo: BOTH,
  },
  {
    id: 'human.safety',
    kind: 'human',
    key: 'safety',
    label: 'Display and safety rules are met',
    required: false,
    guidance:
      'Check against the current rules for the fair you are entering, not against last year.',
    appliesTo: BOTH,
  },
];

/** Per-organization overrides. Empty, and the shape exists so adding one is not a refactor. */
const overrides: Record<string, Rule[]> = {};

export function rulesFor(orgId?: string): Rule[] {
  return (orgId && overrides[orgId]) || defaultRules;
}

/** The prose sections, in order, for whichever kind of record this is. */
export function sectionsFor(kind: RecordKind, orgId?: string): Rule[] {
  return rulesFor(orgId).filter((r) => r.kind === 'section' && r.appliesTo.includes(kind));
}
