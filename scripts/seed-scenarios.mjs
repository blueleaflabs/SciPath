/**
 * SCENARIO FIXTURES.
 *
 * `seed-demo.mjs` creates the people. This creates the situations, because a
 * cast of ten accounts and nothing to look at demonstrates nothing.
 *
 * Nine projects, each chosen to exercise a path that is otherwise hard to
 * reach by clicking: a project that is already disqualified, one that will be
 * unless somebody moves a date, one overdue, one an officer runs for herself,
 * one with two authors, one selected for the fair and one turned down. The
 * point is to be able to sign in as four different people and see four
 * different, true pictures.
 *
 * Runs after seed-demo.mjs and inherits its guards. Idempotent: it does
 * nothing if the school already has projects, so running it twice is safe and
 * `npm run reset` is the way to start over.
 *
 * Usage:  node scripts/seed-scenarios.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars } from './dev-vars.mjs';
import { actingAs, signOutAll } from './act-as.mjs';
import { placeholderSvg, PLACEHOLDER_CAPTIONS } from './placeholder-image.mjs';

loadDevVars();

const URL = process.env.PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SECRET_KEY ?? '';
const ORG_SLUG = process.env.DEMO_ORG ?? 'montavista';
const FIXTURE_DOMAIN = 'demo.invalid';
const PRODUCTION_REF = 'mejibvorrfjiadnsvkyu';

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/**
 * A write that must have worked.
 *
 * Twenty-four writes in this file, and the ones that ignored their result
 * were indistinguishable from the ones that could not fail. A delete refused
 * by a foreign key looked like nothing at all until the next insert collided
 * with the row that should have gone.
 *
 * `fail` rather than a warning: a half-seeded database is worse than no
 * database, because everything after it looks like a different bug.
 */
async function must(builder, what) {
  const { data, error } = await builder;
  if (error) fail(`${what}: ${error.message}`);
  return data;
}

if (!URL || !KEY) {
  fail(
    'PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are missing.\n' +
      'They normally come from .dev.vars, which this script reads on its own.\n' +
      'If that file is absent, run npx supabase start and copy the URL and\n' +
      'secret key it prints into it.'
  );
}

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL) || URL.includes(PRODUCTION_REF)) {
  fail('Scenario fixtures are for the local stack only.');
}

