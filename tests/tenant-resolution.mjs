/**
 * A layout that reads the organization from a module-level import renders the
 * same school at every hostname. It builds, it passes every other test, and
 * it is invisible until two tenants exist.
 *
 * Rule: no shared component, no layout, and no ON-DEMAND route imports the
 * resolved `org` singleton. They take it as a prop, or call
 * activeOrg(Astro.locals), which prefers the hostname the middleware
 * resolved.
 *
 * Nothing is exempt any more. Public routes used to be single tenant per
 * build, which made a module-level import defensible there. They are now
 * prerendered once per tenant under [org]/, so a page reading the singleton
 * would render one school's name into every school's files.
 *
 * Run: npm run test:tenant
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOTS = ['src/components', 'src/layouts', 'src/pages'];
const ALLOW = ['src/lib/tenant.ts'];

/* `import { org }` or `import { org, ... }` from the config module. */
const SINGLETON = /import\s*\{[^}]*\borg\b[^}]*\}\s*from\s*['"][^'"]*config\/orgs['"]/;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.(astro|ts|tsx|js|mjs)$/.test(entry.name)) found.push(full);
  }
  return found;
}

const offenders = [];

for (const file of ROOTS.flatMap(walk)) {
  const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
  if (ALLOW.includes(rel)) continue;

  const source = fs.readFileSync(file, 'utf8');

  /* A type-only import of Org is fine; the value singleton is not. */
  const stripped = source.replace(/import\s+type\s*\{[^}]*\}\s*from\s*['"][^'"]*['"]/g, '');
  if (SINGLETON.test(stripped)) offenders.push(rel);
}

console.log('Shared components, layouts, and on-demand routes scanned.');

if (offenders.length > 0) {
  console.error('\nImporting the resolved org singleton:');
  for (const file of offenders) console.error(`  ${file}`);
  console.error(
    '\nTenancy is resolved per request from the hostname. Take the org as a\n' +
      'prop from the layout, or call activeOrg(Astro.locals). A module-level\n' +
      'import renders one school at every hostname and nothing catches it\n' +
      'until a second tenant exists.'
  );
  process.exit(1);
}

/**
 * A SESSION IS GLOBAL. MEMBERSHIP IS NOT.
 *
 * There is one `auth.users` across every tenant, because a person has one set
 * of credentials. `public.users.org_id` says which school the account is at,
 * and the middleware attached the account to the request on `auth.uid()`
 * alone — so a teacher created for Monta Vista signed in at the platform's
 * own address and was admitted, with their roles.
 *
 * Row level security was not holding the line. `app.org_id()` reads
 * `users.org_id` for the caller, so the *data* was Monta Vista's: one
 * school's roster rendered under another school's name, at an address that
 * school's students use. The tenant boundary in the interface was a lie in
 * the other direction from the one it looks like.
 *
 * Two things have to stay true, and the second is the trap. The comparison
 * has to happen, and it has to be against the slug — `users.org_id` is a uuid
 * the database generated and `org.id` in `src/config` is a slug, so comparing
 * those two is never equal and would lock every account out of every tenant.
 * That version looks correct in a diff and fails closed on the first request.
 */
{
  const middleware = fs.readFileSync('src/middleware.ts', 'utf8');
  const code = middleware
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');

  const problems = [];

  if (!/organizations\(slug\)/.test(code)) {
    problems.push('the account query must join organizations(slug), or there is nothing to compare');
  }

  if (!/accountSlug\s*!==\s*slug/.test(code)) {
    problems.push('the middleware must compare the account slug against the resolved tenant');
  }

  /* `org_id` is a uuid the database generated; the tenant's name on this side
     is a slug. Comparing them is never equal, so every account is locked out
     of every tenant — a fix worse than the bug and one that looks right in a
     diff.

     Refused wherever it appears rather than against a named right-hand side.
     The first version listed `org.id` and `slug`, and swapping in
     `account.org_id !== slug` walked straight past it. */
  if (/account\.org_id\s*!==/.test(code)) {
    problems.push('org_id is a uuid and the tenant name is a slug: never equal');
  }

  /* **It has to fail closed.**

     The first version read `account && accountSlug && accountSlug !== slug`,
     and that middle term admits the account whenever the slug is missing —
     a policy that refuses the join, a rename, a query edited elsewhere. A
     tenancy guard whose unknown case is "let them in" reports success in
     exactly the situation nobody is watching.

     Matched on the condition itself rather than on behaviour, because there
     is no way to observe the null case from a file read. */
  if (/account\s*&&\s*accountSlug\s*&&/.test(code)) {
    problems.push('an account with no readable school must be refused, not admitted');
  }

  /* And the account must not survive the mismatch. Merely redirecting would
     leave every page outside `/app/` rendering as that person.

     **Matched inside the block, not anywhere in the file.** The loose version
     of this checked for `locals.account = null` in `code` at all — and the
     signed-out branch two hundred lines above sets exactly that, so deleting
     the assignment from the mismatch branch left the suite green. A guard
     that is satisfied by an unrelated line elsewhere in the same file is a
     guard that passes for the wrong reason, which is the failure this whole
     block exists to catch one level down. */
  /* **A missing anchor is a failure, not an empty slice.**

     Two attempts at this were wrong in the same way. The first sliced from
     `accountSlug !== org.id` and went inert the moment the comparison was
     rewritten to use `slug`. The second anchored on `locals.roles = []`,
     which also appears in the initialisation two hundred lines above, so the
     slice began at the wrong one.

     Both failed quietly because `indexOf` returns -1 and `slice(-1)` is a
     perfectly good string. So the anchor is now required to be found, and
     required to be unique — a check that cannot locate what it is checking
     has to say so rather than measure the wrong region. */
  const anchor = 'accountSlug !== slug';
  const at = code.indexOf(anchor);
  const occurrences = code.split(anchor).length - 1;

  /* **The path does not cross the boundary.**

     The redirect carried `url.pathname`, so `/app/project/abc/` at one tenant
     became `/app/project/abc/` at another — an id from a namespace that
     tenant does not have. RLS refuses it, so nothing leaks, but somebody
     lands on a dead page immediately after a redirect they did not ask for.
     `/app/` is the only path that means the same thing in every tenant. */
  const redirect = code.match(/originForOrg\(home\)\}[^`]*/);

  if (!redirect) {
    problems.push('cannot find the redirect to the account\u2019s own school');
  } else if (/url\.pathname/.test(redirect[0])) {
    problems.push('the redirect must not carry the path across a tenant boundary');
  }

  if (occurrences !== 1) {
    problems.push(
      `cannot locate the membership branch: "${anchor}" appears ${occurrences} times`
    );
  } else {
    const branch = code.slice(at);
    const blockEnd = branch.indexOf('return next();');

    if (blockEnd === -1) {
      problems.push('the membership branch does not close with a return');
    } else if (!/locals\.account\s*=\s*null/.test(branch.slice(0, blockEnd))) {
      problems.push('a mismatched account must be dropped, not merely redirected');
    }
  }

  if (problems.length > 0) {
    console.error('\nAn account is scoped to one school:\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error('');
    process.exit(1);
  }
}

console.log('No component reads the org singleton directly.');
console.log('An account is admitted only to the school it belongs to.');
