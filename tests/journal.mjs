/**
 * Tests for the back catalogue.
 *
 * `src/data/mvrj-archive.yaml` is the one place four years of the journal
 * exists in machine-readable form, and the loader turns each row into a
 * permanent URL and a permanent identifier. Neither can be corrected after
 * the fact without a redirect nobody can issue, so the checks that matter
 * are the ones about shape: a slug that is not a slug, a discipline the
 * taxonomy has never heard of, a byline with nobody in it.
 *
 * The database is not needed for any of this. The rows and the wiring are
 * both files.
 *
 * Run: npm run test:journal
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { disciplines } from '../src/config/site.ts';
import { slugName } from '../src/lib/record-files.ts';
import { prefixFor, keysFor, manifestKey, assetUrl, RECORDS_ROOT } from '../src/lib/records-store.ts';
import { pdfFor } from '../scripts/mvrj-pdfs.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

const ARCHIVE = 'src/data/mvrj-archive.yaml';
const archive = yaml.load(fs.readFileSync(ARCHIVE, 'utf8'));
const records = archive?.records ?? [];

/* ── The archive is all there ───────────────────────────────────────────── */

/**
 * Twenty nine, and the number is asserted rather than counted.
 *
 * Section 4.1 says twenty eight and then breaks the years down as
 * 1 + 5 + 7 + 6 + 10, which is twenty nine, and the inventory has twenty
 * nine rows. A count nobody pins down is a count that quietly loses a paper
 * during an edit, and the paper that goes missing is the one nobody notices
 * is gone.
 */
test('twenty nine articles, and the year breakdown adds up to them', () => {
  assert.equal(records.length, 29);

  const byYear = {};
  for (const r of records) {
    const year = Number(r.published_on.slice(0, 4));
    byYear[year] = (byYear[year] ?? 0) + 1;
  }

  assert.deepEqual(byYear, { 2020: 1, 2021: 5, 2022: 7, 2023: 6, 2024: 10 });
});

test('every row carries the fields a record cannot be made without', () => {
  for (const r of records) {
    assert.ok(r.seq, 'a row with no inventory number');
    assert.ok(r.slug, `${r.seq}: no slug`);
    assert.ok(r.title?.trim(), `${r.seq}: no title`);
    assert.ok(Array.isArray(r.authors) && r.authors.length > 0, `${r.slug}: no byline`);
    assert.ok(r.source_pdf, `${r.slug}: no source filename to match a recovered file against`);
  }
});

test('every author has a name', () => {
  for (const r of records) {
    for (const a of r.authors) {
      assert.ok(a.name?.trim(), `${r.slug}: an author with no name`);
    }
  }
});

/* ── Addresses that can never move ──────────────────────────────────────── */

test('slugs are unique across the archive', () => {
  const seen = new Map();
  for (const r of records) {
    assert.ok(!seen.has(r.slug), `${r.slug} is used by rows ${seen.get(r.slug)} and ${r.seq}`);
    seen.set(r.slug, r.seq);
  }
  assert.equal(seen.size, 29);
});