const db = createClient(URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* ── Pictures ─────────────────────────────────────────────────────────────
 *
 * The showcase is the first thing on a published page and is hard to judge
 * empty, so the fixtures carry images. Drawn rather than committed: a handful
 * of photographs in the repository would be binary blobs nobody can review in
 * a diff, each with a licence question attached, to make a fixture look nice.
 *
 * The bucket is optional. Without it everything else still seeds, which
 * matters because a checkout with no wrangler state is a normal thing.
 * ─────────────────────────────────────────────────────────────────────── */

let bucket = null;
let proxy = null;

try {
  const { getPlatformProxy } = await import('wrangler');
  proxy = await getPlatformProxy();
  bucket = proxy.env.NOTEBOOK ?? null;
} catch {
  /* No local bucket. Said once, below, rather than per image. */
}

/**
 * Shut the proxy down explicitly.
 *
 * `getPlatformProxy` starts a miniflare runtime with open handles, so a
 * script that does not dispose it prints everything it was going to print and
 * then hangs. An `exit` handler cannot help, because exit is the thing that
 * never happens. `reset-storage.mjs` disposes on both paths, which is why it
 * ends and this did not.
 */
async function releaseBucket() {
  if (proxy) await proxy.dispose();
  proxy = null;
}

async function seedImages(orgId, projectId, authorId, seedKey, howMany) {
  if (!bucket) return 0;

  for (let i = 0; i < howMany; i += 1) {
    const svg = placeholderSvg(`${seedKey}-${i}`);
    const path = `projects/${projectId}/images/placeholder-${i + 1}.svg`;

    /* A fresh ArrayBuffer: miniflare's proxy asserts on a typed array whose
       byte offset is not zero, and a Node Buffer almost never starts at
       zero. */
    await bucket.put(path, new Uint8Array(new TextEncoder().encode(svg)).buffer, {
      httpMetadata: { contentType: 'image/svg+xml' },
    });

    const { caption, alt } = PLACEHOLDER_CAPTIONS[i % PLACEHOLDER_CAPTIONS.length];

    await must(
      db.from('project_images').insert({
        org_id: orgId,
        project_id: projectId,
        position: i + 1,
        storage_path: path,
        alt,
        caption,
        uploaded_by: authorId,
      }),
      `writing project_images`
    );
  }

  return howMany;
}

/* ── Dates, all relative to today so the demo never goes stale ─────────── */

const today = new Date();
const iso = (d) => d.toISOString().slice(0, 10);
const shift = (days) => {
  const d = new Date(today);
  d.setDate(d.getDate() + days);
  return iso(d);
};

/* ── The situations ─────────────────────────────────────────────────────── */

const SCENARIOS = [
  {
    key: 'clean',
    /* Live animals, so Form 5A applies and a qualified scientist signs. */
    facts: { vertebrates: true },
    title: 'Thermal tolerance in intertidal snails',
    question: 'Does prior heat exposure change the upper thermal limit of Nucella?',
    authors: ['student.a'],
    officer: 'officer.a',
    sponsor: { name: 'mv_sponsor1', email: 'mv_sponsor1@fuhsd.org', signedDaysAgo: 30 },
    startedDaysAgo: 20,
    complete: 4,
    notes: 5,
    selection: 'selected',

    /* A recorded fair result, so there is something to publish as a project
       entry without doing it by hand first. Nothing had one, which left the
       entry queue empty on every fresh database and made the publish seed
       skip half its job silently. */
    result: {
      category: 'Animal Sciences',
      entryCode: 'ANIM041',
      placement: 'Second Award',
      advancedTo: 'California Science and Engineering Fair',
      awards: ['Ricoh Sustainable Development Award'],
    },

    images: 4,
    /* A real Creative Commons film, so the facade has something to load if
       somebody presses play. Nothing is fetched until they do. */
    video: 'https://vimeo.com/76979871',
    /* Finished, and the check should find nothing blocking. */
    manuscript: {
      write: 7,
      references: 5,
      methods: [
        'Field collection across three shore bands',
        'Continuous temperature logging',
        'Ramped thermal challenge to reattachment failure',
        'Twenty four hour survival scoring',
      ],
      dataSources: [
        'Loggers deployed in each band for six weeks',
        'Two hundred and forty animals collected across four dates',
        'Published thermal limits for the same genus',
      ],
      outputs: [
        'Reattachment failure temperatures by shore height',
        'A survival curve at thirty two degrees',
        'A within band variance estimate',
      ],
      keywords: ['thermal tolerance', 'intertidal', 'gastropods'],
      discipline: 'biology-biomedicine',
      abstract:
        'Intertidal gastropods experience a steep thermal gradient across a few vertical meters of shore, and their upper thermal limits are known to shift with acclimation history. This study asked whether exposure logged directly in the field predicts thermal tolerance measured in the laboratory, using 240 animals collected across three shore bands on four dates, with continuous temperature logging at each band for the six weeks preceding collection. Survival at thirty two degrees fell from eighty eight percent at the high shore to forty one percent at the low shore, and logged exposure above twenty five degrees predicted the temperature of reattachment failure more strongly than shore height alone. Within band variation was large enough that height predicts a population mean well and an individual animal poorly. The design is correlational and cannot separate acclimation from selection, which a transplant experiment would.',
    },
    note: 'Everything in order, including a finished manuscript.',
  },
  {
    key: 'disqualified',
    /* Daphnia are live animals too. */
    facts: { vertebrates: true },
    title: 'Microplastic uptake in Daphnia',
    question: 'Do polystyrene beads reduce Daphnia reproduction rate?',
    authors: ['student.b'],
    officer: 'officer.a',
    sponsor: { name: 'mv_sponsor2', email: 'mv_sponsor2@fuhsd.org', signedDaysAgo: 5 },
    /* Work began well before the sponsor signed. Already true, cannot be
       undone, and the reason the ordering check exists. */
    startedDaysAgo: 60,
    complete: 3,
    notes: 4,
    selection: 'candidate',
  },
  {
    key: 'planned-clash',
    /* Solvents, in a university lab. Form 3 for the chemicals and Form 1C to
       establish what the student did themselves. */
    facts: { hazardous: true, rri: true },
    title: 'Perovskite film stability under humidity cycling',
    question: 'How fast does efficiency fall with repeated humidity cycles?',
    authors: ['student.c'],
    officer: 'officer.b',
    sponsor: { name: 'mv_sponsor2', email: 'mv_sponsor2@fuhsd.org', signedDaysAgo: -20 },
    /* Plans to start before the signature is due. Not yet a problem, and
       fixable by moving one date, which is the whole point of saying so. */
    startedDaysAgo: -10,
    complete: 2,
    notes: 2,
    selection: 'candidate',
  },
  {
    key: 'overdue',
    /* Sampling four catchments, which needs a field safety plan. */
    facts: { field_work: true },
    title: 'Rainwater nitrate across four Cupertino catchments',
    question: 'Does nitrate concentration track distance from the freeway?',
    authors: ['student.d'],
    officer: 'officer.b',
    sponsor: { name: 'mv_sponsor3', email: 'mv_sponsor3@fuhsd.org', signedDaysAgo: 40 },
    startedDaysAgo: 25,
    complete: 1,
    /* Part written, so the editor shows a real 'four of thirteen'. */
    manuscript: {
      write: 3,
      references: 2,
      keywords: ['nitrate', 'stormwater'],
      discipline: 'earth-climate',
      abstract:
        'Nitrate concentrations were sampled across four catchments at increasing distance from a major freeway to test whether roadway proximity predicts rainwater nitrate loading. Samples were collected after each of six storm events.',
      contributions: null,
    },
    /* Two obligations backdated into the past and left open. */
    overdue: 2,
    notes: 3,
    selection: 'candidate',
  },
  {
    key: 'no-sponsor',
    /* Growing fungus, which counts as a potentially hazardous biological agent. */
    facts: { pha: true },
    title: 'Mycelium composites as packing foam',
    question: 'Can mycelium reach the compressive strength of expanded polystyrene?',
    authors: ['student.e'],
    officer: 'officer.c',
    sponsor: null,
    startedDaysAgo: null,
    complete: 0,
    notes: 1,
    selection: 'candidate',
    note: 'No sponsor, no start date. Needs attention rather than disqualifying.',
  },
  {
    key: 'unassigned',
    /* Nothing regulated. Three forms and no more, which is what most projects
       look like and the reason the conditional ones are worth getting right. */
    facts: {},
    title: 'Acoustic detection of bearing wear',
    question: 'Can a phone microphone detect bearing wear before failure?',
    authors: ['student.f'],
    /* Arrived finished from elsewhere. Every automated finding is advice. */
    manuscript: {
      write: 0,
      references: 0,
      source: 'external',
      bodyFormat: 'pdf-only',
      keywords: ['acoustics', 'predictive maintenance', 'bearings'],
      discipline: 'engineering-robotics',
      abstract:
        'Rolling element bearings emit a characteristic acoustic signature as they wear, well before failure. This work tests whether a phone microphone and a small convolutional model can detect that signature early enough to be useful, using recordings from a test rig run to destruction.',
    },
    officer: null,
    sponsor: { name: 'mv_sponsor1', email: 'mv_sponsor1@fuhsd.org', signedDaysAgo: 12 },
    startedDaysAgo: 8,
    complete: 2,
    notes: 2,
    selection: 'candidate',
    note: 'Sits in the assignment queue waiting for an officer.',
  },
  {
    key: 'self-managed',
    /* Raised beds, outdoors. */
    facts: { field_work: true },
    title: 'Nitrogen-fixing cover crops in raised beds',
    question: 'Does vetch outperform clover on available nitrogen after eight weeks?',
    /* An officer running a project of her own, and looking after it herself. */
    authors: ['officer.c'],
    officer: 'officer.c',
    sponsor: { name: 'mv_sponsor3', email: 'mv_sponsor3@fuhsd.org', signedDaysAgo: 15 },
    startedDaysAgo: 10,
    complete: 3,
    notes: 3,
    images: 2,
    selection: 'candidate',
    /* The second finished manuscript, so two can run through review at once
       and an editor sees a queue rather than a single item. Different prose
       from the first, deliberately: reading the same words twice tells you
       nothing about whether the screens work. */
    manuscript: {
      write: 7,
      references: 5,
      bank: 'b',
      keywords: ['cover crops', 'nitrogen', 'raised beds'],
      discipline: 'biology-biomedicine',
      abstract:
        'Legume cover crops are recommended to home gardeners on the strength of field trials that measure total nitrogen fixed, which is not the same as nitrogen the next crop can use. This study compared hairy vetch and crimson clover across twelve identically built raised beds, four per treatment plus four fallow, measuring plant available nitrogen at termination and at two week intervals for eight weeks afterward. Vetch produced roughly forty percent more dry biomass, matching the field literature, and yet clover beds held more available nitrogen at two and four weeks. The two converged at six weeks and vetch was higher at eight. The practical recommendation therefore depends on when the following crop needs the nitrogen, which is a question the usual advice does not ask. One season and twelve beds bound how far this generalizes.',
      methods: [
        'Randomized block field trial',
        'Potassium chloride extraction',
        'Spectrophotometry against a same-day standard curve',
        'Dry mass to constant weight',
      ],
      dataSources: [
        'Soil cores from twelve raised beds at five time points',
        'Aboveground biomass, dried and weighed',
        'Supplier seeding rates',
      ],
      outputs: [
        'Plant available nitrogen curves for two legume treatments',
        'A biomass to availability comparison',
        'A planting date recommendation that inverts the usual advice',
      ],
      contributions:
        'mv_officer3 designed the trial, built and planted the beds, ran every extraction and measurement, analyzed the data, and wrote the paper. mv_sponsor3 reviewed the protocol and supervised use of the spectrophotometer.',
    },
    note: 'Self managed, and a second paper ready to submit.',
  },
  {
    key: 'co-authored',
    /* A creek. */
    facts: { field_work: true },
    title: 'Low-cost turbidity sensing for creek monitoring',
    question: 'Can an LED and photodiode match a commercial turbidity meter?',
    authors: ['student.g', 'student.h'],
    /* Two authors, and the contributions statement names only one, which is
       the finding that is easy to miss by reading and trivial to catch. */
    manuscript: {
      write: 5,
      references: 5,
      keywords: ['turbidity', 'water quality', 'low-cost sensing'],
      discipline: 'engineering-robotics',
      abstract:
        'Commercial turbidity meters cost more than a school science budget allows, which puts continuous creek monitoring out of reach for most student projects. This work tests whether an LED and photodiode pair, calibrated against formazin standards, can match a commercial nephelometer across the range encountered in a local creek. Paired measurements were taken at six sites over eight weeks, spanning two storm events, and the agreement between instruments was assessed by Bland-Altman analysis rather than by correlation alone.',
      contributions:
        'mv_student7 designed the optical path, built and calibrated the sensor, ran the field comparison, and wrote the paper.',
    },
    officer: 'officer.a',
    sponsor: { name: 'mv_sponsor1', email: 'mv_sponsor1@fuhsd.org', signedDaysAgo: 22 },
    startedDaysAgo: 14,
    complete: 5,
    notes: 6,
    selection: 'selected',
    note: 'Two authors, so co-authorship and shared notebooks are visible.',
  },
  {
    key: 'not-selected',
    /* **The case that ends seasons.** A survey is human participants research,
       a great many students do not realize it, and SCVSEFA refuses a human
       participants project received after the November date outright: not
       late, not penalized, refused. */
    facts: { humans: true },
    title: 'Sleep duration and reaction time in high schoolers',
    question: 'Does self-reported sleep predict simple reaction time?',
    /* An officer running a project of her own, looked after by another
       officer. The common case, and different from the self-managed one. */
    authors: ['officer.a'],
    officer: 'officer.b',
    sponsor: { name: 'mv_sponsor2', email: 'mv_sponsor2@fuhsd.org', signedDaysAgo: 35 },
    startedDaysAgo: 28,
    complete: 6,
    notes: 4,
    selection: 'not_selected',
    selectionNote: 'Human subjects paperwork would not clear in time.',
  },
  /* ── The course ─────────────────────────────────────────────────────────
   *
   * Two projects in IRPD rather than the fair. They exist because a program
   * with no projects in it is visible and untestable, and because the whole
   * argument for the template model was that a course and a competition are
   * the same shape with different contents. If these do not work, the model
   * is wrong.
   *
   * Neither has a sponsor, a category, or a placement. A course does not
   * have those, and the interface should stop asking.
   * ─────────────────────────────────────────────────────────────────────── */
  {
    key: 'irpd-interviews',
    program: 'course',
    title: 'Why students skip breakfast at Monta Vista',
    question: 'What actually stops students eating before first period?',
    /* Interviews are human participants research, which is the one thing in
       this course with a consequence outside the classroom. */
    facts: { humans: true, minors: true },
    authors: ['student.c'],
    officer: 'officer.b',
    startedDaysAgo: 45,
    complete: 2,
    notes: 6,
    images: 2,
    manuscript: {
      write: 4,
      references: 4,
      keywords: ['food access', 'student wellbeing', 'design research'],
      discipline: 'social-science',
    },
  },
  {
    key: 'grant-applied',
    program: 'grant',
    title: 'A pocket spectrophotometer for creek monitoring',
    question: 'Can a phone camera replace a bench spectrophotometer for nitrate?',
    facts: { equipment: true },
    authors: ['student.d'],
    officer: 'officer.c',
    startedDaysAgo: 30,
    complete: 3,
    notes: 4,
    requested: 385.4,
    note:
      'A grant application partway through. The money is asked for and not ' +
      'yet decided, which is where most of them sit.',
  },
  {
    key: 'grant-awarded',
    program: 'grant',
    title: 'Low-cost turbidity logging for a school creek',
    question: 'How cheaply can turbidity be logged hourly for a season?',
    facts: { equipment: true, awarded: true },
    authors: ['student.f'],
    officer: 'officer.c',
    startedDaysAgo: 90,
    complete: 6,
    notes: 7,
    requested: 400,
    awarded: 250,
    note:
      'Awarded, and for less than was asked. A partial award is the ordinary ' +
      'outcome and the one a student has to plan around.',
  },
  {
    key: 'irpd-early',
    program: 'course',
    title: 'Shade and heat on the walk to school',
    question: 'Which routes to campus are unwalkable on a hot afternoon?',
    facts: { humans: true },
    authors: ['student.e'],
    officer: 'officer.c',
    startedDaysAgo: 20,
    complete: 0,
    notes: 2,
  },

];

/* Notebook entries, written to read like a real week rather than lorem. */
const NOTE_TEXTS = [
  '# Setup\n\nBuilt the rig this afternoon. Two thermocouples, one at the water line and one 3cm below. Logger sampling every 30 seconds.\n\n- Calibrated against ice bath, both read within 0.3C\n- Rig is stable but the clamp slips if the bath is moved',
  'Ran the first three replicates. **Replicate 2 was contaminated** and I discarded it rather than trying to salvage it. Notes on why in the photo of the notebook page.',
  'Talked through the design with my officer. Changed the plan: instead of one long exposure I will do four shorter ones, because a single long run confounds acclimation with damage.',
  '## Data check\n\nPulled the logger. 4,800 rows, no gaps. Quick plot shows the expected sigmoid, though the upper asymptote is lower than the literature by about 2C.\n\nPossible reasons:\n\n1. Different population\n2. My thermocouple placement\n3. Shorter acclimation than the paper used',
  'Rewrote the methods section. The old version described what I *meant* to do rather than what I did, which is exactly the thing the notebook is supposed to prevent.',
  'Second round finished. Numbers hold up. Starting on the poster layout this weekend, and I need the abstract done before the deadline rather than the night before.',
];

const OBSERVATIONS = [
  'Checked in with them. The rig is sound and the discard was the right call. Suggested they record the ambient temperature as well, since the lab is not stable overnight.',
  'Reminded them that the abstract deadline is earlier than they think and that the title cannot change after February.',
];

/* Manuscript prose, long enough to clear the word minimums where a scenario
   is meant to read as finished and deliberately short where it is not. The
   point is to be able to open the editor and see a real check result rather
   than seven identical "not started" rows. */
const SECTION_TEXT = {
  background:
    'Intertidal gastropods live across a steep thermal gradient compressed into a few vertical meters of shore, which makes them a convenient natural experiment in thermal tolerance. Animals at the high shore are emersed for longer on each tide and experience body temperatures well above the water they feed in, while animals a meter lower are rarely out of the splash zone. Published work has established that upper thermal limits vary with acclimation history, but most of it has been done on animals held at constant laboratory temperatures rather than on animals sampled directly from a shore with a known exposure regime. The question here is whether prior heat exposure measured in the field predicts the upper thermal limit measured in the laboratory, and whether that relationship is strong enough to be useful for predicting which populations are most at risk as summer air temperatures rise. If it holds, shore height becomes a cheap proxy for thermal vulnerability that anybody with a tape measure can apply.',
  prior_work:
    'Thermal tolerance in marine invertebrates is usually reported as a critical thermal maximum, the temperature at which a standardized behavior fails. Several studies have shown that this limit shifts with acclimation, typically by one to two degrees over a few weeks. Work on limpets and mussels has found that vertical position on the shore correlates with tolerance, though the effect sizes vary widely between sites and the mechanism is disputed: it may reflect acclimation, or selection, or simply that different species dominate at different heights. What has been done less often is to measure exposure directly at the same time as tolerance, in the same animals, on the same shore. That gap is the one this study works in.',
  methods:
    'Animals were collected from a single rocky shore across three bands defined by height above mean lower low water: high, at 1.8 to 2.1 meters, mid at 1.2 to 1.5 meters, and low at 0.4 to 0.7 meters. Twenty animals were taken from each band on each of four collection dates, giving 240 animals in total. Height was measured with a surveyor level against a tide staff rather than estimated by eye, because a twenty centimeter error spans most of the difference between bands. Temperature loggers were epoxied to the rock at each band and recorded at thirty second intervals for the six weeks preceding collection, so that each animal carries an exposure history rather than an assumed one. Animals were transported in chilled seawater and held at fourteen degrees for twenty four hours before testing to standardize handling stress. Thermal tolerance was assessed by ramping a water bath at one degree every fifteen minutes and recording the temperature at which an animal failed to reattach after being dislodged, tested blind to collection band by having a second person code the containers. Survival was scored again at twenty four hours. All analysis was done in R and the scripts are linked below.',
  results:
    'Survival at thirty two degrees fell from eighty eight percent in the high shore group to forty one percent in the low shore group, with the mid shore group intermediate at sixty seven percent. The relationship between logged exposure above twenty five degrees and the temperature of reattachment failure was positive and approximately linear across the range sampled, with no evidence of a plateau at either end. The upper asymptote sat roughly two degrees below the figure reported in the most cited comparable study, a difference discussed below. Variation within bands was substantial: the interquartile range within the high shore group overlapped the median of the mid shore group, so shore height predicts a population mean much better than it predicts any individual animal. Collection date accounted for less of the variance than band did, though the two are partly confounded because the low shore loggers were submerged more often and therefore recorded fewer hours above twenty five degrees. Twenty four hour survival tracked the reattachment endpoint closely, which supports treating the behavioral measure as a reasonable stand in for the physiological limit rather than as a separate result.',
  discussion:
    'The direction of the result matches the prediction and the size of it is large enough to matter, but three limitations bound what can be claimed. The design is correlational: animals were not moved between bands, so acclimation and selection cannot be separated, and either would produce this pattern. Collection happened across four dates spanning six weeks, and although exposure was logged continuously, the animals collected last had experienced a warmer period overall, which is partially confounded with band because the low shore loggers were submerged more often. And the reattachment endpoint is a behavioral proxy for a physiological limit, which is standard practice and still a proxy. The two degree offset from the published figure is most likely a population difference or a ramp rate difference rather than a measurement error, since the loggers were calibrated against an ice bath and agreed within three tenths of a degree. The within band variation is the finding with the most practical weight and the least attention in the literature: a prediction that is accurate for a population and poor for an individual is exactly the kind of result that gets misapplied when it is summarized as a single number. Anybody using shore height as a proxy for thermal vulnerability should treat it as describing a distribution rather than a threshold.',
  conclusion:
    'Shore height, measured properly rather than estimated, predicts population level thermal tolerance on this shore well enough to be worth using. It does not predict individual tolerance, and any application that treats it as though it does will be wrong about specific animals a great deal of the time. The relationship with directly logged exposure is stronger than the relationship with height alone, which suggests that exposure is the thing doing the work and height is a proxy for it.',
  future_work:
    'The obvious next step is a transplant: move animals between bands, hold them for six weeks, and test them, which separates acclimation from selection in a way this design cannot. A second season would also address the confound between collection date and band. Extending the logger deployment through a full summer would show whether the relationship holds through the hottest part of the year or saturates.',
};

/* A second body, so the two submit-ready papers do not read identically. An
   editor working through a queue of two should not see the same words twice,
   and neither should anybody testing the review screens. */
const SECTION_TEXT_B = {
  background:
    'Cover crops are grown between cash crops to hold soil and, in the case of legumes, to fix atmospheric nitrogen into a form the next crop can use. How much nitrogen actually becomes available, and how quickly, depends on the species, the termination method, and the soil biology already present, which is why recommendations vary so widely between extension services. Raised beds complicate the picture further: they warm faster in spring, drain differently, and are usually built on imported soil with a shorter history than a field, so the microbial community doing the mineralizing may be younger and less established than the one a field trial measured. The question here is whether hairy vetch, the legume most often recommended for a home garden, actually outperforms crimson clover on plant available nitrogen eight weeks after termination in a raised bed, and whether the difference is large enough to matter to somebody deciding what to sow in October. That decision is made once a year by a great many people on the strength of a recommendation almost none of them can check, which is reason enough to check it once in the setting where it is actually applied.',
  prior_work:
    'Field trials consistently report higher total nitrogen fixation from vetch than from clover, often by a wide margin, and the figure most frequently quoted to gardeners comes from those trials. What field trials measure is total biomass nitrogen rather than what is available to the following crop, and the two are not the same: nitrogen locked in slowly decomposing stems is not nitrogen a seedling can use in April. Work on decomposition rates suggests the gap narrows considerably once carbon to nitrogen ratio is taken into account, and clover, with the softer tissue, mineralizes faster. Almost none of this work has been done in raised beds, which is the setting most of the people reading the recommendation are actually planting in.',
  methods:
    'Twelve raised beds of identical construction, each 1.2 by 2.4 meters, were filled from a single delivery of the same soil blend and randomly assigned to one of three treatments: hairy vetch, crimson clover, or bare fallow, four beds each. Randomization was by drawing lots rather than by position, so no treatment sits preferentially at the sunnier end of the plot. Seed was broadcast at the rate printed on the supplier packet in the first week of October and lightly raked in. Beds were not irrigated after establishment, which matches ordinary practice and means the trial reflects a normal wet season rather than a controlled one. Termination was by crimping in the third week of March, with all residue left on the surface rather than incorporated, which is what a gardener without a tiller would do. Plant available nitrogen was measured as nitrate plus ammonium from cores taken at 0 to 15 centimeters, four cores per bed composited, at termination and at two, four, six, and eight weeks after. Cores were taken at fixed marked positions so that repeated sampling did not progressively disturb one part of a bed. Samples were extracted in potassium chloride and read on a spectrophotometer against a standard curve prepared the same day, with a blank and a check standard run every twelfth sample. Aboveground biomass was cut, dried at sixty degrees to constant mass, and weighed before termination so that nitrogen availability could be expressed per unit of biomass as well as per bed.',
  results:
    'Vetch produced substantially more biomass than clover, roughly forty percent more dry mass per bed, which matches what the field literature reports and confirms that establishment was not the limiting factor for either species. Plant available nitrogen told a different story. At two weeks the clover beds were already higher than the vetch beds, and they stayed higher through week four. The two converged by week six, and at week eight the vetch beds were higher, though the difference was smaller than the biomass difference would suggest. Expressed per unit of dry mass rather than per bed, clover released more nitrogen at every time point, which is the clearest statement of the result. Both treatments were well above the fallow beds at every point after week two, so neither is in doubt as a source of nitrogen; the question is only one of timing. Variation between beds within a treatment was larger than expected given identical construction and a single soil source, and larger in the vetch beds than the clover beds, which limits how confidently any single time point can be read.',
  discussion:
    'The practical answer depends entirely on when the next crop needs the nitrogen. For an early planting, clover made more available sooner, which is the opposite of the recommendation a gardener is most likely to encounter. For a later planting, vetch caught up and passed it. The most likely mechanism is decomposition rate rather than fixation: clover tissue is softer and has a lower carbon to nitrogen ratio, so it mineralizes faster even though there is less of it. Three limitations bound this. One season, so nothing here separates treatment from weather, and a colder or wetter spring would change decomposition for both. Twelve beds is a small number for the variance actually observed, and a larger trial might not reproduce the crossover at all. And surface residue was left rather than incorporated, which slows mineralization for both treatments and probably widens the early gap in favor of the faster decomposing clover; a gardener who tills would likely see something different, possibly the ordering the recommendation predicts.',
  conclusion:
    'Biomass is not availability, and the recommendation most often given to home gardeners is based on the first. For a bed that needs nitrogen in April, crimson clover made more of it available than hairy vetch did, despite producing considerably less material. For a bed planted in June the ordering reverses, and vetch is the better choice. Either species is a reasonable one; which is better depends on a question the recommendation does not ask, and the answer a gardener needs is a planting date rather than a species name.',
  future_work:
    'The obvious next step is a second season, which would separate the treatment effect from a single spring. Incorporating residue in half the beds would test the decomposition explanation directly rather than inferring it. And measuring the following crop rather than the soil would answer the question a gardener actually has, which is not how much nitrogen is present but how much of it ends up in the tomatoes.',
};

const REFERENCES_B = [
  'Clark, A. (Ed.). (2007). Managing Cover Crops Profitably (3rd ed.). SARE Outreach.',
  'Parr, M., et al. (2011). Nitrogen delivery from legume cover crops. Agronomy Journal, 103(6), 1578-1590.',
  'Wagger, M. G. (1989). Time of desiccation effects on plant composition and subsequent nitrogen release. Agronomy Journal, 81(2), 236-241.',
  'Ruffo, M. L., & Bollero, G. A. (2003). Modeling rye and hairy vetch residue decomposition. Agronomy Journal, 95(4), 900-907.',
  'Finney, D. M., et al. (2016). Living cover crops have immediate impacts on soil microbial community structure. Agriculture, Ecosystems and Environment, 232, 175-184.',
];

const REFERENCES = [
  'Somero, G. N. (2010). The physiology of climate change. Journal of Experimental Biology, 213(6), 912-920.',
  'Helmuth, B., et al. (2006). Mosaic patterns of thermal stress in the rocky intertidal zone. Ecological Monographs, 76(4), 461-479.',
  'Stillman, J. H. (2003). Acclimation capacity underlies susceptibility to climate change. Science, 301(5629), 65.',
  'Denny, M. W., & Harley, C. D. G. (2006). Hot limpets: predicting body temperature in a conductance-mediated thermal system. Journal of Experimental Biology, 209(13), 2409-2419.',
  'Dong, Y., & Williams, G. A. (2011). Variations in cardiac performance and heat shock protein expression. Marine Biology, 158(6), 1223-1231.',
];

/* ── Work ───────────────────────────────────────────────────────────────── */

async function main() {
  const { data: org, error: orgError } = await db
    .from('organizations')
    .select('id, slug, lockup_name')
    .eq('slug', ORG_SLUG)
    .single();

  if (orgError || !org) fail(`No organization "${ORG_SLUG}". Run npm run reset first.`);

  const { data: existing } = await db
    .from('projects')
    .select('id')
    .eq('org_id', org.id)
    .limit(1);

  if (existing && existing.length > 0) {
    console.log('Projects already exist. Nothing to do; `npm run reset` starts over.');
    return;
  }

  /* Every program this school runs, by kind. A scenario says which one it
     belongs to, because a school now runs several and one of them is a
     journal with no date at all. */
  const { data: allPrograms, error: programsError } = await db
    .from('programs')
    .select('id, name, season_year, kind, program_role')
    /* Shared programs have a null `org_id` and belong to every school that
       enters them, so an equality test hides the regional fair. */
    .or(`org_id.eq.${org.id},org_id.is.null`)
    .eq('status', 'open')
    .order('fair_date', { ascending: true });

  if (programsError) {
    fail(`Could not read the programs: ${programsError.message}`);
  }

  /**
   * One program per kind, preferring the thing a project is *entered into*.
   *
   * Monta Vista now sees two programs of kind `competition`: the regional
   * fair, and the research club that prepares for it. The club is a cohort.
   * Taking whichever arrived first put nine scenarios "in" a class and
   * recorded fair placements against it -- a course with an entry code and
   * an award, which is 22.1's conflation sitting in the fixtures. It was
   * invisible while `entries` and `project_cohorts` were separate tables,
   * and it is why nothing published: `seed-publish` reads
   * `opportunity_participations`, and a cohort is not in it.
   */
  const byKind = new Map();
  for (const p of allPrograms ?? []) {
    const held = byKind.get(p.kind);
    if (!held || (held.program_role !== 'opportunity' && p.program_role === 'opportunity')) {
      byKind.set(p.kind, p);
    }
  }

  /* The cohort a scene's entry was made through, where the school runs one
     that prepares for it. This is `via_id`: *with my research, in my club*
     (22.6), and until now no fixture had one at all. */
  const cohortByKind = new Map();
  for (const p of allPrograms ?? []) {
    if (p.program_role === 'cohort' && !cohortByKind.has(p.kind)) cohortByKind.set(p.kind, p);
  }

  const program = byKind.get('competition');
  if (!program) {
    fail(`No competition for ${org.slug}. Run npm run seed:programs first.`);
  }
  if (!byKind.get('course')) {
    console.log('  No course at this school, so the course scenarios are skipped.');
  }

  /* One read per program rather than one per project. A school runs two or
     three, and every scenario in the same program shares its deadlines. */
  const milestonesByProgram = new Map();
  for (const p of allPrograms ?? []) {
    const { data: rows } = await db
      .from('program_milestones')
      .select('id, name, kind, due_on, required, blocks_experimentation, satisfied_by, sort_order, org_id, source')
      .eq('program_id', p.id)
      .order('sort_order');

    milestonesByProgram.set(
      p.id,
      (rows ?? []).filter((m) => !m.org_id || m.org_id === org.id)
    );
  }


  /* Fixture people, by handle.
     The addresses live in auth, not in public.identities: that table is a
     mirror refreshed when somebody signs in, and a fixture created by the
     admin API has never signed in. Looking there found nobody and the script
     stopped before creating anything, which is the failure this replaces. */
  const { data: authUsers, error: listError } = await db.auth.admin.listUsers({
    perPage: 500,
  });

  if (listError) fail(`Could not list accounts: ${listError.message}`);

  const { data: people } = await db
    .from('users')
    .select('id, display_name')
    .eq('org_id', org.id);

  const nameById = new Map((people ?? []).map((p) => [p.id, p.display_name]));

  const byHandle = new Map();
  for (const account of authUsers?.users ?? []) {
    const email = (account.email ?? '').toLowerCase();
    if (!email.endsWith(`@${FIXTURE_DOMAIN}`)) continue;
    if (!email.startsWith(`${ORG_SLUG}.`)) continue;
    if (!nameById.has(account.id)) continue;

    const handle = email.slice(ORG_SLUG.length + 1, email.indexOf('@'));
    /* The address travels with the person because signing in needs it, and
       reconstructing it from the handle would be a second place the fixture
       address format is written down. */
    byHandle.set(handle, { id: account.id, email, display_name: nameById.get(account.id) });
  }

  if (byHandle.size === 0) {
    fail(
      `No fixture people found for "${ORG_SLUG}".\n` +
        'Run npm run seed:demo first, or npm run reset to do everything.'
    );
  }

  const kinds = [...byKind.keys()].sort().join(', ');
  console.log(`Seeding ${SCENARIOS.length} scenarios into ${org.lockup_name}.`);
  console.log(`  Programs available: ${kinds || 'none'}`);
  console.log(
    bucket
      ? '  Showcase images are drawn and written to local file storage.\n'
      : '  No local file storage, so the showcase images are skipped.\n'
  );

  for (const scene of SCENARIOS) {
    const authors = scene.authors.map((h) => byHandle.get(h)).filter(Boolean);
    if (authors.length === 0) {
      console.log(`  skipped ${scene.key}: no author found`);
      continue;
    }

    /* Which program this project belongs to. A scenario that names a kind
       the school does not run is skipped rather than forced into the fair. */
    const scenePrograms = byKind.get(scene.program ?? 'competition');
    if (!scenePrograms) {
      console.log(`  skipped ${scene.key}: no ${scene.program} at this school`);
      continue;
    }
    const sceneMilestones = milestonesByProgram.get(scenePrograms.id) ?? [];

    const startedOn = scene.startedDaysAgo === null ? null : shift(-scene.startedDaysAgo);

    const { data: project, error: projectError } = await db
      .from('projects')
      .insert({
        org_id: org.id,
        title: scene.title,
        question: scene.question,
        started_on: startedOn,
        /* No stage. Where a project is comes from its steps, and the seeded
           milestones already say. The column survives one release and is
           dropped in the next migration. */
        created_by: authors[0].id,
      })
      .select('id')
      .single();

    if (projectError) fail(`${scene.key}: ${projectError.message}`);

    for (const author of authors) {
      await must(
        db.from('project_authors').insert({
          org_id: org.id,
          project_id: project.id,
          user_id: author.id,
          role: 'author',
          accepted_at: new Date().toISOString(),
        }),
        `writing project_authors`
      );
    }

    /* Pictures, where the scenario asks for them. */
    /* What the project says about itself. The conditional forms key off
       these, so a project that declares nothing gets the three every project
       needs and no more. */
    if (scene.facts) {
      await must(
        db.from('projects').update({ facts: scene.facts }).eq('id', project.id),
        `writing projects`
      );
    }

    if (scene.images) {
      await seedImages(org.id, project.id, authors[0].id, scene.key, scene.images);
    }

    if (scene.video) {
      await must(
        db.from('projects').update({ video_url: scene.video }).eq('id', project.id),
        `writing projects`
      );
    }

    /* An officer, or the author looking after it herself. */
    if (scene.officer) {
      const officer = byHandle.get(scene.officer);
      const isAuthor = authors.some((a) => a.id === officer?.id);

      if (officer && isAuthor) {
        const { error: selfManagedError } = await db
          .from('project_authors')
          .update({ self_managed_at: new Date().toISOString() })
          .eq('project_id', project.id)
          .eq('user_id', officer.id);

        if (selfManagedError) {
          fail(`${scene.key}: could not mark it self managed (${selfManagedError.message})`);
        }
      } else if (officer) {
        await must(
          db.from('project_authors').insert({
            org_id: org.id,
            project_id: project.id,
            user_id: officer.id,
            role: 'officer',
            accepted_at: new Date().toISOString(),
          }),
          `writing project_authors`
        );
      }
    }

    /* Which cohort's project this is, and who is in that cohort.
    
       The scenarios were written when joining a program and entering one
       were the same row, so every project got an entry and nothing recorded
       a membership. The entry stays — a project really is entered into these
       programs — and the two relationships the model separated are written
       alongside it (22.5).
    
       Only for a cohort: nobody is a member of a regional fair. */
    const viaCohort =
      scenePrograms.program_role === 'opportunity'
        ? cohortByKind.get(scenePrograms.kind)
        : null;

    /* **The club, and the entry made through it. 22.6.**
    
       A scene at the fair is a club member's work: they are in the club,
       the project is the club's, and the entry went through it. That last
       relationship is `via_id`, and it answers which cohort's officer looks
       after the entry, whose `selection_cap` it counts against, and which
       school-layer deadlines apply -- none of which had a fixture before,
       because there was no column to put it in. */
    let viaId = null;

    if (viaCohort) {
      for (const author of authors) {
        await must(
          db.from('memberships').upsert(
            { org_id: org.id, user_id: author.id, cohort_id: viaCohort.id, state: 'member' },
            { onConflict: 'user_id,cohort_id' }
          ),
          `putting ${author.display_name} in ${viaCohort.name}`
        );
      }

      const { data: viaRow, error: viaError } = await db
        .from('participations')
        .upsert(
          { org_id: org.id, project_id: project.id, program_id: viaCohort.id },
          { onConflict: 'project_id,program_id' }
        )
        .select('id')
        .single();

      if (viaError || !viaRow) {
        fail(`${scene.key}: could not attach to ${viaCohort.name} (${viaError?.message ?? 'no row'})`);
      }

      viaId = viaRow.id;
    }

    if (scenePrograms.program_role === 'cohort') {
      /* No participation row is written here.
      
         There used to be one, because attaching a project to a cohort and
         entering it into a program were two tables and a scene whose program
         is a course legitimately wrote to both. They are one table now, keyed
         on `(project_id, program_id)`, so writing the row here and inserting
         it again below is the same row twice -- which is what
         `participations_project_id_program_id_key` refused.
      
         The single insert below covers both cases, and it has to be the
         survivor rather than this one because it carries the selection state
         and the money and returns the id everything downstream hangs off.
      
         The memberships are what is genuinely extra for a cohort: a person
         belongs to the class, which is a different left-hand side and a
         different table (22.5). */
      for (const author of authors) {
        await must(
          db.from('memberships').upsert(
            { org_id: org.id, user_id: author.id, cohort_id: scenePrograms.id, state: 'member' },
            { onConflict: 'user_id,cohort_id' }
          ),
          `putting ${author.display_name} in the cohort`
        );
      }
    }

    /* The table, not a view. The two views exist so that *reads* cannot
       conflate a class with a fair (22.5); they join `programs` and so are
       not insertable. Writes name the table. */
    const { data: entry, error: entryError } = await db
      .from('participations')
      .upsert({
        org_id: org.id,
        project_id: project.id,
        program_id: scenePrograms.id,
        via_id: viaId,
        selection_state: scene.selection ?? 'candidate',
        /* A grant's two numbers. Null everywhere else, which is what they
           mean for a fair. */
        requested_amount: scene.requested ?? null,
        awarded_amount: scene.awarded ?? null,
        selection_note: scene.selectionNote ?? null,
        selection_decided_at:
          scene.selection && scene.selection !== 'candidate'
            ? new Date().toISOString()
            : null,
      }, { onConflict: 'project_id,program_id' })
      .select('id')
      .single();

    if (entryError || !entry) {
      fail(`${scene.key}: could not enter the program (${entryError?.message ?? 'no row'})`);
    }

    /* The sponsor, which hangs off the participation rather than the project.
    
       Written after the entry rather than before it, because there was
       nothing to attach it to until the participation existed. Recording it
       against the project was the bug: one signature showed on every cohort
       and every entry the project had, and the approval it cleared cleared
       them all. */
    if (scene.sponsor) {
      await must(
        db.from('project_sponsors').insert({
          org_id: org.id,
          participation_id: entry.id,
          teacher_name: scene.sponsor.name,
          teacher_email: scene.sponsor.email,
          signed_on: shift(-scene.sponsor.signedDaysAgo),
          recorded_by: authors[0].id,
        }),
        `writing project_sponsors`
      );
    }

    /* What happened at the fair, through the same function the entry page
       calls, so a fixture cannot end up in a state the interface could not
       produce.
    
       Signed in as the first author rather than written through the table.
       The function reads `auth.uid()` and the secret key carries no subject,
       so the seed is nobody and the call raises before it looks at the
       entry. An author is always present and always permitted, which an
       officer is not: three of the scenarios have none. */
    if (scene.result) {
      const asAuthor = await actingAs(authors[0].email);

      const { error: resultError } = await asAuthor.rpc('record_entry_result', {
        p_participation_id: entry.id,
        p_category: scene.result.category ?? '',
        p_entry_code: scene.result.entryCode ?? '',
        p_placement: scene.result.placement ?? '',
        p_awards: scene.result.awards ?? [],
        p_advanced_to: scene.result.advancedTo ?? '',
      });

      if (resultError) {
        fail(`${scene.key}: could not record the result (${resultError.message})`);
      }
    }

    /* The milestone copy, in order, with a slice marked complete. */
    const ordered = [...sceneMilestones].sort((a, b) => a.sort_order - b.sort_order);
    let completed = 0;
    let overdueLeft = scene.overdue ?? 0;

    for (const [index, m] of ordered.entries()) {
      let dueOn = m.due_on;
      let completedOn = null;

      const isDerived = Boolean(m.satisfied_by);

      if (isDerived) {
        /* Follows the fact rather than the fixture. */
        completedOn =
          m.satisfied_by === 'sponsor' && scene.sponsor
            ? shift(-scene.sponsor.signedDaysAgo)
            : null;
      } else if (completed < scene.complete) {
        completedOn = shift(-(40 - index * 3));
        completed += 1;
      } else if (overdueLeft > 0) {
        /* Pull the due date into the past and leave it open. */
        dueOn = shift(-(overdueLeft * 9));
        overdueLeft -= 1;
      }

      await must(
        db.from('entry_milestones').insert({
          org_id: org.id,
          participation_id: entry.id,
          program_milestone_id: m.id,
          name: m.name,
          kind: m.kind,
          due_on: dueOn,
          required: m.required,
          blocks_experimentation: m.blocks_experimentation,
          satisfied_by: m.satisfied_by,
          completed_on: completedOn,
          completed_by: completedOn && !isDerived ? authors[0].id : null,
          sort_order: m.sort_order,
          source: m.source,
        }),
        `writing entry_milestones`
      );

      if (completedOn && !isDerived) {
        await must(
          db.from('deliverables').insert({
            org_id: org.id,
            participation_id: entry.id,
            milestone_id: null,
            type: m.kind,
            label: m.name,
            signed_on: completedOn,
            submitted_at: new Date().toISOString(),
            created_by: authors[0].id,
          }),
          `writing deliverables`
        );
      }
    }

    /* A notebook that reads like a term rather than a placeholder. */
    for (let i = 0; i < (scene.notes ?? 0); i += 1) {
      await must(
        db.from('field_notes').insert({
          org_id: org.id,
          project_id: project.id,
          author_id: authors[i % authors.length].id,
          body_md: NOTE_TEXTS[i % NOTE_TEXTS.length],
          occurred_on: shift(-(scene.notes - i) * 4),
        }),
        `writing field_notes`
      );
    }

    /* One officer observation, so the attribution tag is visible. */
    if (scene.officer && scene.notes > 1) {
      const officer = byHandle.get(scene.officer);
      if (officer && !authors.some((a) => a.id === officer.id)) {
        await must(
          db.from('field_notes').insert({
            org_id: org.id,
            project_id: project.id,
            author_id: officer.id,
            body_md: OBSERVATIONS[SCENARIOS.indexOf(scene) % OBSERVATIONS.length],
            occurred_on: shift(-3),
          }),
          `writing field_notes`
        );
      }
    }

    await must(
      db.from('project_links').insert({
        org_id: org.id,
        project_id: project.id,
        label: 'Data spreadsheet',
        url: 'https://docs.google.com/spreadsheets/d/example',
        added_by: authors[0].id,
      }),
      `writing project_links`
    );

    /* The manuscript, at whatever stage this scenario is meant to show.
       `write` is how many sections exist, so the editor reads as a real
       document part way through rather than as a blank template. */
    if (scene.manuscript) {
      const spec = scene.manuscript;
      const names = authors.map((a) => a.display_name);

      const { data: manuscript, error: manuscriptError } = await db
        .from('manuscripts')
        .insert({
          org_id: org.id,
          project_id: project.id,
          record_kind: spec.kind ?? 'article',
          source: spec.source ?? 'workbench',
          body_format: spec.bodyFormat ?? 'full-text',
          title: scene.title,
          abstract: spec.abstract ?? null,
          keywords: spec.keywords ?? [],
          discipline: spec.discipline ?? null,
          contributions:
            spec.contributions === undefined
              ? `${names.join(' and ')} designed the study, collected and analyzed the data, and wrote the paper. ${scene.sponsor ? `${scene.sponsor.name} reviewed the protocol and supervised laboratory safety.` : ''}`.trim()
              : spec.contributions,
          completed_on: shift(-2),
          date_precision: 'month',
          created_by: authors[0].id,
        })
        .select('id')
        .single();

      if (manuscriptError || !manuscript) {
        fail(`${scene.key}: could not create the manuscript (${manuscriptError?.message ?? 'no row'})`);
      }

      if (manuscript) {
        const order = [
          'background',
          'prior_work',
          'methods',
          'results',
          'discussion',
          'conclusion',
          'future_work',
        ];

        const bank = spec.bank === 'b' ? SECTION_TEXT_B : SECTION_TEXT;
        const citations = spec.bank === 'b' ? REFERENCES_B : REFERENCES;

        if (spec.methods || spec.dataSources || spec.outputs) {
          const { error: glanceError } = await db
            .from('manuscripts')
            .update({
              methods: spec.methods ?? [],
              data_sources: spec.dataSources ?? [],
              outputs: spec.outputs ?? [],
            })
            .eq('id', manuscript.id);

          if (glanceError) {
            fail(`${scene.key}: could not save research at a glance (${glanceError.message})`);
          }
        }

        for (const [index, key] of order.entries()) {
          if (index >= (spec.write ?? 0)) break;
          await must(
            db.from('manuscript_sections').insert({
              org_id: org.id,
              manuscript_id: manuscript.id,
              section_key: key,
              body: bank[key],
              sort_order: index,
              updated_by: authors[0].id,
            }),
            `writing manuscript_sections`
          );
        }

        for (const [index, citation] of citations.slice(0, spec.references ?? 0).entries()) {
          await must(
            db.from('manuscript_references').insert({
              org_id: org.id,
              manuscript_id: manuscript.id,
              sort_order: index + 1,
              citation,
            }),
            `writing manuscript_references`
          );
        }
      }
    }

    /* What a project declares about itself decides its paperwork, so it is
       worth seeing at a glance which fixture exercises which forms. */
    const declared = Object.entries(scene.facts ?? {})
      .filter(([, value]) => value)
      .map(([name]) => name);

    console.log(
      `  ${scene.title}\n` +
        `    ${authors.map((a) => a.display_name).join(', ')}` +
        `${scene.officer ? ` · officer ${byHandle.get(scene.officer)?.display_name ?? '?'}` : ' · no officer'}` +
        `${scene.sponsor ? ` · ${scene.sponsor.name}` : ' · no sponsor'}` +
        `\n    ${scenePrograms.name}` +
        `${declared.length ? ` · declares ${declared.join(', ')}` : ' · nothing regulated'}` +
        `${scene.note ? `\n    ${scene.note}` : ''}`
    );
  }

  console.log(
    '\nSign in with any fixture address and the password: scipath' +
      '\n\n  montavista.advisor@demo.invalid     everything, plus selection' +
      '\n  montavista.officer.a@demo.invalid   three projects, one queue' +
      '\n  montavista.officer.c@demo.invalid   runs one of her own' +
      '\n  montavista.student.a@demo.invalid   one project, in good order' +
      '\n  montavista.student.b@demo.invalid   one disqualified' +
      '\n  montavista.student.g@demo.invalid   co-authored with mv_student8\n'
  );
}

async function release() {
  await signOutAll();
  await releaseBucket();
}

main()
  .then(release)
  .catch(async (e) => {
    await release();
    fail(e.message);
  });
