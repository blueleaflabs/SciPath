/**
 * THE ORGANIZATIONS, FOR A SCRIPT.
 *
 * The application gets these through Vite's `import.meta.glob`. A script has
 * a filesystem, so it reads them directly — and then hands them to the same
 * `shapeOrg` the application uses, because two translations of one file is
 * how a school's record comes to mean one thing in a seed and another on the
 * page.
 *
 * Exactly the arrangement `scripts/template-library.mjs` has for templates,
 * and it exists for a fault that has now happened twice in this shape (19.9):
 * a script importing `src/config/orgs.ts` dies, because `import.meta.env` is
 * undefined under plain Node and `import.meta.glob` is not a function at all.
 * The second one killed a reset after three seed scripts had already written.
 *
 * `tests/scripts.mjs` refuses a script whose import graph reaches either.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { shapeOrg } from '../src/config/org-shape.ts';

const DIR = 'src/config/orgs';

/**
 * Every organization, keyed by id, in the shape `src/config/orgs.ts` exports.
 *
 * Read fresh rather than cached at import, because a script that reseeds
 * after an edit should see the edit, and reading four small files costs
 * nothing.
 */
export function loadOrgs() {
  const orgs = {};

  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.yaml')).sort()) {
    const doc = yaml.load(fs.readFileSync(path.join(DIR, file), 'utf8'));
    if (!doc?.id) throw new Error(`${DIR}/${file} has no id`);
    orgs[doc.id] = shapeOrg(doc);
  }

  return orgs;
}

/** The same, as the raw documents, for the fields the record does not carry. */
export function loadOrgDocuments() {
  const docs = [];

  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.yaml')).sort()) {
    const doc = yaml.load(fs.readFileSync(path.join(DIR, file), 'utf8'));
    if (!doc?.id) throw new Error(`${DIR}/${file} has no id`);
    docs.push(doc);
  }

  return docs;
}