test('a slug is lowercase ASCII, hyphenated, and inside the length rule', () => {
  for (const r of records) {
    assert.match(r.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${r.slug} is not a slug`);
    /* 8.3: truncated at 72 characters on a word boundary. */
    assert.ok(r.slug.length <= 72, `${r.slug} is ${r.slug.length} characters`);
  }
});

test('a date is a real ISO day and its precision is one of the two', () => {
  for (const r of records) {
    assert.match(r.published_on, /^\d{4}-\d{2}-\d{2}$/, `${r.slug}: ${r.published_on}`);
    assert.ok(!Number.isNaN(Date.parse(r.published_on)), `${r.slug}: unparseable date`);
    assert.ok(
      ['month', 'day'].includes(r.date_precision),
      `${r.slug}: ${r.date_precision} is not a precision`
    );
  }
});

/* ── Classification ─────────────────────────────────────────────────────── */

test('every discipline is one the taxonomy publishes', () => {
  const known = new Set(disciplines.map((d) => d.slug));
  for (const r of records) {
    assert.ok(known.has(r.discipline), `${r.slug}: ${r.discipline} is not in the taxonomy`);
  }
});

/**
 * The point of classifying by domain rather than by method (8.2).
 *
 * Two thirds of this archive applies machine learning to something, so a
 * taxonomy that has collapsed back onto the method shows up here as one
 * discipline swallowing the archive. Asserting the spread rather than the
 * absence of a bad value, which is 19.9's rule about tests that only ever
 * check that nothing is wrong.
 */
test('the classification spreads across the taxonomy rather than collapsing', () => {
  const used = new Set(records.map((r) => r.discipline));
  assert.ok(used.size >= 7, `only ${used.size} disciplines used`);

  const counts = {};
  for (const r of records) counts[r.discipline] = (counts[r.discipline] ?? 0) + 1;
  const biggest = Math.max(...Object.values(counts));
  assert.ok(biggest <= 10, `one discipline holds ${biggest} of ${records.length}`);
});

test('keywords are three to six, as the submission form asks', () => {
  for (const r of records) {
    assert.ok(Array.isArray(r.keywords), `${r.slug}: no keywords`);
    assert.ok(
      r.keywords.length >= 3 && r.keywords.length <= 6,
      `${r.slug}: ${r.keywords.length} keywords`
    );
    for (const k of r.keywords) assert.ok(k?.trim(), `${r.slug}: an empty keyword`);
  }
});

/* ── What is deliberately absent ────────────────────────────────────────── */

/**
 * Exactly two, and they are named.
 *
 * `abstract: null` is a real state: two articles have no abstract on the
 * current site and inventing one is worse than saying so. Naming the two
 * means a third appearing is a transcription that was dropped rather than a
 * fact about the archive.
 */
test('two articles have no abstract, and they are the two that never had one', () => {
  const missing = records.filter((r) => !r.abstract).map((r) => r.slug).sort();
  assert.deepEqual(missing, [
    'looping-and-divergence-in-the-collatz-conjecture',
    'machine-learning-exoplanet-prediction-transit-method',
  ]);
});

test('every other abstract is substantial rather than a placeholder', () => {
  for (const r of records) {
    if (!r.abstract) continue;
    assert.ok(r.abstract.length > 200, `${r.slug}: a ${r.abstract.length} character abstract`);
  }
});

test('a held record says why it is held', () => {
  const held = records.filter((r) => r.publish === false);
  assert.equal(held.length, 3, `${held.length} held`);

  for (const r of held) {
    assert.ok(r.hold_reason?.trim(), `${r.slug} is held and gives no reason`);
    assert.ok(r.hold_reason.length > 40, `${r.slug}: the reason is too short to act on`);
  }
});

test('publish is either absent or an explicit false, never a stray truthy string', () => {
  for (const r of records) {
    assert.ok(
      r.publish === undefined || r.publish === false,
      `${r.slug}: publish is ${JSON.stringify(r.publish)}`
    );
  }
});

/**
 * Open decision 4, which the loader enforces and this states.
 *
 * Three papers appeared somewhere before this journal. Their metadata and
 * their abstracts are ours to publish; their full text is a rights question
 * nobody has answered. The loader throws on the pair, so the archive must
 * never be edited into the state that throws.
 */
test('no record carries both a prior venue and a full text', () => {
  const withVenue = records.filter((r) => r.prior_venue);
  assert.equal(withVenue.length, 3, `${withVenue.length} records name a prior venue`);

  for (const r of withVenue) {
    assert.ok(!r.pdf_path, `${r.slug} names ${r.prior_venue} and carries a full text`);
  }
});

/* ── Author pages, which are the reason for migrating ───────────────────── */

/**
 * 4.1's argument for doing this at all: eight authors already have a
 * bibliography rather than a single item. That only holds if a repeat author
 * is spelled the same way every time, since the author page is keyed on the
 * slug of the byline.
 */
test('the repeat authors resolve to one page each', () => {
  const counts = new Map();

  for (const r of records) {
    for (const a of r.authors) {
      if (a.byline_only) continue;
      const slug = slugName(a.name);
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }

  assert.equal(counts.get('christopher-sun'), 4);
  assert.equal(counts.get('jai-sharma'), 4);
  assert.equal(counts.get('milind-maiti'), 3);
  assert.equal(counts.get('aryan-singhal'), 2);
  assert.equal(counts.get('raymond-feng'), 2);
  assert.equal(counts.get('advaith-anand'), 2);
  assert.equal(counts.get('tyler-rose'), 2);

  /* Seven here rather than 4.1's eight, and the missing one is Navvye Anand,
     who is on PLAPT and WaterGate and is byline-only in both. An author from
     outside the school having two papers does not give them a page. */
  const repeats = [...counts.values()].filter((n) => n > 1).length;
  assert.equal(repeats, 7, `${repeats} authors appear more than once`);
});

/**
 * Thirty one distinct people, where 4.1 counted thirty.
 *
 * The same off-by-one as the article count: 4.1's prose says twenty eight
 * articles and thirty authors, and its own year breakdown, the inventory and
 * the page all hold twenty nine articles and thirty one names. Both prose
 * figures are one low, which is what a summary written before the last row
 * was added looks like.
 *
 * Asserted because a byline is where a transcription slip hides: one name
 * spelled two ways splits a bibliography in half and nothing errors.
 */
test('thirty one distinct authors across the archive', () => {
  const names = new Set(records.flatMap((r) => r.authors.map((a) => slugName(a.name))));
  assert.equal(names.size, 31, [...names].sort().join(', '));
});

test('a co-author from outside the school is marked, and gets no author page', () => {
  const outside = records
    .flatMap((r) => r.authors)
    .filter((a) => a.byline_only);

  assert.ok(outside.length >= 4, `${outside.length} bylines are marked as outside`);
  for (const a of outside) {
    assert.ok(!a.school, `${a.name} is byline-only and also claims a school`);
  }
});

/**
 * The clause that used to take the author pages away.
 *
 * `record-files.ts` gated `authorSlug` on `a.user_id`, which is null for
 * every author in this archive, so all thirty would have published as plain
 * text. The anchor is required to be found and to be unique, because 19.9
 * records two checks that passed by measuring a region that had moved.
 */
test('an author page depends on the byline rather than on holding an account', () => {
  const source = fs.readFileSync('src/lib/record-files.ts', 'utf8');
  const anchor = 'authorSlug: a.byline_only';

  const first = source.indexOf(anchor);
  assert.notEqual(first, -1, 'the authorSlug assignment was not found');
  assert.equal(source.indexOf(anchor, first + 1), -1, 'the anchor is not unique');

  const line = source.slice(first, source.indexOf('\n', first));
  assert.ok(!line.includes('user_id'), `an account still decides the author page: ${line.trim()}`);
});

/* ── The wiring ─────────────────────────────────────────────────────────── */

/**
 * A seed nothing runs is a seed that rots.
 *
 * Checked in both places, because they are two lists and the whole reason
 * `reset-cloud` exists as a separate file is that the two once disagreed
 * about what a reset does (19.6b).
 */
test('the loader runs on a local reset and on a cloud reset', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  assert.ok(pkg.scripts['seed:journal'], 'no seed:journal script');
  assert.match(pkg.scripts.reset, /seed-journal\.mjs/, 'the local reset does not load the archive');
  assert.match(pkg.scripts.test, /test:journal/, 'the suite does not run these assertions');

  const cloud = fs.readFileSync('scripts/reset-cloud.mjs', 'utf8');
  assert.match(cloud, /scripts\/seed-journal\.mjs/, 'the cloud reset does not load the archive');
});

/**
 * The two resets have to name the same tenant.
 *
 * 19.6b's lesson, in the one place it could recur: `reset-cloud` set
 * `DEMO_ORGS` at every step for months while local defaulted to all four
 * schools, so the same scripts built two different databases and the whole
 * difference lived in a variable nobody set locally. This loader has the
 * same shape -- a default in the script and an override in the cloud list --
 * so the two are held together here rather than by everybody remembering.
 *
 * `demo` rather than `montavista` while the migration is unapproved. When
 * the school agrees, both sides of this assertion move at once, which is the
 * point of asserting the pair rather than either one.
 */
test('the local default and the cloud reset load into the same tenant', () => {
  const loader = fs.readFileSync('scripts/seed-journal.mjs', 'utf8');
  const cloud = fs.readFileSync('scripts/reset-cloud.mjs', 'utf8');

  const fallback = loader.match(/process\.env\.JOURNAL_ORG \?\? '([a-z0-9-]+)'/);
  assert.ok(fallback, 'the loader has no JOURNAL_ORG default to check');

  const named = cloud.match(/JOURNAL_ORG: '([a-z0-9-]+)'/);
  assert.ok(named, 'the cloud reset does not name a tenant for the archive');

  assert.equal(
    fallback[1],
    named[1],
    `local loads into ${fallback[1]} and the cloud loads into ${named[1]}`
  );
  assert.equal(fallback[1], 'demo', 'the archive is not in the demonstration tenant');
});

test('the archive loads before the search index is built', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const reset = pkg.scripts.reset;
  assert.ok(
    reset.indexOf('seed-journal.mjs') < reset.indexOf('index-records.mjs'),
    'the index is built before the records exist, so the archive is unsearchable'
  );

  const cloud = fs.readFileSync('scripts/reset-cloud.mjs', 'utf8');
  assert.ok(
    cloud.indexOf('seed-journal.mjs') < cloud.indexOf('index-records.mjs'),
    'the cloud index is built before the records exist'
  );
});

/**
 * The allocator and the confirm both exist, and neither is reachable from a
 * browser. The grant is the whole authorisation story for these two, so an
 * accidental `to authenticated` is the failure worth naming.
 */
test('the migrated record functions are granted to the service role alone', () => {
  const sql = fs.readFileSync('supabase/migrations/0001_identity_and_tenancy.sql', 'utf8');

  for (const fn of ['generate_migrated_record', 'confirm_migrated_record']) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}`), `${fn} is missing`);

    const grants = [...sql.matchAll(new RegExp(`grant execute on function[^;]*${fn}[^;]*;`, 'g'))];
    assert.equal(grants.length, 1, `${fn} has ${grants.length} grants`);
    assert.match(grants[0][0], /to service_role;$/, `${fn} is granted beyond the service role`);

    const revokes = [...sql.matchAll(new RegExp(`revoke execute on function[^;]*${fn}[^;]*;`, 'g'))];
    assert.equal(revokes.length, 1, `${fn} is never revoked from the default grantees`);
    assert.match(revokes[0][0], /anon/, `${fn} is not revoked from anon`);
    assert.match(revokes[0][0], /authenticated/, `${fn} is not revoked from authenticated`);
  }
});

