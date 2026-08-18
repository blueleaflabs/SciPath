/**
 * THE STRUCTURAL CHECK.
 *
 * A pure function. No database, no clock, no network: the rules, the
 * manuscript, and the path it arrived by all come in as arguments, and the
 * findings come out. Same shape as dateOrder.ts and for the same reason,
 * which is that a check nobody can run in isolation is a check nobody
 * trusts.
 *
 * It answers "is this complete", never "is this any good". Quality is what
 * the reviewers are for, and a machine pretending to judge it would produce
 * confident nonsense that a student would then try to satisfy.
 */

import type { Rule, RecordKind } from '../config/structure';

export type Severity =
  /** Stops a submission. Fixable by the author in the time it takes to read it. */
  | 'blocking'
  /** Worth fixing, does not stop anything. */
  | 'advisory'
  /** Nobody can check this automatically. It goes to the reviewer. */
  | 'human';

export interface Finding {
  ruleId: string;
  label: string;
  severity: Severity;
  message: string;
  /** Where to send somebody to fix it. */
  key: string;
}

export interface FigureSnapshot {
  number: number;
  caption: string;
  alt: string;
}

export interface ManuscriptSnapshot {
  recordKind: RecordKind;
  /** external and migrated make every automated finding advisory. See 8.6a. */
  source: 'workbench' | 'external' | 'migrated';
  bodyFormat: 'full-text' | 'pdf-only' | 'link-only' | 'none';

  title: string;
  abstract: string | null;
  keywords: string[];
  discipline: string | null;
  contributions: string | null;
  externalUrl: string | null;
  pdfPath: string | null;

  sections: { key: string; body: string }[];
  figures: FigureSnapshot[];
  references: string[];

  /** Every listed author, and whether they have accepted. */
  authors: { displayName: string; accepted: boolean }[];
  /** How many competition entries this project has. */
  entryCount: number;
}

/** Words, counted the way a person would count them. */
export function words(text: string | null | undefined): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Text a student left behind rather than wrote. Deliberately short: a list
 * long enough to catch real prose is a list that will accuse somebody of
 * writing "to be determined" about their actual results.
 */
const PLACEHOLDERS = [
  /\blorem ipsum\b/i,
  /\bTODO\b/,
  /\bTBD\b/,
  /\[insert[^\]]*\]/i,
  /\bxxx+\b/i,
  /\bfill (?:this )?in\b/i,
];

function hasPlaceholder(text: string): string | null {
  for (const pattern of PLACEHOLDERS) {
    const hit = text.match(pattern);
    if (hit) return hit[0];
  }
  return null;
}

