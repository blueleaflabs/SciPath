/**
 * THE ORGANIZATION RECORD, AND HOW A FILE BECOMES ONE.
 *
 * No I/O and no `import.meta`, deliberately, because two runtimes read these
 * files: the application, which bundles them with `import.meta.glob`, and the
 * seed scripts, which read the directory off the disk. Both hand the parsed
 * document to `shapeOrg` here, so there is one translation rather than two
 * that have to agree.
 *
 * This is the same split as the template library — `template-resolve.ts` holds
 * the logic and has no I/O, `templates.ts` does the glob, and
 * `scripts/template-library.mjs` does the filesystem read — and it exists for
 * the reason recorded in 19.9: `import.meta.glob` is a Vite transform, so a
 * script importing a module that calls it dies with `glob is not a function`
 * after everything before it has already written.
 */

import type { ThemeId } from './fonts';

export interface Org {
  /** Stable identifier. Becomes the organizations.slug. Never reused. */
  id: string;
  /**
   * The subdomain that resolves this tenant, where it differs from the slug.
   *
   * A label rather than a hostname, so one build serves every environment:
   * `montavista` is `montavista.localhost:4321` while developing and
   * `montavista.scipath.org` in production, and neither is written down.
   * Tenancy is never resolved from an email domain — two schools in one
   * district share the same domains.
   */
  subdomain?: string;
  /**
   * domain : only an address on a listed domain may sign up
   * open   : anyone may sign up. No domain, no district, no club mentor
   * invite : signup requires a pending grant
   */
  signupMode?: 'domain' | 'open' | 'invite';
  /** False for an open program with no school behind it. */
  requiresMentor?: boolean;
  /** Full name, rendered in the lockup. */
  name: string;
  /**
   * Two to six characters for the lockup badge.
   *
   * The ceiling is `organizations.mark`'s check constraint, and
   * `tests/orgs.mjs` reads it off the migration and refuses a file that would
   * not fit. It is not restated as a number here, because a limit written in
   * two places is a limit that drifts.
   */
  mark: string;
  /** Which shipped theme this organization renders in. */
  theme: ThemeId;
  /**
   * True only for the instance the platform runs for itself. Suppresses the
   * "on SciPath" line, because naming the platform under the platform reads
   * as a mistake.
   */
  isPlatform?: boolean;
  /** Prefix for permanent record identifiers, e.g. SP-2026-0001. */
  recordPrefix: string;
  /**
   * Where the school is, as an IANA zone.
   *
   * Cron runs in UTC and nothing else in the system has needed a zone,
   * because a due date is a date rather than a moment. A digest meant to
   * arrive before school is the first thing that does: without this, seven
   * in the morning is eleven the previous night somewhere (20.10).
   */
  timezone: string;

  /**
   * The programs this organization runs, by template id.
   *
   * Here rather than in the seed script, which held its own copy: the public
   * calendar is prerendered and cannot ask a database, and two lists of the
   * same fact drift the moment somebody adds a program to one of them.
   */
  programs: string[];
  /** Where a reader writes to. Never an individual student address. */
  contactEmail: string;
  /** Domains whose sign-in confirms affiliation without a club mentor. */
  verifiedDomains: string[];
  /** Whether publication passes through editorial review before going live. */
  editorialReview: boolean;
  /** One sentence describing what this organization publishes. */
  showcaseNote: string;
  /**
   * True for an organization whose people are invented.
   *
   * There is one, and it is the tenant demonstrations are given from. Its
   * accounts are fixtures, its credentials are published, and nothing in it
   * is real — which is what makes it the only school `seed-demo` will write
   * into on a host that is not loopback.
   *
   * **The permission is a fact about the school, so it is stored with the
   * school.** A list of permitted slugs inside the seed script is a list
   * somebody edits while pointed at production; a school that says of itself
   * that it holds nothing real is checked against whatever the environment
   * happens to say on the day.
   */
  demo?: boolean;
  /**
   * False for a record that gets pages but no database row.
   *
   * `example` is one: it exists so the alternate theme is contrast-checked in
   * CI, holds no students, and nothing is ever scoped to it. `seed-orgs`
   * reads this off the document and skips it; anything else deciding whether
   * a school can be signed in to has to ask the same question, which is why
   * it belongs on the record rather than being reparsed.
   */
  provisioned?: boolean;
}

/**
 * A parsed `orgs/*.yaml` document, as the record every page expects.
 *
 * YAML is snake_case, which is what the file reads like and what the database
 * columns are called; the record is camelCase, which is what every page that
 * already reads it expects. The translation is here, once, rather than at
 * every call site — and once across both runtimes rather than once each.
 */
export function shapeOrg(doc: any): Org {
  return {
    id: doc.id,
    subdomain: doc.subdomain,
    signupMode: doc.signup_mode,
    requiresMentor: doc.requires_mentor,
    name: doc.name,
    mark: doc.mark,
    theme: doc.theme,
    isPlatform: doc.is_platform,
    recordPrefix: doc.record_prefix,
    timezone: doc.timezone,
    programs: doc.programs ?? [],
    contactEmail: doc.contact_email,
    verifiedDomains: doc.verified_domains ?? [],
    editorialReview: Boolean(doc.editorial_review),
    showcaseNote: doc.showcase_note,
    demo: Boolean(doc.demo),
    /* Defaulted true, because every file but one omits it and a record that
       said `undefined` would put the burden of remembering the default on
       every caller. */
    provisioned: doc.provisioned !== false,
  };
}
