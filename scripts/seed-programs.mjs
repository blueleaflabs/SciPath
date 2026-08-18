#!/usr/bin/env node
/**
 * SEEDING PROGRAMS FROM THE TEMPLATES.
 *
 * The fair and its twelve deadlines were written into the migration by hand.
 * That was the state of things before the templates existed, and it is why
 * the interface still showed the old SCVSEFA after all the template work: the
 * files resolved, were tested, and nothing read them into the database.
 *
 * This is the bridge. Every program a school runs comes from a YAML file, and
 * so does every deadline on it.
 *
 * One rule worth stating: **this deletes and rewrites.** A program seeded
 * from a template is derived data, and reconciling it row by row would mean
 * deciding what to do when somebody has edited a generated deadline. Nobody
 * should be editing them, so a reset regenerates them.
 *
 * Run: node scripts/seed-programs.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars } from './dev-vars.mjs';
import { loadLibrary } from './template-library.mjs';
import { loadOrgs } from './orgs-library.mjs';
import { resolveProgram, datesFor } from '../src/lib/template-resolve.ts';

const ORG_RECORDS = loadOrgs();

loadDevVars();

const URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;

if (!URL || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed. See .dev.vars.example.');
  process.exit(1);
}

const db = createClient(URL, KEY, { auth: { persistSession: false } });

/**
 * Which template each school runs.
 *
 * A real deployment would hold this in the database and let an administrator
 * add a program. Until that screen exists, the fixtures say it here, and the
 * shape is the same: an organization, a template, and nothing else.
 */
/**
 * Who runs which program.
 *
 * An officer's role is held in a program rather than at the school (6.4), so
 * the fair's officers and the class's elders are different lists that
 * overlap. Somebody can be both, and several are: running two things is
 * normal for the students who run anything.
 *
 * Two are in one program only, so a dropdown that populates from the wrong
 * place is visible rather than merely possible.
 */
const STAFF = {
  'mvhs-scvsefa-2027': { officer: ['officer.a', 'officer.c', 'officer.d'], advisor: ['advisor.c'] },
  /* The class has its own teacher. She decides who is in it, and does not
     see the club's queue: a role scoped to a program means that program. */
  'irpd-mvhs-2027': { officer: ['officer.b', 'officer.c', 'officer.d'], advisor: ['advisor.b'] },
  'mvrj-2027': { officer: ['officer.a'] },
  /* A grant is reviewed by whoever the school puts on it, which at this size
     is one officer. */
  'grant-mvhs-micro-2027': { officer: ['officer.c'] },
  'scvsefa-2027': { officer: ['officer.a', 'officer.b'] },
  /* The state fair a regional advances to. Staffed by the school, not by
     the fair: whoever looks after a school's entries at the regional is who
     looks after the handful that go on. Without this the state fair had no
     officers at all and its queue belonged to nobody. */
  'csef-2027': { officer: ['officer.a'] },
};

/**
 * Which template each school runs, read from the organization record.
 *
 * It was written out here as well, and the two drifted exactly as the note
 * on `Org.programs` says they would: the Open Program listed
 * `independent-research` on its public calendar, this list had no entry for
 * it at all, and a student signing in there found nothing to join while the
 * page in front of them said otherwise. A prerendered calendar cannot ask a
 * database, so the record has to be the one copy and this has to read it.
 *
 * `example` has no programs and is not a tenant anybody signs in to; it
 * exists so the alternate theme is built and contrast checked.
 */
const SEASONS = Object.values(ORG_RECORDS).flatMap((record) =>
  (record.programs ?? []).map((template) => ({ org: record.id, template }))
);

