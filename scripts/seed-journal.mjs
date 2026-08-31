#!/usr/bin/env node
/**
 * THE BACK CATALOGUE, LOADED.
 *
 * Twenty nine articles published on the club's Google Site between October
 * 2020 and July 2024, turned into permanent records at addresses that will
 * not move again (8.3). The text lives in `src/data/mvrj-archive.yaml`; this
 * file is only the loader, so correcting a title or releasing a held record
 * is an edit to data rather than to code.
 *
 * **It loads into the demonstration tenant, and that is a decision about
 * permission rather than about the data.** These are real papers by real
 * students and Monta Vista's own archive is where they eventually belong.
 * Nothing about the migration has been agreed with the school or with the
 * club yet, and a tenant nobody has approved is not the place to stand up
 * twenty six permanent addresses carrying other people's names. So the
 * default target is `demo`, where the whole tenant is understood to be a
 * demonstration and every reset wipes it. `JOURNAL_ORG=montavista` is the
 * move, and it is one variable on the day the school says yes.
 *
 * **The identifiers are throwaway until that day.** The prefix is a field on
 * the organization, so these publish as `DEMO-2024-0008` rather than
 * `MVRJ-2024-0008`. A record identifier is permanent (8.3) and these are
 * not, which is only true because the tenant they sit in is not somewhere
 * anybody has been given a link to. Moving to Monta Vista reallocates all of
 * them, once, and that is the last time it can happen.
 *
 * **It runs on the same path publishing runs on.** `assembleRecord` writes
 * the files and `records-store` writes the manifest, the same two calls the
 * publish screen makes and the same two `seed-publish.mjs` makes, so a
 * change that breaks publishing breaks this rather than leaving it to rot
 * against a copy of the format.
 *
 * **Re-running is safe.** `generate_migrated_record` hands back the
 * identifier a slug already holds rather than minting a second, so a reset,
 * a fixed typo and a released hold are all the same command.
 *
 * Run: npm run seed:journal
 */

import fs from 'node:fs';
import yaml from 'js-yaml';
import { createClient } from '@supabase/supabase-js';
import { loadDevVars } from './dev-vars.mjs';
import { loadOrgs } from './orgs-library.mjs';
import { openBucket } from './notebook-bucket.mjs';
import { assembleRecord } from '../src/lib/record-files.ts';
import { readManifest, writeManifest, upsert, keysFor } from '../src/lib/records-store.ts';
import { extractPdfText, worthIndexing } from '../src/lib/pdf-text.ts';
import { pdfFor } from './mvrj-pdfs.mjs';

loadDevVars();

const ARCHIVE = 'src/data/mvrj-archive.yaml';

/**
 * WHERE THE PAPERS THEMSELVES LIVE.
 *
 * `local-data/` and not the repository, for the same reason records live in
 * R2 and never in git: this is twenty three students' work, it is twenty
 * megabytes, and a takedown must not be a history rewrite. `local-data/` is
 * already gitignored and already holds the one other file that names real
 * people (11.7's third row).
 *
 * Absent is the ordinary case. A checkout with no PDFs publishes the same
 * twenty six records as abstracts and metadata, which is what the archive was
 * before the files arrived and is a working archive.
 */
const PDF_DIR = 'local-data/mvrj-pdfs';

/* **`demo`, until somebody has approved the real thing.**

   The tenant is not chosen because these papers are invented. They are not,
   and that is exactly why the default is the cautious one: publishing thirty
   one real bylines at Monta Vista's own address is a thing the school and
   the club get to agree to first. `demo` is wiped on every reset and is
   understood by everybody who opens it to be a demonstration, which is the
   right place for an archive whose migration has not been signed off.

   Set `JOURNAL_ORG=montavista` when it has been. The loader is unchanged by
   it; the identifiers are reallocated under that school's prefix, which is
   the one moment they may be. */
const ORG_SLUG = process.env.JOURNAL_ORG ?? 'demo';

