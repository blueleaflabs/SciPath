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
  fail('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set.\n  set -a; source .dev.vars; set +a');
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
    note: 'Everything in order. The picture a healthy project makes.',
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
    selection: 'candidate',
  },
  {
    key: 'co-authored',
    title: 'Low-cost turbidity sensing for creek monitoring',
    question: 'Can an LED and photodiode match a commercial turbidity meter?',
    authors: ['student.g', 'student.h'],
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