/** "Figure 3", "Fig. 3", "fig 3", "(Figure 3)". */
function referencesFigure(body: string, number: number): boolean {
  return new RegExp(`\\bfig(?:ure|\\.)?\\s*${number}\\b`, 'i').test(body);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * What this manuscript is actually asked for, in one place.
 *
 * Three callers used to filter the rule list themselves and they drifted
 * apart the first time a rule gained a condition: the check skipped a
 * section, the counter still counted it, and the total said fourteen while
 * the list showed thirteen.
 */
export function applicableRules(rules: Rule[], m: ManuscriptSnapshot): Rule[] {
  const writesProse = m.bodyFormat === 'full-text';
  return rules.filter((r) => {
    if (!r.appliesTo.includes(m.recordKind)) return false;
    if (r.kind === 'human') return true;
    if (r.kind === 'section' && !writesProse) return false;
    if (r.prose && !writesProse) return false;
    return true;
  });
}

export interface CheckInput {
  rules: Rule[];
  manuscript: ManuscriptSnapshot;
}

/**
 * Returns one finding per problem, blocking first. An empty array means
 * nothing is wrong, which is a meaningful answer.
 */
export function checkStructure(input: CheckInput): Finding[] {
  const { rules, manuscript: m } = input;
  const findings: Finding[] = [];

  /* A manuscript that arrived finished from somewhere else is not going to
     be restructured to suit us, and telling its author to retype it into
     twelve boxes is the fastest way to lose the submission worth having.
     Every automated finding on that path is advice. */
  const advisoryOnly = m.source !== 'workbench';
  const gate: Severity = advisoryOnly ? 'advisory' : 'blocking';

  /* A PDF or a pointer elsewhere carries the prose. Checking sections that
     were never going to exist would produce seven findings and no insight. */
  const hasOwnProse = m.bodyFormat === 'full-text';

  const sectionBody = new Map(m.sections.map((s) => [s.key, s.body ?? '']));
  const applicable = applicableRules(rules, m);

  const add = (rule: Rule, severity: Severity, message: string) =>
    findings.push({ ruleId: rule.id, label: rule.label, severity, message, key: rule.key });

  for (const rule of applicable) {
    if (rule.kind === 'human') {
      add(rule, 'human', rule.guidance);
      continue;
    }

    if (rule.kind === 'section') {
      const body = sectionBody.get(rule.key) ?? '';
      const count = words(body);

      if (count === 0) {
        if (rule.required) add(rule, gate, `${rule.label} has not been written yet.`);
        continue;
      }

      if (rule.minWords && count < rule.minWords) {
        add(
          rule,
          gate,
          `${rule.label} is ${count} ${plural(count, 'word', 'words')}. It needs at least ${rule.minWords}.`
        );
      }

      const placeholder = hasPlaceholder(body);
      if (placeholder) {
        add(rule, gate, `${rule.label} still contains "${placeholder}".`);
      }
      continue;
    }

    /* Metadata. */
    switch (rule.key) {
      case 'title': {
        const value = m.title ?? '';
        if (value.trim() === '') {
          add(rule, gate, 'The manuscript has no title.');
        } else if (rule.min && value.trim().length < rule.min) {
          add(rule, gate, `The title is ${value.trim().length} characters. Say a little more.`);
        } else if (value === value.toUpperCase() && /[A-Z]{4,}/.test(value)) {
          add(rule, 'advisory', 'The title is in capitals. Sentence case reads better and indexes the same.');
        }
        break;
      }

      case 'authors': {
        if (m.authors.length === 0) {
          add(rule, gate, 'Nobody is listed as an author.');
          break;
        }
        const pending = m.authors.filter((a) => !a.accepted);
        if (pending.length > 0) {
          /* This one stays blocking on every path. Attributing work to
             somebody who has not agreed to it is not a formatting problem. */
          add(
            rule,
            'blocking',
            `${pending.map((a) => a.displayName).join(', ')} ${plural(pending.length, 'has', 'have')} not accepted authorship yet.`
          );
        }
        break;
      }

      case 'abstract': {
        const count = words(m.abstract);
        if (count === 0) {
          add(rule, gate, 'There is no abstract.');
          break;
        }
        if (rule.minWords && count < rule.minWords) {
          add(rule, gate, `The abstract is ${count} words. It needs at least ${rule.minWords}.`);
        }
        if (rule.maxWords && count > rule.maxWords) {
          add(
            rule,
            'advisory',
            `The abstract is ${count} words. Most fairs cap it near ${rule.maxWords}, so check the one you are entering.`
          );
        }
        const placeholder = hasPlaceholder(m.abstract ?? '');
        if (placeholder) add(rule, gate, `The abstract still contains "${placeholder}".`);
        break;
      }

      case 'keywords': {
        const n = m.keywords.filter((k) => k.trim() !== '').length;
        if (rule.min && n < rule.min) {
          add(rule, gate, `There ${plural(n, 'is', 'are')} ${n} ${plural(n, 'keyword', 'keywords')}. Give at least ${rule.min}.`);
        } else if (rule.max && n > rule.max) {
          add(rule, 'advisory', `There are ${n} keywords. More than ${rule.max} stops narrowing anything.`);
        }
        break;
      }

      case 'discipline': {
        if (!m.discipline || m.discipline.trim() === '') {
          add(rule, gate, 'No discipline has been chosen.');
        }
        break;
      }

      case 'contributions': {
        const count = words(m.contributions);
        if (count === 0) {
          add(rule, gate, 'The contributions statement is missing.');
          break;
        }
        if (rule.minWords && count < rule.minWords) {
          add(rule, gate, `The contributions statement is ${count} words. It needs at least ${rule.minWords}.`);
          break;
        }
        /* Worth saying, never worth blocking on.
           
           Naming everybody is good practice, and enforcing it means matching
           names against prose, which is guesswork: initials, nicknames,
           "both authors contributed equally", and a surname spelled two ways
           all read as an omission when nothing is missing. Blocking a
           submission on a guess about somebody's own sentence is the wrong
           trade. It stays a note. */
        const text = (m.contributions ?? '').toLowerCase();
        const missing = m.authors
          .filter((a) => {
            /* Strip the punctuation first, then drop what is left of an
               initial. "C. Duarte" reduced to ["c", "duarte"] would match
               any sentence containing the letter c, which is every
               sentence, and the check would silently never fire. */
            const parts = a.displayName
              .toLowerCase()
              .split(/\s+/)
              .map((part) => part.replace(/[^a-z\u00c0-\u024f]/g, ''))
              .filter((part) => part.length > 1);

            if (parts.length === 0) return false;
            return !parts.some((part) => text.includes(part));
          })
          .map((a) => a.displayName);

        if (missing.length > 0) {
          add(
            rule,
            'advisory',
            `The contributions statement may not name ${missing.join(', ')}. Worth a look, and it is your sentence to write.`
          );
        }
        break;
      }

      case 'references': {
        const n = m.references.filter((r) => r.trim() !== '').length;
        if (rule.min && n < rule.min) {
          add(rule, gate, `There ${plural(n, 'is', 'are')} ${n} ${plural(n, 'reference', 'references')}. At least ${rule.min} are expected.`);
        }
        break;
      }

      case 'entries': {
        if (rule.min && m.entryCount < rule.min) {
          add(rule, gate, 'A project entry records one fair, and none has been entered.');
        }
        break;
      }
    }
  }

  /* ── Figures. Cross-cutting, so outside the rule loop. ─────────────────── */

  for (const figure of m.figures) {
    /* The database rejects an empty caption or alt outright, so reaching
       this means somebody wrote a space. Say so anyway rather than trusting
       one layer. */
    if (!figure.caption || figure.caption.trim() === '') {
      add(
        { id: 'figure.caption', kind: 'meta', key: 'figures', label: 'Figure captions', required: true, guidance: '', appliesTo: ['article', 'project'] },
        gate,
        `Figure ${figure.number} has no caption.`
      );
    }
    if (!figure.alt || figure.alt.trim() === '') {
      add(
        { id: 'figure.alt', kind: 'meta', key: 'figures', label: 'Figure alt text', required: true, guidance: '', appliesTo: ['article', 'project'] },
        gate,
        `Figure ${figure.number} has no alt text.`
      );
    }
  }

  if (hasOwnProse && m.figures.length > 0) {
    const allProse = m.sections.map((s) => s.body ?? '').join('\n');
    const orphans = m.figures.filter((f) => !referencesFigure(allProse, f.number));

    if (orphans.length > 0) {
      add(
        { id: 'figure.referenced', kind: 'meta', key: 'figures', label: 'Figures referenced in the text', required: true, guidance: '', appliesTo: ['article'] },
        'advisory',
        `${orphans.map((f) => `Figure ${f.number}`).join(', ')} ${plural(orphans.length, 'is', 'are')} never mentioned in the text. A figure nobody points at is decoration.`
      );
    }
  }

  /* ── A record that points elsewhere needs somewhere to point. ──────────── */

  if (m.bodyFormat === 'link-only' && !m.externalUrl) {
    add(
      { id: 'meta.external_url', kind: 'meta', key: 'external_url', label: 'Authoritative version', required: true, guidance: '', appliesTo: ['article'] },
      'blocking',
      'This record points at a version held elsewhere, and no address has been given.'
    );
  }

  if (m.bodyFormat === 'pdf-only' && !m.pdfPath) {
    add(
      { id: 'meta.pdf', kind: 'meta', key: 'pdf', label: 'The PDF', required: true, guidance: '', appliesTo: ['article'] },
      'blocking',
      'This record is a PDF and no file has been uploaded.'
    );
  }

  const rank: Record<Severity, number> = { blocking: 0, advisory: 1, human: 2 };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}


export interface ChecklistItem {
  ruleId: string;
  label: string;
  /** done means nothing to report. Advisory is worth fixing and blocks nothing. */
  status: 'done' | 'blocking' | 'advisory';
  /** The finding where there is one, otherwise what the rule is asking for. */
  message: string;
  key: string;
}

/**
 * The whole list, not only the failures.
 *
 * A panel that shows nine problems and none of the work already done reads as
 * a wall rather than as progress, and it hides the one fact somebody wants
 * most, which is how close they are. Everything applicable appears, in rule
 * order, and a satisfied item says so.
 *
 * Findings that no rule produced, such as a figure nobody references, are
 * appended rather than dropped: they are real and they have to be visible.
 */
export function checklist(
  rules: Rule[],
  manuscript: ManuscriptSnapshot,
  findings: Finding[]
): ChecklistItem[] {
  const applicable = applicableRules(rules, manuscript).filter((r) => r.kind !== 'human');

  const byRule = new Map<string, Finding>();
  for (const f of findings) {
    if (f.severity === 'human') continue;
    /* Blocking wins where a rule produced both. */
    const held = byRule.get(f.ruleId);
    if (!held || (held.severity === 'advisory' && f.severity === 'blocking')) {
      byRule.set(f.ruleId, f);
    }
  }

  const items: ChecklistItem[] = applicable.map((rule) => {
    const finding = byRule.get(rule.id);
    return {
      ruleId: rule.id,
      label: rule.label,
      status: finding ? finding.severity : 'done',
      message: finding ? finding.message : rule.guidance,
      key: rule.key,
    };
  });

  const known = new Set(applicable.map((r) => r.id));
  for (const f of findings) {
    if (f.severity === 'human' || known.has(f.ruleId)) continue;
    items.push({
      ruleId: f.ruleId,
      label: f.label,
      status: f.severity,
      message: f.message,
      key: f.key,
    });
  }

  return items;
}

/** True when nothing stops a submission. Advisory findings and human checks do not. */
export function maySubmit(findings: Finding[]): boolean {
  return !findings.some((f) => f.severity === 'blocking');
}

/**
 * "4 of 9". Counts required, machine-checkable things that are done, so the
 * template reads as a checklist without adding a component.
 */
export function completeness(
  rules: Rule[],
  manuscript: ManuscriptSnapshot,
  findings: Finding[]
): { done: number; total: number } {
  const counted = applicableRules(rules, manuscript).filter(
    (r) => r.required && r.kind !== 'human'
  );

  const failed = new Set(findings.filter((f) => f.severity !== 'human').map((f) => f.ruleId));

  return {
    done: counted.filter((r) => !failed.has(r.id)).length,
    total: counted.length,
  };
}
