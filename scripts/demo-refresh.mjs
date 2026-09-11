#!/usr/bin/env node
/**
 * REFRESH THE DEMONSTRATION RECORDS IN PLACE (2.9, dev-149).
 *
 * The pilot is live, so `reset:cloud` is no longer a way to change anything
 * on the hosted project: the class's work is in that database. This script
 * is the way the two invented records on the demonstration tenant are
 * corrected on top of what is there, and it touches nothing else.
 *
 * What it does, for the organization named (default `demo`), which must
 * carry `demo: true` in its file — a real school is refused before the
 * database is read:
 *
 *   1. Finds the records that came out of the workbench there. On a
 *      demonstration tenant those are the fixtures: the back catalogue is
 *      `migrated`, and nobody real can publish through an invite-only door.
 *   2. Replaces the four showcase pictures of each record's project with
 *      the drawn ones in scripts/fixtures/shots/ — at the same storage
 *      paths, so the rows stay put — and sets their alt text and captions.
 *   3. Sets each record's date to the one src/config/demo-records.mjs
 *      names, if that keeps the year (the year is in the URL and the file
 *      key; a date that would move it is reported and left).
 *   4. Reassembles the record's files — the body, the copied pictures, and
 *      the video still fetched once from Vimeo — writes them over the old
 *      ones, and rewrites the manifest entry under the same record id.
 *   5. Rebuilds the records search index.
 *
 * Nothing is deleted, no id changes, and running it twice is the same as
 * running it once.
 *
 * Run:
 *   npm run demo:refresh                                   # the local stack
 *   npm run demo:refresh -- --cloud --allow-remote=<ref>   # the hosted project
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { createClient } from '@supabase/supabase-js';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';
import { loadOrgs } from './orgs-library.mjs';
import { openBucket } from './notebook-bucket.mjs';
import { fixtureTarget } from './fixture-target.mjs';
import { blobOver, normalize } from './record-blob.mjs';
import { assembleRecord } from '../src/lib/record-files.ts';
import { readManifest, writeManifest, upsert } from '../src/lib/records-store.ts';
import { FIXTURE_PUBLISHED_ON, FIXTURE_SHOTS, FIXTURE_VIDEO } from '../src/config/demo-records.mjs';
import { parseVideo, posterFor } from '../src/lib/video.ts';

const args = process.argv.slice(2);
const cloud = args.includes('--cloud');
const allowRemote = args.find((a) => a.startsWith('--allow-remote='))?.split('=')[1];
const ORG_SLUG = args.find((a) => a.startsWith('--org='))?.split('=')[1] ?? process.env.DEMO_ORG ?? 'demo';

loadDevVars();
if (cloud) loadCloudVars();

const URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

if (!URL || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are both needed (.cloud.vars with --cloud, .dev.vars otherwise).');
  process.exit(1);
}

const orgs = loadOrgs();

/* The organization's own file decides, before anything is read. The same
   rule the seeds use: only a file carrying `demo: true` may be written to on
   a host that is not loopback, and a real school is refused by name. */
const target = fixtureTarget({ url: URL, slugs: [ORG_SLUG], allowRemote });
if (target.refuse) { console.error(`\n${target.refuse}\n`); process.exit(1); }
if (!orgs[ORG_SLUG]?.demo) {
  console.error(`\n"${ORG_SLUG}" is not a demonstration tenant (no \`demo: true\` in its file). Refusing.\n`);
  process.exit(1);
}
if (target.note) console.log(target.note);

const db = createClient(URL, KEY, { auth: { persistSession: false } });
const imrad = yaml.load(fs.readFileSync('src/config/shapes/imrad.yaml', 'utf8'));
const SHOTS_DIR = path.join('scripts', 'fixtures', 'shots');

let store = null;
let bucket = null;
try {
  store = await openBucket({ url: URL });
  bucket = store?.bucket ?? null;
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}
if (!bucket) { console.error('\nNo file storage, so the records cannot be rewritten.\n'); process.exit(1); }

