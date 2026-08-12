/**
 * THE ORGANIZATION RECORD
 *
 * Multi-tenant structurally, single-tenant operationally. Every
 * organization-specific value the public surface renders comes from here.
 * Provisioning an organization is a deliberate act and is never self-serve.
 *
 * This file is the build-time source of the record. Once the working
 * surface exists, the same shape is a row in the organizations table with
 * org_id on every other table, and this file becomes the fallback for a
 * self-hosted instance running without a database.
 */

import type { ThemeId } from './fonts';

export interface Org {
  /** Stable identifier. Becomes the organizations.slug. Never reused. */
  id: string;
  /**
   * The hostname that resolves this tenant. Tenancy is never resolved from
   * an email domain: two schools in one district share the same domains.
   */
  hostname?: string;
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
  /** Two to four characters for the lockup badge. */
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
}

export const orgs: Record<string, Org> = {
  scipath: {
    id: 'scipath',
    name: 'SciPath',
    mark: 'SP',
    theme: 'entry',
    isPlatform: true,
    recordPrefix: 'SP',
    timezone: 'America/Los_Angeles',
    programs: [],
    contactEmail: 'hello@example.org',
    verifiedDomains: [],
    editorialReview: true,
    showcaseNote:
      'Published records from organizations running this software. Reading anything here never requires an account.',
  },

  /**
   * Tenant one. The lockup names the school and not the journal: the
   * research journal is one artifact the school produces, and naming the
   * tenant after it would make the showcase larger than the institution
   * that owns it.
   *
   * These four facts also exist as a row in the organizations table, seeded
   * by migration 0001. The config record is what the static build reads,
   * since a prerendered route may not touch the database; the table is what
   * row level security reads. They must not be allowed to drift.
   */
  montavista: {
    id: 'montavista',
    hostname: 'montavista.localhost',
    signupMode: 'domain',
    name: 'Monta Vista High School',
    mark: 'MVHS',
    theme: 'proceedings',
    recordPrefix: 'MVRJ',
    timezone: 'America/Los_Angeles',
    programs: ['mvhs-scvsefa-2027', 'irpd-mvhs-2027', 'grant-mvhs-micro-2027', 'mvrj-2027', 'independent-research'],
    contactEmail: 'hello@example.org',
    verifiedDomains: ['student.fuhsd.org', 'fuhsd.org'],
    editorialReview: true,
    showcaseNote:
      'Work by students at this school, published as a permanent, citable record.',
  },

  /**
   * Tenant two, and the reason tenancy moved to the hostname. Lynbrook holds
   * exactly the same two district domains as Monta Vista. A sign-in on
   * student.fuhsd.org is a student at one of five schools and the address
   * cannot say which, so the URL does.
   */
  lynbrook: {
    id: 'lynbrook',
    hostname: 'lynbrook.localhost',
    signupMode: 'domain',
    name: 'Lynbrook High School',
    mark: 'LHS',
    theme: 'proceedings',
    recordPrefix: 'LHSR',
    timezone: 'America/Los_Angeles',
    programs: ['scvsefa-2027', 'independent-research'],
    contactEmail: 'hello@example.org',
    verifiedDomains: ['student.fuhsd.org', 'fuhsd.org'],
    editorialReview: true,
    showcaseNote:
      'Work by students at this school, published as a permanent, citable record.',
  },

  /**
   * Tenant three. Open signup, no district, no club mentor. Anyone may
   * create an account and track a project.
   */
  blueleaflabs: {
    id: 'blueleaflabs',
    hostname: 'open.localhost',
    signupMode: 'open',
    requiresMentor: false,
    name: 'Open Program',
    mark: 'OPEN',
    theme: 'entry',
    recordPrefix: 'OPN',
    timezone: 'America/Los_Angeles',
    programs: ['independent-research'],
    contactEmail: 'hello@example.org',
    verifiedDomains: [],
    editorialReview: false,
    showcaseNote:
      'Projects tracked by students working independently, with no school program behind them.',
  },

  /**
   * A second record, so the alternate theme can be reviewed and contrast
   * checked in CI. Replace or delete when a real organization is
   * provisioned. Holds no student data of any kind.
   */
  example: {
    id: 'example',
    name: 'Example Research Program',
    mark: 'EX',
    theme: 'proceedings',
    recordPrefix: 'EXP',
    timezone: 'America/Los_Angeles',
    contactEmail: 'research@example.org',
    verifiedDomains: ['students.example.org', 'example.org'],
    editorialReview: true,
    showcaseNote:
      'Work by students at this organization, published as a permanent, citable record.',
  },
};

/**
 * The active organization. Selected by environment variable so a preview
 * deployment can render another tenant without a code change, and never by
 * a hardcoded constant inside a component.
 *
 * Read two ways because two runtimes read this file. Vite replaces
 * `import.meta.env` at build; plain Node leaves it undefined, and a script
 * importing this file died on the property access before it reached the
 * fallback. That is why the seed scripts held their own copies of the
 * prefix and the program list, and why one of those copies was wrong.
 */
const fromVite = typeof import.meta.env !== 'undefined' ? import.meta.env.PUBLIC_ORG : undefined;
const fromNode = typeof process !== 'undefined' ? process.env?.PUBLIC_ORG : undefined;

const requested = fromVite ?? fromNode ?? 'scipath';

export const org: Org = orgs[requested] ?? orgs.scipath;
