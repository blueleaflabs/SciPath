/**
 * supabase/config.toml is committed, and it has to stay committed: it is the
 * declarative definition of the local stack, and it is what makes a second
 * machine produce an identical one. It is only safe because every provider
 * secret is an env(...) reference.
 *
 * The failure this catches is somebody pasting a literal in to make
 * something work quickly. The repository is public, so that is a rotation
 * rather than an edit.
 *
 * Run: npm run test:config
 */

import fs from 'node:fs';
import path from 'node:path';

/* **Everything committed, not two named files.**
 *
 * This scanned `supabase/config.toml` and `astro.config.mjs`, which was the
 * whole of the committed configuration when it was written. It is not any
 * more: organizations are files in `src/config/orgs/`, and the deployment is
 * an environment variable. A check that names its inputs stops covering the
 * thing it was written for the moment somebody adds a file — and the only
 * signal would be that it kept passing.
 *
 * So it walks the tree. Anything git would carry is in scope, which is the
 * right definition: the repository is public, and what matters is not which
 * file a literal is pasted into but whether it can be read by a stranger. */
const SKIP = new Set([
  'node_modules', 'dist', '.astro', '.wrangler', '.git',
  'prd', 'local-data', 'public',
]);

const walk = (dir) => {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    /* `.dev.vars` is ignored by git and holds the real values; scanning it
       would report the secrets it exists to hold. */
    else if (!entry.name.startsWith('.dev.vars')) out.push(full);
  }
  return out;
};

const FILES = walk('.').map((f) => f.replace(/^\.\//, '')).filter((f) =>
  /\.(ts|tsx|mjs|js|astro|css|yaml|yml|toml|json|md|sql|sh|txt|example)$/.test(f)
);

const PATTERNS = [
  [/GOCSPX-[A-Za-z0-9_-]+/g, 'a Google client secret'],
  [/[0-9]{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com/g, 'a Google client ID'],
  [/sb_secret_[A-Za-z0-9_-]+/g, 'a Supabase secret key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./g, 'a JWT'],
  [/re_[A-Za-z0-9]{24,}/g, 'a Resend key'],
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, 'a GitHub token'],
  [/AKIA[0-9A-Z]{16}/g, 'an AWS access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'a private key'],
];

/* One fixture is a JWT on purpose: `tests/dev-vars.mjs` checks that the
   parser accepts a key shaped like one. Named rather than pattern-matched,
   so a second file cannot quietly inherit the exemption. */
const ALLOWED = new Set(['tests/dev-vars.mjs', 'tests/config-secrets.mjs']);

const problems = [];

for (const file of FILES) {
  if (!fs.existsSync(file) || ALLOWED.has(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  for (const [pattern, label] of PATTERNS) {
    if (pattern.test(source)) problems.push(`${file}: contains ${label}`);
    pattern.lastIndex = 0;
  }
}

console.log(`${FILES.length} committed config files scanned.`);

if (problems.length > 0) {
  console.error('\nSecret literal in a committed file:');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nUse an env(...) reference in config.toml and .dev.vars for the value.\n' +
      'If this was ever pushed, rotate the credential rather than editing history.'
  );
  process.exit(1);
}

console.log('No secret literals in committed config.');
