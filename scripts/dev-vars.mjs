/**
 * READING .dev.vars.
 *
 * Four scripts need the local Supabase credentials. Two of them got the
 * values because wrangler reads this file on its way to setting up bindings,
 * and two read `process.env` and found nothing, so `npm run reset` recreated
 * the schema, emptied storage, and then stopped before creating a single
 * account. The chain is joined with `&&`, so everything after it silently did
 * not run either, and the result looked like a broken migration rather than a
 * shell that had lost its variables after a reboot.
 *
 * The instruction it printed was correct and is the wrong answer: a script
 * that needs a file should read the file.
 *
 * The environment still wins. Anything already set is left alone, so CI and a
 * deployment pass their own values in the ordinary way and this changes
 * nothing for them.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = '.dev.vars';

/** KEY=value, one per line. Quotes optional, `export` tolerated, # is a comment. */
export function parseDevVars(text) {
  const out = {};

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq < 1) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();

    /* Strip one matched pair of quotes, and only a matched pair: a value
       that genuinely starts with a quote is rare, and a value that genuinely
       contains one is not. */
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

/**
 * Load the file into `process.env` without overwriting anything already
 * there. Returns the names it set, so a script can say so if it wants to.
 */
export function loadDevVars(dir = process.cwd()) {
  const file = path.join(dir, FILE);
  if (!fs.existsSync(file)) return [];

  const values = parseDevVars(fs.readFileSync(file, 'utf8'));
  const applied = [];

  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      applied.push(key);
    }
  }

  return applied;
}

/**
 * The same, for `.cloud.vars`, except that this file **wins**.
 *
 * `loadDevVars` leaves anything already in the environment alone, so CI and a
 * deployment can pass their own values. `.cloud.vars` is the opposite case: a
 * developer's shell holds `PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`
 * because that is what local work needs, exported once and forgotten. With
 * the usual precedence that shell variable beat the file, and
 * `npm run reset:cloud` refused every time with *this is the local database*
 * — correct, and useless, since the answer was to `unset` two variables
 * before every run.
 *
 * A file named `.cloud.vars`, read only by the scripts that act on a cloud
 * project, is not ambiguous about what it means. Nothing in CI reads it, so
 * there is no environment left to be polite to.
 *
 * Returns what it overrode as well as what it set, so a script can say so.
 * Quietly replacing a value somebody exported on purpose is its own trap.
 */
export function loadCloudVars(dir = process.cwd()) {
  const file = path.join(dir, '.cloud.vars');
  if (!fs.existsSync(file)) return { applied: [], overrode: [] };

  const values = parseDevVars(fs.readFileSync(file, 'utf8'));
  const applied = [];
  const overrode = [];

  for (const [key, value] of Object.entries(values)) {
    const had = process.env[key];
    if (had !== undefined && had !== '' && had !== value) overrode.push(key);
    process.env[key] = value;
    applied.push(key);
  }

  return { applied, overrode };
}
