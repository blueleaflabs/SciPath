/**
 * THE EDGE REWRITE RULES, WRITTEN OUT FROM THE REPOSITORY.
 *
 * A tenant's public pages are prerendered once per organization under
 * `/[org]/`, and a reader asks for them without the slug. Something has to
 * put it back. The middleware tries, and on Cloudflare Pages it may not get
 * the chance: an unmatched path can be answered by the static `404.html`
 * before the worker is invoked at all.
 *
 * **This is the fallback, and it is generated rather than remembered.** A
 * Transform Rule typed into a dashboard is configuration nobody can find in
 * six months, cannot review in a pull request, and will not match the code
 * the day somebody adds a route. So the rules are printed from
 * `NON_TENANT_TREES` and the organization files — the same two sources the
 * middleware reads — and `tests/edge-rules.mjs` refuses to let them drift.
 *
 * Run:  npm run edge-rules
 *
 * Then in Cloudflare: the zone → Rules → Transform Rules → Rewrite URL, one
 * rule per tenant, pasting the expression and the dynamic path each prints.
 * Re-run this after adding a school or a non-tenant tree, and replace them.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

import { loadCloudVars } from './dev-vars.mjs';
import { NON_TENANT_TREES } from '../src/config/routes.ts';

/* `.cloud.vars`, because the domain a rule names is the deployed one and
   `.dev.vars` holds `localhost`. */
loadCloudVars();

const DIR = 'src/config/orgs';

const orgs = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.yaml'))
  .map((f) => yaml.load(fs.readFileSync(path.join(DIR, f), 'utf8')))
  .filter((doc) => doc?.provisioned !== false);

if (orgs.length === 0) {
  console.error(`No provisioned organizations in ${DIR}/.`);
  process.exit(1);
}

const root = process.env.PUBLIC_ROOT_DOMAIN;

if (!root) {
  console.error(
    '\nPUBLIC_ROOT_DOMAIN is needed, because a rule names a hostname.\n\n' +
      'Put it in .cloud.vars beside the project URL, or pass it inline:\n' +
      '  PUBLIC_ROOT_DOMAIN=scipath.org npm run edge-rules\n'
  );
  process.exit(1);
}

/**
 * What must not be prefixed.
 *
 * The non-tenant trees render on demand and resolve their organization from
 * the hostname; prefixing one breaks it. Plus the paths the build owns and
 * the home page, which has no tenant copy to rewrite to.
 *
 * Read from `src/config/routes.ts` rather than listed here, because that file
 * already exists to stop this list living in two places (its own comment says
 * so, after the tracker was added to one copy and not the other). This would
 * have been the third.
 */
const EXEMPT = [
  ...NON_TENANT_TREES,
  '_astro',
  'pdf',
  'sitemap',
  '404',
];

function ruleFor(org) {
  const label = org.subdomain ?? org.id;
  const isBase = label === 'scipath';

  const host = isBase
    ? `http.host in {"${root}" "www.${root}"}`
    : `http.host eq "${label}.${root}"`;

  const guards = [
    host,
    ...EXEMPT.map((tree) => `not starts_with(http.request.uri.path, "/${tree}")`),
    /* Its own prefix, so a rewritten request cannot be rewritten again. */
    `not starts_with(http.request.uri.path, "/${org.id}/")`,
    'http.request.uri.path ne "/"',
  ];

  return {
    name: `tenant path · ${org.id}`,
    expression: guards.join('\n  and '),
    rewrite: `concat("/${org.id}", http.request.uri.path)`,
  };
}

console.log(`
Cloudflare → ${root} → Rules → Transform Rules → Rewrite URL

One rule per tenant. Path: Rewrite to → Dynamic.
Query: preserve.

Generated from src/config/routes.ts and src/config/orgs/. Re-run and replace
these after adding a school or a non-tenant tree; tests/edge-rules.mjs fails
if the two disagree.
`);

for (const org of orgs) {
  const rule = ruleFor(org);
  console.log(`\n${'─'.repeat(72)}\n${rule.name}\n${'─'.repeat(72)}\n`);
  console.log('When incoming requests match:\n');
  console.log(`  ${rule.expression}\n`);
  console.log('Then rewrite path to (dynamic):\n');
  console.log(`  ${rule.rewrite}\n`);
}

console.log(
  `\n${orgs.length} rule${orgs.length === 1 ? '' : 's'}, ` +
    `${EXEMPT.length} exempt trees.\n`
);