const URL_ = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

if (!URL_ || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed. They live in .dev.vars.');
  process.exit(1);
}

const db = createClient(URL_, KEY, { auth: { persistSession: false } });
const orgs = loadOrgs();

/* The section rules the assembler checks against, read from disk because the
   registry the application uses is bundled by Vite. Every one of these is
   `body_format: none`, so no section is emitted; the shape is passed because
   the assembler asks for one. */
const imrad = yaml.load(fs.readFileSync('src/config/shapes/imrad.yaml', 'utf8'));

let store = null;
let bucket = null;

try {
  store = await openBucket({ url: URL_ });
  bucket = store?.bucket ?? null;
} catch (error) {
  console.error(`\n${error.message}\n`);
  process.exit(1);
}

async function release() {
  if (store) await store.dispose();
  store = null;
}

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

/**
 * Publication order, oldest first.
 *
 * 8.3 says the sequence is assigned in publication order, and the data file
 * is written newest first because that is how the current site lists it.
 * Sorting here rather than reordering the file keeps the file readable next
 * to the site it came from. Within one month the site's own order is kept,
 * bottom up, so the numbering is the same on every run.
 */
function inPublicationOrder(records) {
  return [...records].sort((a, b) =>
    a.published_on === b.published_on
      ? b.seq - a.seq
      : a.published_on.localeCompare(b.published_on)
  );
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

async function main() {
  if (!bucket) {
    console.log('\nNo file storage, so the archive cannot be written.\n');
    process.exit(1);
  }

  if (!fs.existsSync(ARCHIVE)) {
    throw new Error(`${ARCHIVE} is missing, and it is the archive.`);
  }

  const archive = yaml.load(fs.readFileSync(ARCHIVE, 'utf8'));
  const all = archive?.records ?? [];

  if (all.length === 0) {
    throw new Error(`${ARCHIVE} holds no records.`);
  }

  const { data: org, error: orgError } = await db
    .from('organizations')
    .select('id, slug, lockup_name')
    .eq('slug', ORG_SLUG)
    .maybeSingle();

  if (orgError) throw new Error(`Could not read the organization: ${orgError.message}`);
  if (!org) throw new Error(`No organization "${ORG_SLUG}" to publish into. Run seed:orgs first.`);

  /* The prefix is a field on the organization file and never a constant
     (8.3), which is what lets the target move without a code change: these
     read `DEMO-` today and `MVRJ-` the day `JOURNAL_ORG` says montavista. */
  const prefix = orgs[org.slug]?.recordPrefix;

  if (!prefix) {
    throw new Error(`No record prefix for "${org.slug}". Add it in src/config/orgs/.`);
  }

  console.log(`\nLoading the back catalogue into ${org.lockup_name} as ${prefix}-\n`);

  /* Absent is ordinary. A checkout with no papers publishes the same records
     as abstracts and metadata. */
  const available = new Set(
    fs.existsSync(PDF_DIR)
      ? fs
          .readdirSync(PDF_DIR)
          .filter((n) => n.toLowerCase().endsWith('.pdf'))
          /* A zip made on a Mac carries an AppleDouble beside every file.
             They are a few hundred bytes of metadata named after the paper,
             and left in they would each be reported as a delivery matching no
             record, which buries the ones that really do. */
          .filter((n) => !n.startsWith('._'))
      : []
  );

  console.log(
    available.size > 0
      ? `${available.size} papers in ${PDF_DIR}\n`
      : `No papers in ${PDF_DIR}, so these publish as abstracts and metadata.\n`
  );

  const held = [];
  const noAbstract = [];
  const noPaper = [];
  const rightsHeld = [];
  const unreadable = [];
  const claimed = new Set();
  let written = 0;

  for (const row of inPublicationOrder(all)) {
    if (row.publish === false) {
      held.push(row);
      continue;
    }

    /* **Open decision 4, enforced rather than remembered.**

       A paper a conference published first carries its metadata and its
       abstract here, which is the landing page 4.4 describes. Its full text
       is a rights question nobody has answered, and a rule written only in a
       comment is not a rule (19.9). Two ways in, so both are shut: a row that
       names one in the data, which is a mistake, and a file sitting in the
       directory, which is not. */
    if (row.prior_venue && row.pdf_path) {
      throw new Error(
        `${row.slug} names a prior venue (${row.prior_venue}) and carries a full text. ` +
          'Open decision 4 has to be settled before that file is published.'
      );
    }

    if (!row.abstract) noAbstract.push(row);

    const file = pdfFor(row, available);
    if (file) claimed.add(file);

    /* Everything the paper contributes, decided before the record exists so
       the allocation is one statement rather than a row edited afterwards. */
    let pdfKey = null;
    let pdfBytes = null;
    let pdfText = null;

    if (file && row.prior_venue) {
      rightsHeld.push(row);
    } else if (file) {
      pdfBytes = fs.readFileSync(`${PDF_DIR}/${file}`);
      pdfKey = keysFor(org.slug, {
        recordKind: 'article',
        year: Number(row.published_on.slice(0, 4)),
        slug: row.slug,
      }).pdf;

      /* **Indexed, never rendered.** `pdf-text` is a deliberately modest
         extractor and says so: no custom font encodings, no column ordering.
         `worthIndexing` is what decides, because a scanned page yields a
         handful of stray characters and putting those in a search index is
         worse than putting nothing there — the record then appears for
         queries it has no bearing on. A refusal is printed rather than
         swallowed, so a paper that is in the archive and not in the index is
         a fact somebody can see. */
      const extracted = await extractPdfText(new Uint8Array(pdfBytes));

      if (worthIndexing(extracted)) {
        pdfText = extracted.text;
      } else {
        unreadable.push(row);
      }
    } else {
      noPaper.push(row);
    }

    const { data: recordId, error } = await db.rpc('generate_migrated_record', {
      p_org_slug: org.slug,
      p_prefix: prefix,
      p_slug: row.slug,
      p_title: row.title,
      p_authors: row.authors ?? [],
      p_published_on: row.published_on,
      p_date_precision: row.date_precision ?? 'month',
      p_abstract: row.abstract ?? null,
      p_keywords: row.keywords ?? [],
      p_discipline: row.discipline ?? 'unclassified',
      /* One answer for all of them, and the reason is in the archive file:
         nobody asked these authors to choose a licence, so we do not choose
         a permissive one on their behalf. */
      p_license: row.license ?? 'All rights reserved',
      p_prior_venue: row.prior_venue ?? null,
      p_body_format: pdfKey ? 'pdf-only' : 'none',
      p_pdf_path: pdfKey,
      p_pdf_text: pdfText,
      p_external_url: row.external_url ?? null,
    });

    if (error) throw new Error(`${row.slug}: ${error.message}`);

    const { data: record, error: readError } = await db
      .from('records')
      .select('*')
      .eq('id', recordId)
      .maybeSingle();

    if (readError || !record) {
      throw new Error(`${row.slug}: allocated ${recordId} and could not read it back`);
    }

    /* **The bytes go in before the record is assembled, at the key the record
       will name.**

       `assembleRecord` copies whatever `pdf_path` points at into the record's
       own prefix, so that a school taking its archive takes whole records
       rather than pointers into a working bucket. A migrated paper has no
       working bucket to be copied out of — it arrives from a directory on
       somebody's laptop — so it is written straight to its destination and
       the copy is a read and a rewrite of the same key. That is one object
       rather than two, and it keeps the assembler's own check: a file named
       by a record and absent from storage comes back in `missing`, and the
       throw below is what stops a record publishing a dead link. */
    if (pdfKey) {
      await bucket.put(pdfKey, normalize(pdfBytes), {
        httpMetadata: { contentType: 'application/pdf' },
      });
    }

    const { files, entry, missing } = await assembleRecord(db, blob, org.slug, record, imrad);

    if (missing.length > 0) {
      throw new Error(`${row.slug}: ${missing.join(', ')} could not be read from storage`);
    }

    for (const file of files) {
      await bucket.put(file.key, normalize(file.body), {
        httpMetadata: { contentType: file.contentType },
      });
    }

    const manifest = await readManifest(bucket, org.slug);
    await writeManifest(bucket, upsert(manifest, entry));

    const { error: confirmError } = await db.rpc('confirm_migrated_record', {
      p_record_id: recordId,
    });

    if (confirmError) {
      throw new Error(`${row.slug}: written but not confirmed (${confirmError.message})`);
    }

    written += 1;
    console.log(`  ${recordId}  ${row.title.slice(0, 68)}`);
  }

  const withPaper = written - noPaper.length - rightsHeld.length;
  console.log(`\n${written} of ${all.length} articles are in the archive.`);
  console.log(`${withPaper} of them carry the paper itself.`);

  /* **Held records are printed, not passed over quietly.**

     A seed that silently publishes twenty six of twenty nine is a seed that
     teaches somebody the number is twenty six. Each of these is waiting on a
     decision in section 4, and the decision is somebody's to take. */
  if (held.length > 0) {
    console.log(`\n${held.length} held, each waiting on a decision:\n`);
    for (const row of held) {
      console.log(`  ${row.slug}`);
      console.log(`    ${row.hold_reason?.trim() ?? 'No reason recorded.'}\n`);
    }
  }

  if (rightsHeld.length > 0) {
    console.log(
      `\n${rightsHeld.length} published without the paper, because somebody else published it first:\n`
    );
    for (const row of rightsHeld) {
      console.log(`  ${row.slug}\n    ${row.prior_venue}. Open decision 4, the version of record.\n`);
    }
  }

  if (noPaper.length > 0) {
    console.log(
      `\n${noPaper.length} published with no paper found in ${PDF_DIR}:\n` +
        noPaper.map((r) => `  ${r.slug}\n    looked for ${r.source_pdf}`).join('\n') +
        '\n'
    );
  }

  /* Named, because a paper in the archive and absent from search is a thing
     somebody will otherwise discover by failing to find it. */
  if (unreadable.length > 0) {
    console.log(
      `\n${unreadable.length} carry the paper but no searchable text:\n` +
        unreadable.map((r) => `  ${r.slug}`).join('\n') +
        '\n  Readable as PDFs. Their bodies are not in the search index.\n'
    );
  }

  const spare = [...available].filter((name) => !claimed.has(name));
  if (spare.length > 0) {
    console.log(
      `\n${spare.length} file(s) in ${PDF_DIR} matched no record:\n` +
        spare.map((n) => `  ${n}`).join('\n') +
        '\n  Rename one to {slug}.pdf to attach it.\n'
    );
  }

  if (noAbstract.length > 0) {
    console.log(
      `${noAbstract.length} published with no abstract: ${noAbstract.map((r) => r.slug).join(', ')}.`
    );
    console.log("An abstract is the author's to supply. Nothing here invents one.\n");
  }

  /* **Said accurately, because the reset already does it.**

     This read "Search needs `npm run index:records`", copied from
     `seed-publish`, and inside a reset that is a message telling somebody a
     step was skipped when the very next line of the chain runs it. The
     showcase, the article pages, the author pages and the topic pages read
     the manifest at request time and need nothing further; only `/search/`
     reads the index. */
  console.log('The showcase and the article, author and topic pages read this now.');
  console.log('`/search/` reads the index, which `npm run reset` rebuilds next.');
  console.log('Running this loader on its own, follow it with `npm run index:records`.\n');
}

main()
  .then(release)
  .catch(async (e) => {
    await release();
    console.error(e.message);
    process.exit(1);
  });
