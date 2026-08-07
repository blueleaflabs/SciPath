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
    title: 'Thermal tolerance in intertidal snails',
    question: 'Does prior heat exposure change the upper thermal limit of Nucella?',
    authors: ['student.a'],
    officer: 'officer.a',
    sponsor: { name: 'J. Okonkwo', email: 'j.okonkwo@fuhsd.org', signedDaysAgo: 30 },
    startedDaysAgo: 20,
    complete: 4,
    notes: 5,
    selection: 'selected',
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
    title: 'Microplastic uptake in Daphnia',
    question: 'Do polystyrene beads reduce Daphnia reproduction rate?',
    authors: ['student.b'],
    officer: 'officer.a',
    sponsor: { name: 'A. Beaumont', email: 'a.beaumont@fuhsd.org', signedDaysAgo: 5 },
    /* Work began well before the sponsor signed. Already true, cannot be
       undone, and the reason the ordering check exists. */
    startedDaysAgo: 60,
    complete: 3,
    notes: 4,
    selection: 'candidate',
  },
  {
    key: 'planned-clash',
    title: 'Perovskite film stability under humidity cycling',
    question: 'How fast does efficiency fall with repeated humidity cycles?',
    authors: ['student.c'],
    officer: 'officer.b',
    sponsor: { name: 'A. Beaumont', email: 'a.beaumont@fuhsd.org', signedDaysAgo: -20 },
    /* Plans to start before the signature is due. Not yet a problem, and
       fixable by moving one date, which is the whole point of saying so. */
    startedDaysAgo: -10,
    complete: 2,
    notes: 2,
    selection: 'candidate',
  },
  {
    key: 'overdue',
    title: 'Rainwater nitrate across four Cupertino catchments',
    question: 'Does nitrate concentration track distance from the freeway?',
    authors: ['student.d'],
    officer: 'officer.b',
    sponsor: { name: 'M. Lindqvist', email: 'm.lindqvist@fuhsd.org', signedDaysAgo: 40 },
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
    sponsor: { name: 'J. Okonkwo', email: 'j.okonkwo@fuhsd.org', signedDaysAgo: 12 },
    startedDaysAgo: 8,
    complete: 2,
    notes: 2,
    selection: 'candidate',
    note: 'Sits in the assignment queue waiting for an officer.',
  },
  {
    key: 'self-managed',
    title: 'Nitrogen-fixing cover crops in raised beds',
    question: 'Does vetch outperform clover on available nitrogen after eight weeks?',
    /* An officer running a project of her own, and looking after it herself. */
    authors: ['officer.c'],
    officer: 'officer.c',
    sponsor: { name: 'M. Lindqvist', email: 'm.lindqvist@fuhsd.org', signedDaysAgo: 15 },
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
        'P. Osei designed the trial, built and planted the beds, ran every extraction and measurement, analyzed the data, and wrote the paper. M. Lindqvist reviewed the protocol and supervised use of the spectrophotometer.',
    },
    note: 'Self managed, and a second paper ready to submit.',
  },
  {
    key: 'co-authored',
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
        'L. Nakamura designed the optical path, built and calibrated the sensor, ran the field comparison, and wrote the paper.',
    },
    officer: 'officer.a',
    sponsor: { name: 'J. Okonkwo', email: 'j.okonkwo@fuhsd.org', signedDaysAgo: 22 },
    startedDaysAgo: 14,
    complete: 5,
    notes: 6,
    selection: 'selected',
    note: 'Two authors, so co-authorship and shared notebooks are visible.',
  },
  {
    key: 'not-selected',
    title: 'Sleep duration and reaction time in high schoolers',
    question: 'Does self-reported sleep predict simple reaction time?',
    /* An officer running a project of her own, looked after by another
       officer. The common case, and different from the self-managed one. */
    authors: ['officer.a'],
    officer: 'officer.b',
    sponsor: { name: 'A. Beaumont', email: 'a.beaumont@fuhsd.org', signedDaysAgo: 35 },
    startedDaysAgo: 28,
    complete: 6,
    notes: 4,
    selection: 'not_selected',
    selectionNote: 'Human subjects paperwork would not clear in time.',
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

  const { data: program } = await db
    .from('programs')
    .select('id, name, season_year')
    .eq('status', 'open')
    .order('fair_date', { ascending: true })
    .limit(1)
    .single();

  if (!program) fail('No open program. Run npm run reset first.');

  const { data: templates } = await db
    .from('program_milestones')
    .select('id, name, kind, due_on, required, blocks_experimentation, satisfied_by, sort_order, org_id')
    .eq('program_id', program.id);

  const mine = (templates ?? []).filter((m) => !m.org_id || m.org_id === org.id);

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
    byHandle.set(handle, { id: account.id, display_name: nameById.get(account.id) });
  }

  if (byHandle.size === 0) {
    fail(
      `No fixture people found for "${ORG_SLUG}".\n` +
        'Run npm run seed:demo first, or npm run reset to do everything.'
    );
  }

  console.log(`Seeding ${SCENARIOS.length} scenarios into ${org.lockup_name}.\n`);

  for (const scene of SCENARIOS) {
    const authors = scene.authors.map((h) => byHandle.get(h)).filter(Boolean);
    if (authors.length === 0) {
      console.log(`  skipped ${scene.key}: no author found`);
      continue;
    }

    const startedOn = scene.startedDaysAgo === null ? null : shift(-scene.startedDaysAgo);

    const { data: project, error: projectError } = await db
      .from('projects')
      .insert({
        org_id: org.id,
        title: scene.title,
        question: scene.question,
        started_on: startedOn,
        stage: scene.complete > 3 ? 'in_progress' : 'registered',
        created_by: authors[0].id,
      })
      .select('id')
      .single();

    if (projectError) fail(`${scene.key}: ${projectError.message}`);

    for (const author of authors) {
      await db.from('project_authors').insert({
        org_id: org.id,
        project_id: project.id,
        user_id: author.id,
        role: 'author',
        accepted_at: new Date().toISOString(),
      });
    }

    /* Pictures, where the scenario asks for them. */
    if (scene.images) {
      await seedImages(org.id, project.id, authors[0].id, scene.key, scene.images);
    }

    if (scene.video) {
      await db.from('projects').update({ video_url: scene.video }).eq('id', project.id);
    }

    /* An officer, or the author looking after it herself. */
    if (scene.officer) {
      const officer = byHandle.get(scene.officer);
      const isAuthor = authors.some((a) => a.id === officer?.id);

      if (officer && isAuthor) {
        await db
          .from('project_authors')
          .update({ self_managed_at: new Date().toISOString() })
          .eq('project_id', project.id)
          .eq('user_id', officer.id);
      } else if (officer) {
        await db.from('project_authors').insert({
          org_id: org.id,
          project_id: project.id,
          user_id: officer.id,
          role: 'officer',
          accepted_at: new Date().toISOString(),
        });
      }
    }

    if (scene.sponsor) {
      await db.from('project_sponsors').insert({
        org_id: org.id,
        project_id: project.id,
        teacher_name: scene.sponsor.name,
        teacher_email: scene.sponsor.email,
        signed_on: shift(-scene.sponsor.signedDaysAgo),
        recorded_by: authors[0].id,
      });
    }

    const { data: entry } = await db
      .from('entries')
      .insert({
        org_id: org.id,
        project_id: project.id,
        program_id: program.id,
        selection_state: scene.selection ?? 'candidate',
        selection_note: scene.selectionNote ?? null,
        selection_decided_at:
          scene.selection && scene.selection !== 'candidate'
            ? new Date().toISOString()
            : null,
      })
      .select('id')
      .single();

    /* The milestone copy, in order, with a slice marked complete. */
    const ordered = [...mine].sort((a, b) => a.sort_order - b.sort_order);
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

      await db.from('entry_milestones').insert({
        org_id: org.id,
        entry_id: entry.id,
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
      });

      if (completedOn && !isDerived) {
        await db.from('deliverables').insert({
          org_id: org.id,
          entry_id: entry.id,
          milestone_id: null,
          type: m.kind,
          label: m.name,
          signed_on: completedOn,
          submitted_at: new Date().toISOString(),
          created_by: authors[0].id,
        });
      }
    }

    /* A notebook that reads like a term rather than a placeholder. */
    for (let i = 0; i < (scene.notes ?? 0); i += 1) {
      await db.from('field_notes').insert({
        org_id: org.id,
        project_id: project.id,
        author_id: authors[i % authors.length].id,
        body_md: NOTE_TEXTS[i % NOTE_TEXTS.length],
        occurred_on: shift(-(scene.notes - i) * 4),
      });
    }

    /* One officer observation, so the attribution tag is visible. */
    if (scene.officer && scene.notes > 1) {
      const officer = byHandle.get(scene.officer);
      if (officer && !authors.some((a) => a.id === officer.id)) {
        await db.from('field_notes').insert({
          org_id: org.id,
          project_id: project.id,
          author_id: officer.id,
          body_md: OBSERVATIONS[SCENARIOS.indexOf(scene) % OBSERVATIONS.length],
          occurred_on: shift(-3),
        });
      }
    }

    await db.from('project_links').insert({
      org_id: org.id,
      project_id: project.id,
      label: 'Data spreadsheet',
      url: 'https://docs.google.com/spreadsheets/d/example',
      added_by: authors[0].id,
    });

    /* The manuscript, at whatever stage this scenario is meant to show.
       `write` is how many sections exist, so the editor reads as a real
       document part way through rather than as a blank template. */
    if (scene.manuscript) {
      const spec = scene.manuscript;
      const names = authors.map((a) => a.display_name);

      const { data: manuscript } = await db
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
          await db
            .from('manuscripts')
            .update({
              methods: spec.methods ?? [],
              data_sources: spec.dataSources ?? [],
              outputs: spec.outputs ?? [],
            })
            .eq('id', manuscript.id);
        }

        for (const [index, key] of order.entries()) {
          if (index >= (spec.write ?? 0)) break;
          await db.from('manuscript_sections').insert({
            org_id: org.id,
            manuscript_id: manuscript.id,
            section_key: key,
            body: bank[key],
            sort_order: index,
            updated_by: authors[0].id,
          });
        }

        for (const [index, citation] of citations.slice(0, spec.references ?? 0).entries()) {
          await db.from('manuscript_references').insert({
            org_id: org.id,
            manuscript_id: manuscript.id,
            sort_order: index + 1,
            citation,
          });
        }
      }
    }

    console.log(
      `  ${scene.title}\n` +
        `    ${authors.map((a) => a.display_name).join(', ')}` +
        `${scene.officer ? ` · officer ${byHandle.get(scene.officer)?.display_name ?? '?'}` : ' · no officer'}` +
        `${scene.sponsor ? ` · ${scene.sponsor.name}` : ' · no sponsor'}` +
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
      '\n  montavista.student.g@demo.invalid   co-authored with C. Duarte\n'
  );
}

main().catch((e) => fail(e.message));
