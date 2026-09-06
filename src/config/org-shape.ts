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
  /**
   * Stable identifier, and the same string as `organizations.slug`.
   *
   * **Named `slug` rather than `id`, because it was `id` and that cost an
   * archive.** A seed reading its organization out of the database also has
   * an `org.id`, and that one is the uuid primary key. Both were spelled
   * `org.id`, so `seed-publish` and `seed-journal` wrote every record under
   * `records/<uuid>/` while every page read `records/<slug>/`, and the
   * showcase said *Nothing published yet* about a full archive. Nothing threw
   * and nothing was logged, because an absent manifest is answered with an
   * empty one so a corrupt file cannot take the archive down.
   *
   * The two values are spelled differently everywhere now, which is the fix.
   * `prefixFor` still refuses a uuid, and that is not the same rule twice:
   * the seeds are plain `.mjs` and no type reaches them.
   */
  slug: string;
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
  /** Full name, on every page title and record. */
  name: string;
  /**
   * The name the lockup shows, where the full one is too long for a bar
   * that also holds the nav and the account: "Monta Vista" for "Monta Vista
   * High School". Absent, the lockup shows the full name.
   */
  shortName?: string;
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
  /**
   * What a pilot keeps out of sight until a date: tabs off the working
   * surface bar and links off the masthead (`surfaces`: editorial, publish,
   * assign, roles, showcase, guides), and programs the school lists but
   * has not opened (`programs`, seeded as `draft`). `tests/orgs.mjs` fails
   * once the date has passed, which is what stops "for now" from becoming
   * forever.
   */
  hiddenUntil?: { date: string; surfaces: string[]; programs: string[] };
  /**
   * When the school's class meets and how the backup pulse is paced (2.8).
   * Live updates arrive over a socket; the pulse polls only when the socket
   * will not connect, quickly inside a class period and once an hour
   * outside one. Periods are in the school's own timezone.
   */
  live: LivePlan;
}

export interface ClassPeriod {
  /** Three-letter weekdays: Mon, Tue, Wed, Thu, Fri, Sat, Sun. */
  days: string[];
  /** 24-hour HH:MM, inclusive. */
  from: string;
  /** 24-hour HH:MM, exclusive. */
  to: string;
}

export interface LivePlan {
  classPeriods: ClassPeriod[];
  /** The backup pulse's pacing, in seconds. */
  fallback: { inClass: number; inClassIdle: number; offHours: number };
}

/** The pacing when a school's file says nothing (2.8). */
export const DEFAULT_LIVE: LivePlan = { classPeriods: [], fallback: { inClass: 8, inClassIdle: 30, offHours: 3600 } };

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
    slug: doc.slug,
    subdomain: doc.subdomain,
    signupMode: doc.signup_mode,
    requiresMentor: doc.requires_mentor,
    name: doc.name,
    shortName: doc.short_name,
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
    hiddenUntil: doc.hidden_until
      ? {
          date: doc.hidden_until.date instanceof Date ? doc.hidden_until.date.toISOString().slice(0, 10) : String(doc.hidden_until.date),
          surfaces: doc.hidden_until.surfaces ?? [],
          /* Programs the school lists but does not open yet: seeded as
             `draft`, so nothing that lists open programs shows them. */
          programs: doc.hidden_until.programs ?? [],
        }
      : undefined,
    live: shapeLive(doc.live),
  };
}

const DAY = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The `live` block of an org file, checked: a period with a bad day or
    time is a class that never meets, so it fails loudly here. */
export function shapeLive(doc: any): LivePlan {
  if (!doc) return DEFAULT_LIVE;
  const classPeriods: ClassPeriod[] = (doc.class_periods ?? []).map((p: any, i: number) => {
    const days = (p.days ?? []).map(String);
    const from = String(p.from ?? ''), to = String(p.to ?? '');
    for (const d of days) if (!DAY.test(d)) throw new Error(`live.class_periods[${i}]: day ${d} is not Mon..Sun`);
    if (!HHMM.test(from) || !HHMM.test(to)) throw new Error(`live.class_periods[${i}]: times are HH:MM`);
    if (from >= to) throw new Error(`live.class_periods[${i}]: from must be before to`);
    if (days.length === 0) throw new Error(`live.class_periods[${i}]: no days`);
    return { days, from, to };
  });
  const f = doc.fallback ?? {};
  const num = (v: any, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    classPeriods,
    fallback: {
      inClass: num(f.in_class_seconds, DEFAULT_LIVE.fallback.inClass),
      inClassIdle: num(f.in_class_idle_seconds, DEFAULT_LIVE.fallback.inClassIdle),
      offHours: num(f.off_hours_seconds, DEFAULT_LIVE.fallback.offHours),
    },
  };
}
