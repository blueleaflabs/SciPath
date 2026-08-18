/**
 * THE TEMPLATES, FOR A SCRIPT.
 *
 * The application gets these through Vite. A script has a filesystem, so it
 * reads them directly — and then hands them to the same resolver the
 * application uses, because a fair's calendar meaning one thing in the
 * database and another on the page is the failure this whole exercise exists
 * to prevent.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const ROOT = 'src/config';

function readDirectory(name) {
  const dir = path.join(ROOT, name);
  const out = new Map();

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const doc = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!doc?.id) throw new Error(`${dir}/${file} has no id`);

    out.set(doc.id, doc);
    /* Keyed by filename too, because `uses:` and `extends:` name either. */
    const stem = file.replace(/\.yaml$/, '');
    if (stem !== doc.id) out.set(stem, doc);
  }

  return out;
}

export function loadLibrary() {
  return {
    programs: readDirectory('programs'),
    deliverables: readDirectory('deliverables'),
    shapes: readDirectory('shapes'),
  };
}
