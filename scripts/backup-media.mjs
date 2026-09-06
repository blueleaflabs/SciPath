#!/usr/bin/env node
/**
 * THE FILES, COPIED DOWN (2.8).
 *
 * `npm run backup` dumps the database and says, at the end, that R2 is
 * not in it. This is the other half: every object in the bucket (the
 * notebook photographs, the journey maps, the drawn graphics, the signed
 * forms, the published record store), mirrored into a dated folder under
 * `local-data/backups/`, over R2's S3 API with the same four `R2_`
 * variables `reset:storage --remote` uses. Nothing is written to the
 * bucket; the only verbs used are list and get.
 *
 * Incremental against the last mirror when `--into <folder>` names one:
 * an object whose size and ETag match the file already there is skipped,
 * so a nightly run copies the day's uploads and not the season's.
 *
 *   npm run backup:media -- --cloud                       # a fresh folder
 *   npm run backup:media -- --cloud --into local-data/backups/media-2026-09-08
 */

import fs from 'node:fs';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';

const args = process.argv.slice(2);
const cloud = args.includes('--cloud');
const into = args.find((a, i) => args[i - 1] === '--into');

if (cloud) loadCloudVars();
else loadDevVars();

function fail(message) {
  console.error(`\n  ${message.replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

const need = (name) => {
  const value = process.env[name];
  if (!value) fail(`${name} is needed. See .dev.vars.example; the cloud values live in .cloud.vars.`);
  return value;
};

const account = need('R2_ACCOUNT_ID');
const bucket = need('R2_BUCKET');
const client = new AwsClient({
  accessKeyId: need('R2_ACCESS_KEY_ID'),
  secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
  service: 's3',
  region: 'auto',
});
const base = `https://${account}.r2.cloudflarestorage.com/${bucket}`;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = into ?? path.join('local-data/backups', `media-${cloud ? 'cloud' : 'local'}-${stamp}`);
fs.mkdirSync(dir, { recursive: true });

/* The manifest: key, size, etag, so the next run can skip what it has
   and a restore can check what it copied. */
const manifestPath = path.join(dir, 'manifest.json');
const had = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
const manifest = {};

console.log(`\nMirroring ${bucket} into ${dir}\n`);

let token = null;
let copied = 0, skipped = 0, bytes = 0;
for (;;) {
  const url = new URL(base);
  url.searchParams.set('list-type', '2');
  if (token) url.searchParams.set('continuation-token', token);
  const listed = await client.fetch(url.toString());
  if (!listed.ok) fail(`Could not list ${bucket}: ${listed.status} ${listed.statusText}`);
  const xml = await listed.text();
  const items = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => {
    const c = m[1];
    const pick = (tag) => c.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '';
    return { key: pick('Key'), size: Number(pick('Size')), etag: pick('ETag').replace(/"/g, '') };
  });
  for (const it of items) {
    manifest[it.key] = { size: it.size, etag: it.etag };
    const file = path.join(dir, 'objects', it.key);
    const prior = had[it.key];
    if (prior && prior.etag === it.etag && prior.size === it.size && fs.existsSync(file) && fs.statSync(file).size === it.size) { skipped += 1; continue; }
    const got = await client.fetch(`${base}/${encodeURI(it.key)}`);
    if (!got.ok) fail(`Could not read ${it.key}: ${got.status}. The mirror is incomplete; nothing already written is a backup on its own.`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await got.arrayBuffer()));
    copied += 1;
    bytes += it.size;
  }
  const more = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  token = more ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] ?? null : null;
  if (!token) break;
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log(`  ${copied} copied (${(bytes / 1024 / 1024).toFixed(1)} MB), ${skipped} already here, ${Object.keys(manifest).length} objects in the bucket.

Written to ${dir}/objects/ with manifest.json beside it.

This folder is on one machine. Copy it somewhere else today, with the
database dump it belongs to; a document's picture is a path in the dump
and a file here, and a restore needs both.
`);
