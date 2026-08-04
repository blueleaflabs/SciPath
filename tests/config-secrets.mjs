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

const FILES = ['supabase/config.toml', 'astro.config.mjs'];

const PATTERNS = [
  [/GOCSPX-[A-Za-z0-9_-]+/g, 'a Google client secret'],
  [/[0-9]{6,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com/g, 'a Google client ID'],
  [/sb_secret_[A-Za-z0-9_-]+/g, 'a Supabase secret key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./g, 'a JWT'],
];

const problems = [];

for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
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