/**
 * WHO OWNS A PROGRAM, AND WHAT THAT MAKES POSSIBLE.
 *
 * A regional fair is not owned by any school. `scvsefa-2027.yaml` says so at
 * the top -- *"Not owned by any school, which is why its `org_id` is null"* --
 * and `programs.org_id` says the same from the other side. It was still being
 * seeded per school, with the org that happened to list it, which had two
 * consequences.
 *
 * **Only that school could enter it.** Monta Vista's students had no fair at
 * all: `seed-cases` looks for an opportunity of kind `competition`, found
 * none, and skipped every fair entry silently. One entry seeded out of six.
 *
 * **The school layer had nowhere to go.** A school's own dates for a fair are
 * meant to sit *on* the fair as `org_id`-scoped milestones, which is what
 * `enter_program` already reads when it copies
 * `(m.org_id is null or m.org_id = v_org)`. With a forked program per school
 * there was nothing shared to layer onto.
 *
 * `level` is the discriminator and it is already in every template: `school`
 * for a class, a club or a school's own grant; `regional` and
 * `international` for something a school enters rather than runs.
 */
const isShared = (file) => (file?.level ?? 'school') !== 'school';

/**
 * Shared first, so a school template has something to layer onto.
 *
 * `orgs.ts` lists programs per school, in the order a school thinks about
 * them, and nothing there knows that Monta Vista's club depends on a fair
 * the council happens to list. Sorting here rather than reordering `orgs.ts`
 * keeps that ordering a fact about seeding instead of a trap in the config.
 */
function orderedSeasons(library) {
  const sharedFirst = [];
  const rest = [];

  for (const season of SEASONS) {
    (isShared(library.programs.get(season.template)) ? sharedFirst : rest).push(season);
  }

  return [...sharedFirst, ...rest];
}

/**
 * A step's kind, for the column the schema already has.
 *
 * The template says what a step *does*; this column predates it and says what
 * sort of thing it is. Derived rather than declared, because asking every
 * template author to classify a step into five buckets they did not choose
 * would be asking them to know about our schema.
 */
/* The deliverable a step asks for, by the id the template uses.
 *
 * The first where a step wants several, because that is the one the deadline
 * is named for and the one a reader is looking for on the row. Null where a
 * step hands nothing over. */
function deliverableRef(step) {
  const first = (step.deliverables ?? [])[0];
  return first ? (first.ref ?? first.id ?? null) : null;
}

function kindOf(step) {
  if (step.consequence === 'blocks_experimentation') return 'approval';
  if (step.consequence === 'blocks_registration') return 'registration';
  if (step.consequence === 'blocks_competition') return 'submission';
  if (/judg/i.test(step.name)) return 'judging';

  /* A club's own step is never an event. The club put it in the calendar
     because somebody has to do something, whether or not a deliverable was
     declared for it — "ask a teacher to sponsor" has nothing to hand in and
     is the single most important thing in October. */
  if (step.internal) return 'local';

  /* Nothing to hand in, nothing at stake, and nobody's own step: a day on
     the calendar rather than an obligation. Applications open, results are
     announced. A student counting down to one learns nothing they can act
     on, so the interface skips them when it asks what is next. */
  const nothingDue = (step.deliverables ?? []).length === 0;
  const nothingAtStake = !step.consequence || step.consequence === 'none';
  if (nothingDue && nothingAtStake && !step.repeats) return 'event';

  if ((step.deliverables ?? []).some((d) => (d.ref ?? d.id ?? '').includes('form'))) return 'form';
  return 'submission';
}