/* ── Where the archive is written, versus where it is read ──────────────── */

/**
 * The bug that made a full archive render as *Nothing published yet*.
 *
 * Every reader keys the store on `activeOrg(...).id`, which is the slug out
 * of `src/config/orgs/`. Both seeds read their organization out of the
 * database and passed `org.id` from there, which is the uuid primary key. The
 * expression matched and the value did not, so the seeds wrote an archive at
 * an address no page ever looks at, `index-records` indexed it under the same
 * wrong prefix, and nothing anywhere reported a failure.
 */
test('the store refuses a row id where a slug belongs', () => {
  assert.throws(
    () => prefixFor('86ea5a23-fd72-458d-ba46-4fba7b6a1d93'),
    /slug/,
    'a uuid was accepted as an organization key'
  );
});

test('and a slug still works, or the rule above proves nothing', () => {
  assert.equal(prefixFor('demo'), 'records/demo');
  assert.equal(manifestKey('demo'), 'records/demo/manifest.json');
  assert.equal(
    keysFor('demo', { recordKind: 'article', year: 2024, slug: 'qvista' }).body,
    'records/demo/articles/2024/qvista/record.md'
  );
});

/**
 * Asserted on the source because the seeds need a database to run and this
 * failure is invisible when they do: they print identifiers, exit zero, and
 * leave every page empty.
 */
