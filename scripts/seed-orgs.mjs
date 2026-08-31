/**
 * THE ORGANIZATIONS, FROM `src/config/orgs/*.yaml`.
 *
 * Every school described once. The same eight facts used to be written twice
 * — as a record in `orgs.ts` and again as a `provision_org` call in migration
 * 0001 — with a comment above them saying the two must not be allowed to
 * drift. A rule stated in a comment is not a rule (19.9).
 *
 * **This runs in every environment, including production.** It is not a
 * fixture: fixtures are accounts and demo projects and they never leave a
 * laptop (12.11a). An organization is a fact the software cannot work without
 * — row level security scopes to `org_id` and there is nothing to scope to
 * until a row exists.
 *
 * That is a deliberate departure from 11.7, which said anything that must
 * exist in production belongs in a migration. The intent of 11.7 was that
 * production must not depend on somebody remembering to run a local step, and
 * that intent is met a different way here: `app.provision_org` is idempotent
 * by `on conflict (slug)`, this is part of `npm run reset`, and it is a named
 * step in the deployment. What 11.7 could not do is stop the description
 * being written down twice.
 *
 * Safe to run against anything. It writes organizations and nothing else: no
 * accounts, no projects, no roles. Running it twice changes nothing the
 * second time.
 *
 *   node scripts/seed-orgs.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import yaml from 'js-yaml';
import { createClient } from '@supabase/supabase-js';

import { loadDevVars } from './dev-vars.mjs';
import { requireApi } from './api-ready.mjs';

/* The shared reader, so a shell that has just been restarted needs nothing
   sourced into it — and so this script parses the file the same way every
   other one does. A second parser is a second set of edge cases. */
loadDevVars();

const URL_ = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

if (!URL_ || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed.');
  process.exit(1);
}

/* The first thing in `npm run reset` to open a socket.
  
   `supabase db reset` restarts the containers and returns before they are
   listening, and `reset-storage` runs in between without touching the
   network, so this loop was the first to find out — and it reported it as
   `demo: TypeError: fetch failed`, naming whichever organization happened to
   sort first. Waiting here fixes the whole chain, because everything after
   this runs seconds later against a gateway that is already warm.
  
   Owned by this script rather than by the wrapper that did the restarting:
   `db:stop` also leaves nothing listening, and a wait in the wrapper would
   have to tell the two apart, which means a list of subcommands that grows a
   case every time one is forgotten. See scripts/api-ready.mjs. */
await requireApi({ url: URL_, key: KEY });

const db = createClient(URL_, KEY, { auth: { persistSession: false } });

const dir = 'src/config/orgs';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();

let wrote = 0;
let skipped = 0;

for (const file of files) {
  const doc = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));

  if (!doc?.slug) {
    console.error(`${file} has no slug.`);
    process.exit(1);
  }

  /* The platform and the theme sample are records without rows: they hold no
     students, nothing is ever scoped to them, and a row for each would be a
     tenant that exists only to be skipped by every query. */
  if (doc.provisioned === false) {
    skipped += 1;
    continue;
  }

  const { error } = await db.rpc('provision_org', {
    p_slug: doc.slug,
    p_subdomain: doc.subdomain ?? doc.slug,
    p_lockup_name: doc.name,
    p_mark: doc.mark,
    p_theme: doc.theme,
    p_signup_mode: doc.signup_mode ?? 'domain',
    p_domains: doc.domains ?? [],
    p_requires_mentor: doc.requires_mentor ?? true,

    /* Which tenant is served at the apex. The org files have carried this
       since there were three of them; the database is learning it now
       because something in SQL has to build an address, and
       `subdomain || '.' || root` gives `scipath.scipath.org` for the one
       tenant whose subdomain is the root. */
    p_is_platform: doc.is_platform === true,
    p_address: doc.address ?? null,
    p_phone: doc.phone ?? null,
  });

  if (error) {
    console.error(`${doc.slug}: ${error.message}`);
    process.exit(1);
  }

  console.log(`  ${doc.slug.padEnd(14)} ${doc.subdomain ?? doc.slug}`);
  wrote += 1;
}

console.log(
  `\n${wrote} ${wrote === 1 ? 'organization' : 'organizations'} provisioned from ${dir}/` +
    (skipped ? `, ${skipped} not provisioned by declaration.` : '.')
);