const blob = blobOver(bucket);
const must = async (promise, what) => {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

async function main() {
  const org = await must(
    db.from('organizations').select('id, slug').eq('slug', ORG_SLUG).maybeSingle(),
    'reading the organization'
  );
  if (!org) throw new Error(`No organization "${ORG_SLUG}" in this database.`);

  /* The fixtures, and only the fixtures. */
  const records = await must(
    db.from('records').select('*').eq('org_id', org.id).eq('source', 'workbench').neq('status', 'archived').order('id'),
    'reading the records'
  );
  if (records.length === 0) {
    console.log(`\nNo workbench records in "${ORG_SLUG}"; nothing to refresh.\n`);
    return;
  }
  console.log(`\nRefreshing ${records.length} demonstration record${records.length === 1 ? '' : 's'} in "${ORG_SLUG}"\n`);

  /* ── The pictures and the film, once per project ──────────────────── */
  const projectsDone = new Set();
  for (const record of records) {
    if (!record.project_id || projectsDone.has(record.project_id)) continue;
    projectsDone.add(record.project_id);
    await refreshPictures(org, record.project_id);
    await ensureVideo(record.project_id);
  }

  /* ── The dates, then the files ─────────────────────────────────────── */
  const manifest = await readManifest(bucket, org.slug);
  let next = manifest;

  for (const record of records) {
    const wanted = FIXTURE_PUBLISHED_ON[record.record_kind];
    if (wanted && Number(wanted.slice(0, 4)) !== record.year) {
      console.log(`  ${record.id}  date ${wanted} would move the year from ${record.year}; left as ${record.published_on}`);
    } else if (wanted && wanted !== record.published_on) {
      await must(
        db.from('records').update({ published_on: wanted, date_precision: 'day' }).eq('id', record.id),
        `dating ${record.id}`
      );
      record.published_on = wanted;
      record.date_precision = 'day';
      console.log(`  ${record.id}  dated ${wanted}`);
    }

    const { files, entry, missing } = await assembleRecord(db, blob, org.slug, record, imrad);
    if (missing.length > 0) throw new Error(`${record.id}: ${missing.join(', ')} could not be read from storage`);

    for (const file of files) {
      await bucket.put(file.key, normalize(file.body), { httpMetadata: { contentType: file.contentType } });
    }
    next = upsert(next, entry);
    console.log(
      `  ${record.id}  ${record.record_kind === 'project' ? 'fair entry' : 'paper'}  ` +
      `${entry.shots.length} picture${entry.shots.length === 1 ? '' : 's'}, ` +
      `${entry.videoPoster ? 'video still captured' : entry.video ? 'no video still (fetch failed)' : 'no video'}`
    );
  }

  await writeManifest(bucket, next);
  console.log('\n  manifest rewritten');

  /* ── The search index reads the store, so it follows ───────────────── */
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL);
  const indexed = spawnSync(
    process.execPath,
    ['scripts/index-records.mjs', ...(isLoopback ? [] : ['--remote'])],
    { stdio: 'inherit', env: process.env }
  );
  if (indexed.status !== 0) throw new Error('the records index did not rebuild; run `npm run index:records` yourself');
  console.log('\nDone. Public pages are cached at the edge for a few minutes; a hard reload shows the change sooner.\n');
}

/**
 * The film (dev-151). A fixture project made before the seed set one, or
 * whose still could not be fetched at the time, gets the address and a
 * report of whether Vimeo answers for its still now — so "no card" and
 * "card without a picture" are told apart here rather than on the page.
 */
async function ensureVideo(projectId) {
  const project = await must(db.from('projects').select('video_url').eq('id', projectId).maybeSingle(), 'reading the project');
  if (!project) return;
  if (!project.video_url) {
    await must(db.from('projects').update({ video_url: FIXTURE_VIDEO }).eq('id', projectId), 'setting the film');
    console.log(`  project ${projectId.slice(0, 8)}…  film set to ${FIXTURE_VIDEO}`);
  }
  const video = parseVideo(project.video_url ?? FIXTURE_VIDEO);
  if (!video) { console.log(`  project ${projectId.slice(0, 8)}…  film address not understood: ${project.video_url}`); return; }
  try {
    const still = await posterFor(video);
    console.log(`  project ${projectId.slice(0, 8)}…  film ${video.watch}, still ${still ? 'found' : 'not offered by the host'}`);
  } catch (e) {
    console.log(`  project ${projectId.slice(0, 8)}…  film ${video.watch}, still not fetched: ${e?.message ?? e}`);
  }
}

/**
 * The four pictures, written over the project's existing ones at their own
 * storage paths so `project_images` keeps its rows; a project with fewer
 * than four rows gets the missing ones inserted under the author's name.
 */
async function refreshPictures(org, projectId) {
  const rows = await must(
    db.from('project_images').select('id, position, storage_path').eq('project_id', projectId).is('withdrawn_at', null).order('position'),
    'reading the project pictures'
  );
  const byPosition = new Map(rows.map((r) => [r.position, r]));

  let uploader = null;
  for (let i = 0; i < FIXTURE_SHOTS.length; i += 1) {
    const position = i + 1;
    const shot = FIXTURE_SHOTS[i];
    const png = fs.readFileSync(path.join(SHOTS_DIR, shot.file));
    const had = byPosition.get(position);
    const storagePath = had?.storage_path ?? `projects/${projectId}/images/placeholder-${position}.png`;

    await bucket.put(storagePath, new Uint8Array(png).buffer, { httpMetadata: { contentType: 'image/png' } });

    if (had) {
      await must(
        db.from('project_images').update({ alt: shot.alt, caption: shot.caption }).eq('id', had.id),
        `captioning picture ${position}`
      );
    } else {
      if (!uploader) {
        const author = await must(
          db.from('project_authors').select('user_id').eq('project_id', projectId).eq('role', 'author').order('created_at').limit(1).maybeSingle(),
          'finding the author'
        );
        uploader = author?.user_id ?? null;
        if (!uploader) throw new Error(`project ${projectId} has no author to upload pictures as`);
      }
      await must(
        db.from('project_images').insert({
          org_id: org.id, project_id: projectId, position, storage_path: storagePath,
          alt: shot.alt, caption: shot.caption, uploaded_by: uploader,
        }),
        `adding picture ${position}`
      );
    }
  }
  console.log(`  project ${projectId.slice(0, 8)}…  ${FIXTURE_SHOTS.length} pictures written`);
}

async function release() {
  if (store) await store.dispose();
  store = null;
}

main()
  .then(release)
  .catch(async (e) => {
    await release();
    console.error(`\n${e.message}\n`);
    process.exit(1);
  });
