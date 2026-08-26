#!/usr/bin/env node
/**
 * PUBLISHING, IN THE SEED.
 *
 * The showcase, the projects archive, the author pages, the topic pages and
 * the search index all read from the record store, and a reset left it empty:
 * every one of those screens could only be tested by publishing something by
 * hand first, which meant they were rarely tested at all.
 *
 * This walks the same path the publish screen walks — allocate an id, freeze
 * the byline, assemble the files, write them to the store, confirm — using
 * the same functions, so a change that breaks publishing breaks this too
 * rather than passing while the real path rots.
 *
 * Two records, deliberately: one paper and one fair entry, which are the two
 * kinds and the pair that exercises the companion linking between them.
 *
 * Run: node --experimental-strip-types scripts/seed-publish.mjs
 */

import fs from 'node:fs';
import yaml from 'js-yaml';
import { createClient } from '@supabase/supabase-js';
import { loadDevVars } from './dev-vars.mjs';
import { fixtureAddress } from '../src/config/demo-accounts.mjs';
import { actingAs, signOutAll } from './act-as.mjs';
import { loadOrgs } from './orgs-library.mjs';
import { openBucket } from './notebook-bucket.mjs';
import { assembleRecord } from '../src/lib/record-files.ts';
import { readManifest, writeManifest, upsert } from '../src/lib/records-store.ts';

const orgs = loadOrgs();

loadDevVars();

const URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

if (!URL || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed.');
  process.exit(1);
}

const db = createClient(URL, KEY, { auth: { persistSession: false } });

/* The section rules the assembler checks against, read from disk because the
   registry the application uses is bundled by Vite. */
const imrad = yaml.load(fs.readFileSync('src/config/shapes/imrad.yaml', 'utf8'));

/* Whichever bucket the rows are going to. Without one nothing can be
   published, and saying so is better than writing rows that point at files
   which do not exist.
   
   This reached for wrangler's local state unconditionally, which meant a
   cloud run either published nothing or — worse, had the local state
   existed — wrote two records into a bucket on the machine that ran it and
   rows pointing at them into the deployed project. */
let store = null;
let bucket = null;

try {
  store = await openBucket({ url: URL });
  bucket = store?.bucket ?? null;
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}

async function release() {
  await signOutAll();
  if (store) await store.dispose();
  store = null;
}