test('both seeds key the record store by slug rather than by row id', () => {
  for (const path of ['scripts/seed-publish.mjs', 'scripts/seed-journal.mjs']) {
    const source = fs.readFileSync(path, 'utf8');

    const calls = [...source.matchAll(/(?:readManifest\(bucket|assembleRecord\([^)]*?blob), (org\.\w+)/g)];
    assert.equal(calls.length, 2, `${path}: found ${calls.length} store calls, expected 2`);

    for (const [, argument] of calls) {
      assert.equal(argument, 'org.slug', `${path} passes ${argument} to the record store`);
    }
  }
});

/**
 * A rebuilt database beside an untouched bucket is the orphan case, and the
 * dependency runs backwards: the files cannot be emptied without the R2
 * variables, so the moment to find out is before the database is dropped.
 * `reset-cloud` used to discover it three steps afterwards and print a line.
 */
test('the cloud reset refuses before it drops anything it cannot finish', () => {
  const cloud = fs.readFileSync('scripts/reset-cloud.mjs', 'utf8');

  const refusal = cloud.indexOf('not set, so file storage cannot be emptied');
  assert.notEqual(refusal, -1, 'the reset never refuses over file storage');
  assert.equal(
    cloud.indexOf('not set, so file storage cannot be emptied', refusal + 1),
    -1,
    'the anchor is not unique'
  );

  /* Ahead of the destruction, which is the whole point. `TABLES` is the
     truncate list and the first thing that touches the project. */
  const destroys = cloud.indexOf('const TABLES = [');
  assert.notEqual(destroys, -1, 'the truncate list moved, so this check reads nothing');
  assert.ok(refusal < destroys, 'the refusal comes after the database is already being rebuilt');

  /* And a way through for somebody who means it, or the rule is one people
     work around by editing the script. */
  assert.match(cloud, /--keep-storage/, 'there is no deliberate way to keep the bucket');
});

/* ── The papers themselves ──────────────────────────────────────────────── */

/**
 * The filenames that actually arrived, written down.
 *
 * The papers live in `local-data/`, gitignored, so a checkout and CI have no
 * directory to read. This list is the delivery, recorded so the matching can
 * be proved without the bytes — which is the half that goes wrong. Six of the
 * twenty nine were too large to send and are named below rather than left as
 * a smaller number nobody can account for.
 */
const DELIVERED = [
  "A_Deep_Learning_Ensemble_Framework_for_Off_Nadir_Geocentric_Pose_Prediction.pdf",
  "Aryan Singhal Research Paper 2023 - Aryan Singhal.pdf",
  "Correcting_Mislabeled_Quasars_in_Extragalactic_Catalogs_3_1.pdf",
  "Drought Transformer - Aaryan Doshi (1).pdf",
  "Epigenetic Aging Paper - Rishab Perati.pdf",
  "Final Research Paper 2021.pdf",
  "IYRC_RaymondFeng_Paper_FINAL.docx - Google Docs.pdf",
  "Iona Xia Research Club Paper (2020-2021).pdf",
  "Leveraging_Machine_Learning_and_Model_Agnostic_Explanations_to_Understand_Automated_Diagnosis_of_Cardiovascular_Disease.pdf",
  "Looping_and_Divergence_in_the_Collatz_Conjecture__Version_2_.pdf",
  "MVRC The Effect of Iron as a Potential Inducer of Cataracts_ Ethan Liu.pdf",
  "MVRJ Paper_ Praneel Shah - praneel shah.pdf",
  "Multi-Source Flood Mapping - Advaith Anand.pdf",
  "Particle Geodesics in the Kerr Spacetime - Jenna Vandyke.pdf",
  "QViSTA.pdf",
  "RaymondFeng_MusicEEG.pdf",
  "Research Document - Google Docs.pdf",
  "Research Paper (2).pdf",
  "Research Paper - Tanisha.pdf",
  "Research Paper 2022 - Exoplanets.pdf",
  "Tyler_PLAPT.pdf",
  "final research paper -- tashvi bansal -- mvrj (1) - Tashvi Bansal.pdf",
  "research_paper_Yashnil_Saha.pdf"
];

test('every delivered paper is claimed by exactly one record', () => {
  const available = new Set(DELIVERED);
  const claimed = new Map();

  for (const r of records) {
    const file = pdfFor(r, available);
    if (!file) continue;
    assert.ok(!claimed.has(file), `${file} is claimed by ${claimed.get(file)} and ${r.slug}`);
    claimed.set(file, r.slug);
  }

  const spare = DELIVERED.filter((n) => !claimed.has(n));
  assert.deepEqual(spare, [], 'a delivered paper matched no record');
});

/**
 * Named rather than counted, for the same reason the abstracts are: six
 * missing is a number, and these six are a list somebody can go and fetch.
 */
test('six records have no paper yet, and they are these six', () => {
  const available = new Set(DELIVERED);
  const without = records.filter((r) => !pdfFor(r, available)).map((r) => r.slug).sort();

  assert.deepEqual(without, [
    'adversarial-networks-data-efficiency-self-driving-cars',
    'alternative-spliced-multiple-myeloma-cells-tunicamycin',
    'deep-learning-automatic-ergonomic-assessment-webcam',
    'dropout-regularization-and-model-complexity-in-neural-networks',
    'multispectral-satellite-imagery-south-american-wildfires',
    'watergate-accessible-computational-model-of-flooding-patterns',
  ]);
});

test('a file renamed to the record address wins over the original name', () => {
  const row = records.find((r) => r.slug === 'qvista-quantum-vision-transformer-alzheimers');
  assert.equal(pdfFor(row, new Set(['QViSTA.pdf'])), 'QViSTA.pdf');
  assert.equal(
    pdfFor(row, new Set(['QViSTA.pdf', `${row.slug}.pdf`])),
    `${row.slug}.pdf`,
    'the address-named file should win'
  );
});

/* A browser downloading the same name twice writes `… (1).pdf`, and one of
   the twenty three arrived that way. */
test('a duplicate-download suffix still matches', () => {
  const row = records.find((r) => r.slug === 'deep-learning-pipeline-drought-assessment-vision-transformers');
  assert.equal(row.source_pdf, 'Drought Transformer - Aaryan Doshi.pdf');
  assert.equal(
    pdfFor(row, new Set(['Drought Transformer - Aaryan Doshi (1).pdf'])),
    'Drought Transformer - Aaryan Doshi (1).pdf'
  );
});

/**
 * Two downloads of the same paper is a person's question, not a resolver's.
 * Picking one would attach a file nobody chose to a permanent address.
 */
test('two candidates for one record is refused rather than guessed', () => {
  const row = records.find((r) => r.slug === 'deep-learning-pipeline-drought-assessment-vision-transformers');
  assert.throws(
    () =>
      pdfFor(
        row,
        new Set([
          'Drought Transformer - Aaryan Doshi (1).pdf',
          'Drought Transformer - Aaryan Doshi (2).pdf',
        ])
      ),
    /could be its paper/
  );
});

/* A title with regex metacharacters in its filename must not become a
   pattern. `Research Paper (2).pdf` is one of the delivered names. */
test('a filename with brackets in it is matched literally', () => {
  const row = records.find((r) => r.slug === 'identifying-lead-free-perovskites-for-high-efficiency-solar-cells');
  assert.equal(row.source_pdf, 'Research Paper (2).pdf');
  assert.equal(pdfFor(row, new Set(['Research Paper (2).pdf'])), 'Research Paper (2).pdf');
  assert.equal(pdfFor(row, new Set(['Research Paper 2.pdf'])), null, 'brackets were read as a group');
});

/**
 * Open decision 4 again, now that the files are here. The three papers with a
 * prior venue have their PDFs in the delivery, and the loader must publish
 * them as abstract-and-metadata anyway until the version of record is
 * settled. Two of the three arrived; the wildfire paper did not.
 */
test('the prior-venue papers are the ones whose files are deliberately unused', () => {
  const available = new Set(DELIVERED);
  const held = records
    .filter((r) => r.prior_venue && pdfFor(r, available))
    .map((r) => r.slug)
    .sort();

  assert.deepEqual(held, [
    'multi-source-data-fusion-flood-mapping',
    'pillar-based-overhang-generation-3d-printing',
  ]);
});

/* ── The address an asset is actually served at ─────────────────────────── */

/**
 * **The round trip, because the two halves are in different files.**
 *
 * `assetUrl` writes the address into the manifest and `/records/[...key]`
 * turns it back into a storage key by prepending `records/{slug}/` from the
 * hostname. Asserting a literal string would prove one half; composing them
 * proves they agree, which is what failed: `assetUrl` left the organization
 * in the URL and the route added it again, so every PDF resolved to
 * `records/demo/demo/…` and answered *Not found*.
 */
test('an asset URL composes back into the key it came from', () => {
  const keys = keysFor('demo', {
    recordKind: 'article',
    year: 2024,
    slug: 'qvista-quantum-vision-transformer-alzheimers',
  });

  const url = assetUrl(keys.pdf);

  /* What the route receives as `[...key]`, and what it does with it. */
  const routeParam = url.replace(`/${RECORDS_ROOT}/`, '');
  assert.equal(`${RECORDS_ROOT}/demo/${routeParam}`, keys.pdf);
});

/**
 * The organization must not be in the address. `/records/[...key]` prepends
 * the prefix from the hostname precisely so a reader cannot name one, and a
 * URL that carries it is a URL somebody can edit.
 */
test('an asset URL never names the organization', () => {
  const keys = keysFor('demo', { recordKind: 'article', year: 2024, slug: 'a-paper' });
  assert.equal(assetUrl(keys.pdf), '/records/articles/2024/a-paper/a-paper.pdf');
  assert.ok(!assetUrl(keys.pdf).includes('/demo/'), 'the slug is in the public address');

  assert.equal(
    assetUrl(keys.figure(2, 'png')),
    '/records/articles/2024/a-paper/fig-2.png'
  );
});

test('a key that is not a store key has no address, and says so', () => {
  assert.throws(() => assetUrl('notebook/demo/whatever.pdf'), /record store/);
  assert.throws(() => assetUrl('records/demo'), /record store/);
});

console.log(`${passed} journal assertions passed.`);
