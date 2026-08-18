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

import yaml from 'js-yaml';

import { shapeOrg, type Org } from './org-shape';

/* Re-exported because every component imports the type from here. */
export type { Org };

/**
 * The records, from `orgs/*.yaml`.
 *
 * **One file per organization, and it is the only description of it.** These
 * facts used to exist twice — as literals here and again as a `provision_org`
 * call in migration 0001 — under a comment saying the two must not be allowed
 * to drift. A rule stated in a comment is not a rule (19.9), and eight facts
 * about a school in two hand-maintained places is a drift waiting for the
 * week somebody is in a hurry.
 *
 * `scripts/seed-orgs.mjs` provisions the rows from these same files, so
 * adding a school is a file rather than an edit in two places that have to
 * agree.
 *
 * Bundled with `import.meta.glob` like the template registry, so this
 * resolves inside a Worker with no filesystem: tenancy is decided per request
 * and cannot wait for a file read.
 */
const files = import.meta.glob('/src/config/orgs/*.yaml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const orgs: Record<string, Org> = {};

for (const [path, text] of Object.entries(files)) {
  const doc = yaml.load(text) as any;
  if (!doc?.id) throw new Error(`${path} has no id`);
  orgs[doc.id] = shapeOrg(doc);
}

/**
 * The active organization. Selected by environment variable so a preview
 * deployment can render another tenant without a code change, and never by
 * a hardcoded constant inside a component.
 *
 * Read two ways because this used to be read by two runtimes. Vite replaces
 * `import.meta.env` at build; plain Node leaves it undefined, and a script
 * importing this file died on the property access before it reached the
 * fallback. That is why the seed scripts held their own copies of the prefix
 * and the program list, and why one of those copies was wrong.
 *
 * **No script imports this file any more, and none should.** The glob above
 * is a Vite transform that plain Node cannot run at all, which is the same
 * fault a size larger: `scripts/orgs-library.mjs` reads the same directory
 * off the disk and hands it to the same `shapeOrg`. The dual read here stays
 * because a preview deployment still sets `PUBLIC_ORG` in an environment
 * neither half covers alone.
 */
const fromVite = typeof import.meta.env !== 'undefined' ? import.meta.env.PUBLIC_ORG : undefined;
const fromNode = typeof process !== 'undefined' ? process.env?.PUBLIC_ORG : undefined;

const requested = fromVite ?? fromNode ?? 'scipath';

export const org: Org = orgs[requested] ?? orgs.scipath;