/** The blob interface `assembleRecord` expects. */
const blob = {
  available: () => Boolean(bucket),
  async get(path) {
    if (!bucket) return null;
    const object = await bucket.get(path);
    if (!object) return null;
    return {
      body: await object.arrayBuffer(),
      contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  },
};

async function main() {
  if (!bucket) {
    console.log('\nNo file storage, so nothing can be published.\n');
    return;
  }

  const { data: org, error: orgError } = await db
    .from('organizations')
    .select('id, slug, lockup_name')
    .eq('slug', process.env.DEMO_ORG ?? 'demo')
    .maybeSingle();

  if (orgError) throw new Error(`Could not read the organization: ${orgError.message}`);
  if (!org) throw new Error('No organization to publish into.');

  console.log('\nPublishing\n');

  /* Allocating an identifier and confirming a record are an editor's, and
     the functions say so: `app.require_editor()` reads `auth.uid()`, which
     is null for the secret key. So this signs in as the fixture editor and
     publishes as her, which is also who would be doing it. */
  const editor = await actingAs(fixtureAddress(org.slug, 'officer.a'));

  /* The prefix is a field on the organization and never a constant (8.3).
     It was written out twice here, and the second one said `SP` — the
     platform's prefix, on a school's fair entry, beside that school's own
     paper. Nobody saw it because the branch that mints it had never run. */
  const prefix = orgs[org.slug]?.recordPrefix;

  if (!prefix) {
    throw new Error(`No record prefix for "${org.slug}". Add it in src/config/orgs/.`);
  }

  /* ── A paper, through review ─────────────────────────────────────────── */

  const { data: accepted, error: acceptedError } = await db
    .from('submissions')
    .select('id, project_id, state, manuscripts(title)')
    .eq('org_id', org.id)
    .eq('state', 'accepted')
    .limit(1)
    .maybeSingle();

  if (acceptedError) throw new Error(acceptedError.message);

  if (accepted) {
    await publish({
      what: 'paper',
      title: accepted.manuscripts?.title ?? 'Untitled',
      allocate: () =>
        editor.rpc('generate_record', {
          p_submission_id: accepted.id,
          p_slug: slugify(accepted.manuscripts?.title ?? 'untitled'),
          p_prefix: prefix,
          p_published_on: new Date().toISOString().slice(0, 10),
        }),
      confirm: (recordId) => editor.rpc('confirm_published', { p_submission_id: accepted.id }),
      org,
    });
  } else {
    console.log('  No accepted submission, so no paper was published.');
  }

  /* ── A fair entry, which never goes through review ───────────────────── */

  const { data: withResult, error: resultError } = await db
    .from('opportunity_participations')
    .select('project_id, placement, projects:project_id(title)')
    .eq('org_id', org.id)
    .not('placement', 'is', null)
    .limit(1)
    .maybeSingle();

  if (resultError) throw new Error(resultError.message);

  if (withResult) {
    await publish({
      what: 'fair entry',
      title: withResult.projects?.title ?? 'Untitled',
      allocate: () =>
        editor.rpc('generate_project_record', {
          p_project_id: withResult.project_id,
          p_slug: slugify(withResult.projects?.title ?? 'untitled'),
          p_prefix: prefix,
          p_published_on: new Date().toISOString().slice(0, 10),
        }),
      confirm: (recordId) => editor.rpc('mark_record_live', { p_record_id: recordId }),
      org,
    });
  } else {
    console.log('  No recorded fair result, so no entry was published.');
  }

  console.log('\nThe showcase, the archive, and the author and topic pages');
  console.log('now have something in them. Search needs `npm run index:records`.\n');
}

/**
 * Every failure here throws, and none of them used to.
 *
 * They printed a line to stderr and returned, and the seed exited zero with
 * an empty archive. That is the worst shape a failure can take in a chain
 * joined by `&&`: nothing stops, the run looks finished, and the first sign
 * of trouble is a showcase page with nothing on it and no reason to suspect
 * this script rather than the page.
 *
 * A record that could not be allocated, could not be read back, or whose
 * files are not in storage is a broken seed. The one soft case is genuine
 * absence — no accepted submission, no recorded result — which the caller
 * handles and says so.
 */
async function publish({ what, title, allocate, confirm, org }) {
  const { data: recordId, error } = await allocate();

  if (error) throw new Error(`${what}: ${error.message}`);

  const { data: record, error: readError } = await db
    .from('records')
    .select('*')
    .eq('id', recordId)
    .maybeSingle();

  if (readError || !record) {
    throw new Error(`${what}: allocated ${recordId} and could not read it back`);
  }

  const { files, entry, missing } = await assembleRecord(db, blob, org.id, record, imrad);

  if (missing.length > 0) {
    throw new Error(`${what}: ${missing.join(', ')} could not be read from storage`);
  }

  /* The same two writes the publish screen makes: the files, then the
     manifest that makes them findable. */
  for (const file of files) {
    await bucket.put(file.key, normalize(file.body), {
      httpMetadata: { contentType: file.contentType },
    });
  }

  const manifest = await readManifest(bucket, org.id);
  await writeManifest(bucket, upsert(manifest, entry));

  const { error: confirmError } = await confirm(recordId);

  if (confirmError) {
    throw new Error(`${what}: written but not confirmed (${confirmError.message})`);
  }

  console.log(`  ${recordId}  ${what}  ${title}`);
}

/**
 * Miniflare's proxy asserts on a typed array whose byte offset is not zero,
 * and a Node Buffer almost never starts at zero. The remote path is
 * unaffected; this is only the local bucket.
 */
function normalize(body) {
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  }
  return body;
}

/** The same rule the publish screen uses. */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

main()
  .then(release)
  .catch(async (e) => {
    await release();
    console.error(e.message);
    process.exit(1);
  });
