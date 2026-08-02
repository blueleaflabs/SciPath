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
  /** Stable identifier. Becomes org_id. Never reused. */
  id: string;
  /** Full name, rendered in the lockup. */
  name: string;
  /** Two or three characters for the lockup badge. */
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
  /** Where a reader writes to. Never an individual student address. */
  contactEmail: string;
  /** Domains whose sign-in confirms affiliation without a teacher sponsor. */
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
    contactEmail: 'hello@example.org',
    verifiedDomains: [],
    editorialReview: true,
    showcaseNote:
      'Published records from organizations running this software. Reading anything here never requires an account.',
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
 */
const requested = import.meta.env.PUBLIC_ORG ?? 'scipath';

export const org: Org = orgs[requested] ?? orgs.scipath;