async function main() {
  const library = loadLibrary();

  const { data: orgs, error: orgError } = await db
    .from('organizations')
    .select('id, slug, lockup_name');

  /* A select naming a column that does not exist returns an error and no
     rows, and reading only `data` turns that into "no organizations" — which
     is what happened: every program was skipped for a school that was there
     all along. */
  if (orgError) {
    console.error(`Could not read the organizations: ${orgError.message}`);
    process.exit(1);
  }
  if (!orgs?.length) {
    console.error('No organizations. Run the demo seed first.');
    process.exit(1);
  }

  const bySlug = new Map(orgs.map((o) => [o.slug, o]));

  /* Every fixture account, by address. Officer roles are scoped to a
     program, so they are granted here rather than in the demo seed, which
     runs before any program exists. */
  const byEmail = new Map();
  let page = 1;

  while (true) {
    const { data: list, error: listError } = await db.auth.admin.listUsers({
      page,
      perPage: 200,
    });

    if (listError) {
      console.error(`Could not read the accounts: ${listError.message}`);
      process.exit(1);
    }

    for (const user of list.users) {
      if (user.email) byEmail.set(user.email, user.id);
    }

    if (list.users.length < 200) break;
    page += 1;
  }

  /* Everything seeded from a template goes, so a renamed step does not leave
     its old self behind. `template_id` is what marks a row as derived. */
  const { data: existing, error: existingError } = await db
    .from('programs')
    .select('id')
    .not('template_id', 'is', null);

  if (existingError) {
    console.error(`Could not read the existing programs: ${existingError.message}`);
    process.exit(1);
  }

  if (existing?.length) {
    const ids = existing.map((p) => p.id);

    /* Anything already taking part stops this. `participations` references
       `programs` with ON DELETE RESTRICT, deliberately: a program with
       projects in it is not something to quietly replace, because the
       participations and their copied deadlines hang off it.
       
       So say what is in the way rather than deleting what can be deleted and
       colliding on the insert.
       
       **This counted `opportunity_participations`**, which is the view that
       excludes classes — so a project attached to a class or a club passed
       the guard unseen, and the delete below then hit the restrict and
       failed with a foreign key message naming a constraint instead of the
       sentence written here to explain it. Same blind spot as the notebook
       export had (22.25) and as 22.19's silent skip: after the merge, every
       reader of the narrower thing has to be found rather than the ones
       somebody noticed. The table, because the question is "is anything
       attached", and both kinds are. */
    const { count: participations } = await db
      .from('participations')
      .select('id', { count: 'exact', head: true })
      .in('program_id', ids);

    if (participations && participations > 0) {
      console.error(
        `\n${participations} project${participations === 1 ? ' is' : 's are'} already taking part ` +
          'in a program seeded from a template.\n\n' +
          'Rewriting the programs would orphan them, so this stops here.\n' +
          'Run `npm run reset`, which rebuilds everything in order.\n'
      );
      process.exit(1);
    }

    const { error: milestoneError } = await db
      .from('program_milestones')
      .delete()
      .in('program_id', ids);

    if (milestoneError) {
      console.error(`Could not clear the old deadlines: ${milestoneError.message}`);
      process.exit(1);
    }

    const { error: programError } = await db.from('programs').delete().in('id', ids);

    if (programError) {
      console.error(`Could not clear the old programs: ${programError.message}`);
      process.exit(1);
    }
  }

  console.log('\nPrograms from templates\n');

  /* template id -> the one program row for it, for the layering below. */
  const sharedPrograms = new Map();

  /**
   * A school's own dates, written onto a shared program.
   *
   * Only `internal` steps: the rest of what a school template resolves to is
   * the fair's own, already on the shared row with a null `org_id`, and
   * writing it again would show a student every compliance deadline twice.
   */
  const layerSchoolDates = async (programId, org, dates) => {
    const rows = dates
      .filter((d) => d.date && d.step.internal)
      .map((d, index) => ({
        program_id: programId,
        org_id: org.id,
        name: d.step.name,
        kind: kindOf(d.step),
        due_on: d.date,
        required: d.step.applies_when ? false : true,
        blocks_experimentation: d.step.consequence === 'blocks_experimentation',
        notes: d.step.note ?? d.step.risk ?? null,
        sort_order: Math.round((d.step.order ?? index) * 10),
        /* Always the school's, whatever the step called itself: on a shared
           program that is what `org_id` being set means. */
        source: 'school',
        phase: d.step.phase ?? null,
        satisfied_by:
          d.step.id === 'club_sponsor' || d.step.id === 'sponsor' ? 'sponsor' : null,
        deliverable_ref: deliverableRef(d.step),
      }));

    if (!rows.length) return 0;

    const { error } = await db.from('program_milestones').insert(rows);
    if (error) console.error(`  layering ${org.slug}'s dates: ${error.message}`);
    return rows.length;
  };

  /**
   * Staff, scoped to one program and one school.
   *
   * Extracted because a shared program is seeded once and staffed many
   * times: the council's fair officers are its own, on the same row Monta
   * Vista's sit on, and `user_roles.org_id` is what keeps the two apart.
   * While this lived inline after the insert, the second school reached it
   * only through the branch that creates a program -- so the school that did
   * not create the shared row got no officers at all, and its approval queue
   * was invisible to the people who run it.
   */
  const grantStaff = async (programId, org, template) => {
    const staff = STAFF[template] ?? {};
    const assignments = Object.entries(staff).flatMap(([role, handles]) =>
      handles.map((handle) => ({ role, handle }))
    );
    let granted = 0;

    for (const { role, handle } of assignments) {
      /* Through the auth directory, which is where a fixture's address
         lives. It looked in `identities`, which holds Google sign-ins and is
         empty for every fixture: the lookup found nobody, granted nothing,
         and said nothing. */
      const userId = byEmail.get(`${org.slug}.${handle}@demo.invalid`);

      if (!userId) {
        console.error(`  no account for ${handle}, so no ${role} role`);
        continue;
      }

      const { error: grantError } = await db.from('user_roles').insert({
        org_id: org.id,
        user_id: userId,
        role,
        scope_id: programId,
      });

      if (grantError) {
        console.error(`  ${template}: could not grant ${handle} (${grantError.message})`);
      } else {
        granted += 1;
      }
    }

    return granted;
  };

  for (const season of orderedSeasons(library)) {
    const org = bySlug.get(season.org);
    if (!org) {
      console.log(
        `  skipped ${season.template}: no organization "${season.org}"` +
          ` (have: ${[...bySlug.keys()].join(', ')})`
      );
      continue;
    }

    /**
     * Resolved against a floor, so `phases` is never empty.
     *
     * Resolved with no process at all, a template that declares no phases of
     * its own gets none — and no fair declares any, because they tag their
     * steps with `process-science` ids and borrow that vocabulary (23.3). The
     * column was written as `[]` for every fair, and sixteen deadlines
     * rendered under one unnamed heading.
     *
     * The floor is the default rather than a guess: a project that names no
     * process gets `process-science` from `start_project`, so this row now
     * agrees with what the ordinary project actually resolves.
     *
     * **It is still a snapshot and still cannot be right for everybody.** The
     * process belongs to the project (22.4), so an engineering project reads
     * different phases off the same fair — which is why the participation
     * page resolves per project and reads this column only for the window a
     * teacher published. This makes the fallback sensible instead of empty;
     * it does not make it authoritative.
     *
     * `resolved.processId` is passed where the template names one, which
     * keeps IRPD on its own steps: the resolver turns a process naming its
     * own template into `own` rather than looking for `process-irpd`.
     */
    const declared = resolveProgram(season.template, library);
    const resolved = resolveProgram(
      season.template,
      library,
      declared.processId ?? 'science'
    );
    const dates = datesFor(resolved);
    const file = library.programs.get(season.template);
    const shared = isShared(file);

    /* Seeded once. A second school listing the same fair layers its own
       dates onto the row that is already there rather than forking it. */
    if (shared && sharedPrograms.has(season.template)) {
      const programId = sharedPrograms.get(season.template);
      const layered = await layerSchoolDates(programId, org, dates);
      const staffed = await grantStaff(programId, org, season.template);

      console.log(`  ${org.lockup_name}`);
      console.log(`    ${resolved.name}`);
      console.log(
        `    shared · ${layered} of this school's own ` +
          `${layered === 1 ? 'deadline' : 'deadlines'} layered on` +
          (staffed ? ` · ${staffed} staff` : '')
      );
      console.log('');
      continue;
    }

    const { data: program, error } = await db
      .from('programs')
      .insert({
        org_id: shared ? null : org.id,
        slug: resolved.id,
        name: resolved.name,
        season_year: file.season ?? new Date().getFullYear(),
        family: resolved.family ?? null,
        kind: resolved.kind,
        template_id: season.template,

        /* Which research process a project started here should follow. The
           template already says, and the resolver already worked it out;
           this is the row learning it, so `app.process_for` has something to
           read at creation (22.4). */
        process_id: resolved.processId ?? null,

        /* Which of the two things this program is (22.2). The template says;
           the row learns it, so `memberships` can refuse an opportunity and
           `entries` can refuse a cohort. */
        program_role: resolved.role ?? 'opportunity',
        version: resolved.version,
        level: file.level ?? null,
        anchors: resolved.anchors,
        staff_from: file.staff_from ?? [],
        /* The phases, resolved. A window is a teacher saying when the class
           does this, so it travels with them. */
        phases: resolved.phases.map((phase) => ({
          id: phase.id,
          name: phase.name ?? phase.id,
          window: phase.window ?? null,
        })),
        /* What this program calls its people. The resolver already merges
           the chain and falls back to Officer and Student, so a template
           that says nothing still writes a usable pair. */
        roles: resolved.roles,
        publishes_to: file.publishes_to ?? null,
        current: true,
        joining: file.joining ?? 'open',
        places: file.limits?.places ?? file.places ?? null,
        source: 'external',
        status: 'open',
        description: file.description ?? null,
        website_url: file.url ?? null,
        fair_date: resolved.anchors.fair ?? null,
        selection_cap: resolved.limits?.selection_cap ?? null,
      })
      .select('id')
      .single();

    if (error) {
      console.error(`  ${season.template}: ${error.message}`);
      continue;
    }

    /* Every step with a date, however it got one.
     
       A phase window is a teacher saying when the class does this, so it
       resolves to the last day of the month they named. Dropping those
       because they carry no explicit date cost the course six of its eight
       milestones, which is most of a year's work.
     
       What is still dropped is a step nobody has scheduled at all, because a
       null date in this table reads as overdue. */
    const rows = dates
      .filter((d) => d.date)
      .map((d, index) => ({
        program_id: program.id,
        /* A club's own deadline is scoped to the school; the institution's is
           not, because every school entering that fair shares it. */
        org_id: d.step.internal ? org.id : null,
        name: d.step.name,
        kind: kindOf(d.step),
        due_on: d.date,
        required: d.step.applies_when ? false : true,
        blocks_experimentation: d.step.consequence === 'blocks_experimentation',
        /* Where the date came from, in the note, because a deadline derived
           from a phase and one read off a fair's calendar are not the same
           kind of promise and a student should be able to tell. */
        notes: [
          d.source === 'window' && d.window
            ? `From the ${d.window.from} to ${d.window.to} phase.`
            : null,
          d.step.note ?? d.step.risk ?? null,
        ]
          .filter(Boolean)
          .join(' ') || null,
        sort_order: Math.round((d.step.order ?? index) * 10),
        /* The layer that contributed the step: the research process, the
           institution, or the school's own club. Tagged during resolution. */
        source: d.step.source ?? (d.step.internal ? 'school' : 'program'),
        phase: d.step.phase ?? null,
        satisfied_by: d.step.id === 'club_sponsor' || d.step.id === 'sponsor' ? 'sponsor' : null,
        deliverable_ref: deliverableRef(d.step),
      }));

    if (rows.length) {
      const { error: milestoneError } = await db.from('program_milestones').insert(rows);
      if (milestoneError) console.error(`  ${season.template}: ${milestoneError.message}`);
    }

    if (shared) sharedPrograms.set(season.template, program.id);

    /* **The school layer, on the shared fair. 6.8.**
    
       A club's own dates are offsets from the fair's anchors, and a student
       who enters the fair should see both in one list: the fair's five
       compliance steps and the club's dozen in between. That union is
       already implemented -- `enter_program` copies
       `(m.org_id is null or m.org_id = v_org)` -- and what it needed was a
       shared program to layer onto.
    
       Written from the school's own template rather than invented, so the
       club's November plan deadline is one fact appearing in two places
       rather than two facts that can disagree. */
    const base = file?.extends;
    let layeredOnBase = 0;
    if (!shared && base && sharedPrograms.has(base)) {
      layeredOnBase = await layerSchoolDates(sharedPrograms.get(base), org, dates);
    }

    const granted = await grantStaff(program.id, org, season.template);

    const undated = dates.length - rows.length;

    console.log(`  ${org.lockup_name}`);
    console.log(`    ${resolved.name}`);
    console.log(
      `    ${shared ? 'shared · ' : ''}` +
        `${resolved.kind} · ${rows.length} dated ${rows.length === 1 ? 'deadline' : 'deadlines'}` +
        (undated ? `, ${undated} steps with no date yet` : '') +
        (granted ? ` · ${granted} staff from this school` : '')
    );
    if (layeredOnBase) {
      console.log(`    ${layeredOnBase} of them also layered onto ${base}`);
    }

    const gates = resolved.steps.filter((s) => s.consequence === 'blocks_experimentation');
    if (gates.length) {
      console.log(`    ${gates.length} of them must precede the work`);
    }
    console.log('');
  }

  /* ── The gates, resolved once every program exists ───────────────────────
   *
   * `prepares_for`, `open_to_cohort` and `reached_by_advancing` are what
   * `app.entry_gate` reads, and **none of the three was ever written**. The
   * resolver has produced `preparesFor` and `openToCohort` all along and the
   * insert above dropped them, so the class's showcase was open to the
   * school and the club stood between nobody and the fair. The rule existed
   * in the schema, in the function, and in the brief; the only place it did
   * not exist was the data.
   *
   * A second pass because these point at other programs: a club cannot name
   * the fair it prepares for until the fair has an id.
   */
  const { data: seeded } = await db
    .from('programs')
    .select('id, template_id, org_id, name')
    .not('template_id', 'is', null);

  /* Same school first, then the shared row. A club prepares for *its*
     school's edition where one exists, and for the shared fair otherwise. */
  const programFor = (templateId, orgId) =>
    (seeded ?? []).find((p) => p.template_id === templateId && p.org_id === orgId) ??
    (seeded ?? []).find((p) => p.template_id === templateId && p.org_id === null);

  /* Every template some other template advances to. Read off `advances_to`,
     so the chain is declared once. */
  const advancementTargets = new Set();
  for (const [, file] of library.programs) {
    for (const step of file.advances_to ?? []) {
      if (step?.program) advancementTargets.add(step.program);
    }
  }

  let gated = 0;

  for (const row of seeded ?? []) {
    const file = library.programs.get(row.template_id);
    if (!file) continue;

    const patch = {};

    const prepares = file.prepares_for && programFor(file.prepares_for, row.org_id);
    if (prepares) patch.prepares_for = prepares.id;

    const only = file.open_to_cohort && programFor(file.open_to_cohort, row.org_id);
    if (only) patch.open_to_cohort = only.id;

    /* `advances_to` names a family (`csef`), and the template that is that
       family carries the season (`csef-2027`). */
    if (advancementTargets.has(file.family) || advancementTargets.has(row.template_id)) {
      patch.reached_by_advancing = true;
    }

    if (!Object.keys(patch).length) continue;

    const { error } = await db.from('programs').update(patch).eq('id', row.id);
    if (error) console.error(`  gates for ${row.template_id}: ${error.message}`);
    else gated += 1;
  }

  if (gated) {
    console.log(`${gated} programs have a way in that is not simply "apply".\n`);
  }

  console.log('Every deadline above came from src/config/programs/.\n');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
