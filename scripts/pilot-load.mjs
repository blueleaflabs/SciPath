#!/usr/bin/env node
/**
 * A CLASS, LOADED BEFORE ITS FIRST SIGN-IN.
 *
 * The IRPD pilot starts with every student already in the software: an
 * account on their school address, membership of the class, a project with
 * the class's deadlines copied onto it, and their two Elders assigned. The
 * teachers hold the advisor role. Nobody has typed anything.
 *
 * This is the one seed that writes real people, and it is separate from the
 * fixtures on purpose. `seed-demo`, `seed-scenarios` and `seed-cases` invent
 * people and refuse a deployed project; `seed-people` writes staff with
 * passwords. This writes a roster from `local-data/pilot-irpd.yaml`, which
 * is gitignored because it names minors, and its shape is documented in
 * `src/config/pilot.example.yaml`.
 *
 * ── Why the first sign-in needs nothing from the student ──────────────────
 *
 * Every account is created through the admin API on the person's own
 * address, confirmed, with no password. On the first "Sign in with Google"
 * the provider returns that address verified, and Supabase links the Google
 * identity to the account already holding it (6.3). The session then meets
 * a `users` row that exists, so the middleware never sends them to the
 * signup screen: they land on `/app/` with their project already there.
 *
 * ── What is written directly, and what is not ─────────────────────────────
 *
 * Tables, on the service key, the way every seed writes. The functions the
 * screens call read `auth.uid()`, and a script has none; `act-as` signs in
 * as a fixture with a password, and these people have no password and must
 * not be given one. So the rows are written as the functions would write
 * them, and the two places that matters are said: a participation copies
 * the class's calendar exactly as `app.copy_milestones` does, and an Elder
 * on their own project is marked `self_managed_at` exactly as
 * `assign_officer` marks it (6.10).
 *
 * ── Consent ───────────────────────────────────────────────────────────────
 *
 * `consent: school`: the class runs under the school and the teachers stand
 * as the adults, so every student is `consent_state: active` and an audit
 * line records that the school provided it. No guardian is mailed. Any other
 * value is refused, because the guardian flow is a different arrangement
 * and this script is not the place to half-build it.
 *
 * ── Where it may run ──────────────────────────────────────────────────────
 *
 * Locally, into any organization, which is how the load is rehearsed
 * against the demonstration tenant before Thursday. Against the cloud only
 * with `--cloud`, and only when `.cloud.vars` names the target as the
 * pilot project: a roster of real students goes into the project that holds
 * real students and nowhere else. The rule is positive, like 19.13's: not
 * knowing which project is the pilot is a refusal, not a pass.
 *
 * Safe to run twice. People are matched by address, memberships and
 * participations are upserts on their unique keys, and a project is matched
 * by title and first author. Anything already there is left alone and
 * reported as such.
 *
 *   node scripts/pilot-load.mjs --org demo        # local rehearsal
 *   node scripts/pilot-load.mjs --org demo --password scipath!   # and sign in as anybody
 *   node scripts/pilot-load.mjs --cloud           # the pilot
 *   node scripts/pilot-load.mjs --check           # read the file, write nothing
 *   node scripts/pilot-load.mjs --grant-through 2026-09-03   # override the file's date
 *
 * GRANTING. A class that starts on the software mid-cycle has done the
 * early steps already: the topics were seeded because the topic work was
 * done. Loading the calendar as written made every one of those steps late
 * on day one, which blurs the record the pilot is there to keep. The file
 * carries `granted_through: 2026-09-03` (the flag overrides it), and on
 * the load every student obligation due on or before that date
 * that is still open is completed on its own due date, by the first
 * teacher on the sheet, and each required deliverable it wants is recorded
 * as a row with no file and no link, labeled as granted at the pilot's
 * start and verified by that teacher. Nothing is late, nothing is in the
 * inbox, the Elders' tasks that wait on those steps become ready, and the
 * label on every granted row says what it is. Tracking is real from DATE.
 * Idempotent: a step already complete is left alone.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import yaml from 'js-yaml';
import { createClient } from '@supabase/supabase-js';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';
import { loadLibrary } from './template-library.mjs';
import { resolveProgram, deliverablesFor } from '../src/lib/template-resolve.ts';

const args = process.argv.slice(2);
const cloud = args.includes('--cloud');
const checkOnly = args.includes('--check');
const orgArg = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;
const FILE = args.includes('--file') ? args[args.indexOf('--file') + 1] : 'local-data/pilot-irpd.yaml';
/* A password on every account. On the local stack it is the rehearsal: sign
   in as a teacher or any student at demo.localhost without their Google
   account.

   **On the cloud it is a testing phase, and it has to be said twice.** The
   pilot's accounts belong to minors and are meant to be entered through
   Google only; a password every tester knows is a way into every student's
   account for as long as it stands. So `--cloud --password` is refused
   unless `--testing-phase` is also given, an audit line is written on every
   account it touches, and `--forget-passwords` is the way back: it sets each
   account's password to a random string nobody holds, which is the nearest
   thing to removing one, and writes the audit line for that too. Run it
   before the class arrives. */
const PASSWORD = args.includes('--password') ? args[args.indexOf('--password') + 1] : null;
const TESTING_PHASE = args.includes('--testing-phase');
const FORGET = args.includes('--forget-passwords');
const GRANT_ARG = args.includes('--grant-through') ? args[args.indexOf('--grant-through') + 1] : null;
if (GRANT_ARG && !/^\d{4}-\d{2}-\d{2}$/.test(GRANT_ARG)) fail('--grant-through wants a date, YYYY-MM-DD.');

if (cloud) loadCloudVars();
else loadDevVars();

function fail(message) {
  console.error(`\n  ${message.replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

/* ── The file ──────────────────────────────────────────────────────────── */

if (!fs.existsSync(FILE)) {
  fail(
    `No ${FILE}.\n\n` +
      `Copy src/config/pilot.example.yaml to it and fill in the roster. It is\n` +
      `gitignored because it names students.`
  );
}

const doc = yaml.load(fs.readFileSync(FILE, 'utf8')) ?? {};
const orgSlug = orgArg ?? doc.org;
const problems = [];

if (!orgSlug) problems.push('org is not set, and no --org was given');
if (!doc.cohort) problems.push('cohort is not set');
if (doc.consent !== 'school') {
  problems.push(
    `consent is "${doc.consent ?? ''}", and the only arrangement this loads is "school".\n` +
      `  A class whose guardians are asked individually uses the ordinary signup flow.`
  );
}
if (!Number.isInteger(doc.graduating_year)) problems.push('graduating_year must be a year, e.g. 2027');

const studentDomain = String(doc.student_domain ?? '').toLowerCase();
const staffDomain = String(doc.staff_domain ?? '').toLowerCase();
if (!studentDomain) problems.push('student_domain is not set');
if (!staffDomain) problems.push('staff_domain is not set');

const teachers = doc.teachers ?? [];
const groups = doc.groups ?? [];
const projects = doc.projects ?? [];
/* The day the class started, which is the day every project in it started.
   A project with no start date reads as "not set" on every screen and
   `checkDateOrder` has nothing to check the sponsor's signature against. The
   file may say; the class's first day is the default. */
/* A bare `2026-08-17` in YAML parses as a timestamp, not a string, so both
   dates are read back to the day they name whichever way they were typed. */
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).trim().slice(0, 10));
const STARTED_ON = dayOf(doc.started_on) ?? '2026-08-17';
if (!/^\d{4}-\d{2}-\d{2}$/.test(STARTED_ON)) problems.push(`started_on "${STARTED_ON}" is not a date (YYYY-MM-DD)`);
/* The day through which the class's work is granted as done (see GRANTING
   in the header). Part of the file, because it is a fact about the class
   and the load is one package; the flag overrides it for a rehearsal. */
const GRANT_THROUGH = GRANT_ARG ?? dayOf(doc.granted_through);
if (GRANT_THROUGH && !/^\d{4}-\d{2}-\d{2}$/.test(GRANT_THROUGH)) problems.push(`granted_through "${GRANT_THROUGH}" is not a date (YYYY-MM-DD)`);
if (GRANT_THROUGH && GRANT_THROUGH < STARTED_ON) problems.push(`granted_through ${GRANT_THROUGH} is before started_on ${STARTED_ON}`);

/** Every person by key, and the checks a roster has to pass before a single row is written. */
const people = new Map();
const emails = new Map();

function person(row, kind, where) {
  const key = String(row?.key ?? '').trim();
  const name = String(row?.name ?? '').replace(/\s+/g, ' ').trim();
  const email = String(row?.email ?? '').trim().toLowerCase();
  if (!key) problems.push(`${where}: a ${kind} has no key`);
  if (!name) problems.push(`${where}: ${key || '(no key)'} has no name`);
  if (!email) problems.push(`${where}: ${key || name} has no email. Every address must be filled in before this runs.`);
  else if (!/^[^@\s]+@[^@\s]+$/.test(email)) problems.push(`${where}: ${key} has an address that is not one: ${email}`);
  else {
    const domain = email.split('@')[1];
    const wanted = kind === 'teacher' ? staffDomain : studentDomain;
    if (domain !== wanted) problems.push(`${where}: ${email} is not on ${wanted}`);
    if (emails.has(email)) problems.push(`${where}: ${email} appears twice (${emails.get(email)} and ${key})`);
    emails.set(email, key);
  }
  if (people.has(key)) problems.push(`${where}: key ${key} is used twice`);

  const entry = { key, name, email, kind, grade: row?.grade ?? null, group: null };
  if (kind === 'student') {
    if (!Number.isInteger(entry.grade) || entry.grade < 9 || entry.grade > 12) {
      problems.push(`${where}: ${key} needs a grade from 9 to 12`);
    }
  }
  people.set(key, entry);
  return entry;
}

for (const [i, t] of teachers.entries()) person(t, 'teacher', `teachers[${i}]`);
if (teachers.length === 0) problems.push('no teachers listed');

/* **The family scores, from the class tracker (2.8).** One row per student
   per step: the Elder's number out of 4 and a comment. `student` and `by`
   are keys from the groups (a full name is accepted too); `step` is the
   step's id in the template; `on` is the day it was given. Loaded as the
   Elder's assessment on that step, released at once, the way the tracker
   page writes one. */
const scores = Array.isArray(doc.scores) ? doc.scores : [];
for (const [i, sc] of scores.entries()) {
  const where = `scores[${i}]`;
  if (!sc?.student) problems.push(`${where}: no student`);
  if (!sc?.step) problems.push(`${where}: no step`);
  if (sc?.score == null || Number.isNaN(Number(sc.score)) || Number(sc.score) < 0 || Number(sc.score) > 4) problems.push(`${where}: score must be 0 to 4`);
  /* YAML reads a bare 2026-08-24 as a Date; `dayOf` takes either. */
  if (sc?.on != null) {
    sc.on = dayOf(sc.on);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sc.on)) problems.push(`${where}: on "${sc.on}" is not a date (YYYY-MM-DD)`);
  }
}

for (const [gi, g] of groups.entries()) {
  const where = `groups[${gi}]${g?.name ? ` (${g.name})` : ''}`;
  if (!g?.name) problems.push(`${where}: no name`);
  for (const s of g.students ?? []) {
    const p = person(s, 'student', where);
    p.group = g.name;
  }
  const elders = g.elders ?? [];
  if (elders.length === 0) problems.push(`${where}: no elders`);
  for (const e of elders) {
    const p = people.get(e);
    if (!p) problems.push(`${where}: elder ${e} is not a student anywhere in the file`);
    else if (p.group !== g.name) problems.push(`${where}: elder ${e} is in ${p.group}, and an Elder oversees their own group`);
  }
}

const authored = new Set();
for (const [pi, pr] of projects.entries()) {
  const where = `projects[${pi}]`;
  const title = String(pr?.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) problems.push(`${where}: no title`);
  const authors = pr?.authors ?? [];
  if (authors.length === 0) problems.push(`${where} (${title}): no authors`);
  for (const a of authors) {
    const p = people.get(a);
    if (!p) problems.push(`${where} (${title}): author ${a} is not in the file`);
    else if (p.kind !== 'student') problems.push(`${where} (${title}): ${a} is a teacher, and a teacher does not author a student's project`);
    authored.add(a);
  }
  const groupsOf = new Set(authors.map((a) => people.get(a)?.group).filter(Boolean));
  if (groupsOf.size > 1) problems.push(`${where} (${title}): its authors are in different groups (${[...groupsOf].join(', ')}), so it has no single pair of Elders`);
  pr.title = title;
}
for (const p of people.values()) {
  if (p.kind === 'student' && !authored.has(p.key)) problems.push(`${p.key} (${p.name}) has no project`);
}
/* Two rows with one title are two projects with one name, which is
   almost never what was meant: a pair working together is one row with
   two keys in `authors`, and everything that belongs to the project (the
   documents, the notebook, the calendar, the showcase card, the Elders)
   is then shared, while the scores and grades stay per student (2.8). */
{
  const byTitle = new Map();
  for (const pr of projects) byTitle.set(pr.title.toLowerCase(), [...(byTitle.get(pr.title.toLowerCase()) ?? []), pr]);
  for (const [, same] of byTitle) {
    if (same.length > 1) {
      problems.push(
        `"${same[0].title}" appears ${same.length} times. Partners share one project: one row, authors: [${same.flatMap((x) => x.authors).join(', ')}]`
      );
    }
  }
}

if (problems.length > 0) {
  fail(`${FILE} is not ready:\n\n  - ${problems.join('\n  - ')}\n\nNothing has been written.`);
}

const students = [...people.values()].filter((p) => p.kind === 'student');
const elderKeys = new Set(groups.flatMap((g) => g.elders));

console.log(
  `\n${FILE}: ${teachers.length} teachers, ${students.length} students in ${groups.length} groups, ` +
    `${elderKeys.size} Elders, ${projects.length} projects ` +
    `(${projects.filter((p) => p.authors.length > 1).length} shared).`
);

if (checkOnly) {
  console.log(`\n--check: the file reads cleanly. ${GRANT_THROUGH ? `Work through ${GRANT_THROUGH} will be granted as done.` : 'No granted_through; every dated step loads open.'} Nothing written.\n`);
  process.exit(0);
}

/* ── The target ────────────────────────────────────────────────────────── */

const URL_ = process.env.PUBLIC_SUPABASE_URL ?? '';
const SECRET = process.env.SUPABASE_SECRET_KEY ?? '';
if (!URL_ || !SECRET) fail(`PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed, from ${cloud ? '.cloud.vars' : '.dev.vars'}.`);

const ref = URL_.match(/^https?:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1] ?? null;
const loopback = /localhost|127\.0\.0\.1|host\.docker\.internal/.test(URL_);

if (cloud && PASSWORD && !TESTING_PHASE) {
  fail(
    '--password against the cloud puts one shared password on every student\'s\n' +
      'account. For the testing phase, say so: add --testing-phase. Before the\n' +
      'class arrives, run again with --forget-passwords.'
  );
}
if (PASSWORD && FORGET) fail('--password and --forget-passwords together make no sense.');
if (PASSWORD && PASSWORD.length < 10) fail('A password shorter than ten characters is refused.');

if (cloud) {
  const pilot = (process.env.PILOT_PROJECT_REF ?? '').trim();
  if (!ref) fail(`--cloud, and ${URL_} is not a Supabase project address.`);
  if (!pilot) {
    fail(
      'PILOT_PROJECT_REF is not set in .cloud.vars, so this cannot tell whether\n' +
        `${ref} is the project the class runs on. A roster of real students goes\n` +
        'into the pilot project and nowhere else. Set it, even if it is the only\n' +
        'project there is. Nothing has been written.'
    );
  }
  if (ref !== pilot) {
    fail(`${ref} is not the pilot project (${pilot}). Real students go into the pilot project only. Nothing has been written.`);
  }
} else if (!loopback) {
  fail(
    `${URL_} is not the local stack. To load the pilot project use --cloud, which\n` +
      'reads .cloud.vars and checks the target against PILOT_PROJECT_REF.'
  );
}

const db = createClient(URL_, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) fail(`${what}: ${error.message}`);
  return data;
}

const org = await must(
  db.from('organizations').select('id, slug, lockup_name').eq('slug', orgSlug).maybeSingle(),
  'reading the organization'
);
if (!org) fail(`No organization "${orgSlug}" in ${cloud ? ref : 'the local stack'}. Run seed-orgs first.`);

const programRows = await must(
  db.from('programs').select('id, name, template_id, org_id, program_role, process_id').eq('template_id', doc.cohort),
  'reading the programs'
);
const cohort =
  (programRows ?? []).find((r) => r.org_id === org.id) ?? (programRows ?? []).find((r) => r.org_id === null);
if (!cohort) fail(`${org.slug} has no program from template "${doc.cohort}". Run seed-programs first.`);
if (cohort.program_role !== 'cohort') fail(`${cohort.name} is not a cohort, and a class is one.`);

const milestoneRows = await must(
  db
    .from('program_milestones')
    .select('id, name, kind, due_on, required, blocks_experimentation, satisfied_by, sort_order, source, phase, org_id, owner, step_id, requires_step, requires_steps, feedback_on')
    .eq('program_id', cohort.id)
    .order('sort_order'),
  'reading the class calendar'
);
const calendar = (milestoneRows ?? []).filter((m) => !m.org_id || m.org_id === org.id);

/* The template, resolved the way the participation page resolves it, so a
   granted step records exactly the deliverables the page will look for. */
const resolvedTemplate = GRANT_THROUGH
  ? resolveProgram(cohort.template_id, loadLibrary(), cohort.process_id ?? null)
  : null;

console.log(`\nInto ${org.lockup_name} (${org.slug}) at ${cloud ? ref : 'the local stack'}: ${cohort.name}, ${calendar.length} deadlines per project.\n`);

/* ── Accounts ─────────────────────────────────────────────────────────── */

/* One listing, up front. A person created on an earlier run is found here
   rather than by a create that fails and a second listing per person. */
const listed = await must(db.auth.admin.listUsers({ perPage: 1000 }), 'listing accounts');
const byEmail = new Map((listed?.users ?? []).map((u) => [String(u.email ?? '').toLowerCase(), u.id]));

const gradYear = (grade) => doc.graduating_year + (12 - grade);
const now = new Date().toISOString();
const counts = { accounts: 0, existing: 0, roles: 0, memberships: 0, projects: 0, projectsExisting: 0, elders: 0, sponsors: 0 };

async function audit(action, entityType, entityId, after, reason) {
  /* `audit_log` takes inserts from the service role and refuses updates and
     deletes from everyone; a seed of real people leaves the same trail a
     screen would. `actor_user_id` is null: this was the school, by script. */
  const { error } = await db.from('audit_log').insert({
    org_id: org.id,
    action,
    entity_type: entityType,
    entity_id: entityId,
    after,
    reason,
  });
  if (error) console.log(`    (audit line not written: ${error.message})`);
}

async function ensureAccount(p) {
  let id = byEmail.get(p.email);
  if (id) {
    counts.existing += 1;
  } else {
    /* No password. The only way into this account is Google, with the
       address the school issued. `pilot: true` is a marker and not a
       fixture flag: `wipe-demo` reads `demo`, and these must never match. */
    const created = await must(
      db.auth.admin.createUser({
        email: p.email,
        email_confirm: true,
        ...(PASSWORD ? { password: PASSWORD } : {}),
        user_metadata: { full_name: p.name, pilot: true },
      }),
      `creating ${p.email}`
    );
    id = created.user.id;
    byEmail.set(p.email, id);
    counts.accounts += 1;
  }
  if (PASSWORD) {
    await must(db.auth.admin.updateUserById(id, { password: PASSWORD }), `setting the password on ${p.email}`);
    if (cloud) await audit('password.set_by_script', 'users', id, { testing_phase: true }, 'Shared testing password, --testing-phase.');
  } else if (FORGET) {
    /* Forty random characters nobody is shown. The credential still exists,
       so Google sign-in and the reset link are unaffected. */
    const gone = crypto.randomBytes(30).toString('base64url');
    await must(db.auth.admin.updateUserById(id, { password: gone }), `forgetting the password on ${p.email}`);
    await audit('password.forgotten_by_script', 'users', id, { cloud }, 'Testing password replaced by one nobody holds.');
    counts.forgotten = (counts.forgotten ?? 0) + 1;
  }

  const student = p.kind === 'student';
  await must(
    db.from('users').upsert(
      {
        id,
        org_id: org.id,
        display_name: p.name,
        population: student ? 'student' : 'staff',
        status: 'active',
        affiliation_state: 'domain_verified',
        affiliation_verified_at: now,
        consent_state: student ? 'active' : 'not_required',
        consent_requested_at: null,
        age_band: student ? '13_17' : '18_plus',
        age_attested_at: now,
        grad_year: student ? gradYear(p.grade) : null,
      },
      { onConflict: 'id' }
    ),
    `writing the users row for ${p.email}`
  );
  p.id = id;
  return id;
}

async function ensureRole(p, role, scopeId) {
  let query = db.from('user_roles').select('id').eq('user_id', p.id).eq('role', role).is('revoked_at', null);
  query = scopeId ? query.eq('scope_id', scopeId) : query.is('scope_id', null);
  const held = await must(query.maybeSingle(), `reading ${role} for ${p.email}`);
  if (held) return false;
  await must(
    db.from('user_roles').insert({ org_id: org.id, user_id: p.id, role, scope_id: scopeId ?? null }),
    `granting ${role} to ${p.email}`
  );
  counts.roles += 1;
  return true;
}

console.log('Teachers');
for (const t of teachers) {
  const p = people.get(t.key);
  await ensureAccount(p);
  const granted = await ensureRole(p, 'advisor', cohort.id);
  console.log(`  ${p.name.padEnd(28)} ${p.email}  advisor of ${cohort.name}${granted ? '' : ' · already'}`);
}
const firstTeacher = people.get(teachers[0].key);

console.log('\nStudents');
for (const g of groups) {
  console.log(`  ${g.name}`);
  for (const s of g.students) {
    const p = people.get(s.key);
    const fresh = !byEmail.has(p.email);
    await ensureAccount(p);
    await ensureRole(p, 'student', null);
    const elder = elderKeys.has(p.key);
    if (elder) await ensureRole(p, 'officer', cohort.id);

    if (fresh) {
      await audit('user.loaded', 'users', p.id, { population: 'student', grade: p.grade }, 'Loaded from the class roster before first sign-in.');
      await audit(
        'consent.school',
        'users',
        p.id,
        { consent_state: 'active', provided_by: 'school' },
        `Consent provided by the school for ${cohort.name}; the class teachers stand as the adults.`
      );
    }

    /* Membership of the class, as approved. `decided_by` is the first
       teacher, because somebody approved this roster and it was them. */
    await must(
      db.from('memberships').upsert(
        {
          org_id: org.id,
          user_id: p.id,
          cohort_id: cohort.id,
          state: 'member',
          joined_at: now,
          decided_at: now,
          decided_by: firstTeacher.id,
        },
        { onConflict: 'user_id,cohort_id' }
      ),
      `membership for ${p.email}`
    );
    counts.memberships += 1;

    console.log(`    ${p.name.padEnd(26)} ${p.email.padEnd(36)} ${elder ? 'Elder' : ''}${fresh ? '' : ' · already'}`);
  }
}

/* ── Projects ─────────────────────────────────────────────────────────── */

console.log('\nProjects');

const existing = await must(
  db
    .from('projects')
    .select('id, title, project_authors(user_id, role)')
    .eq('org_id', org.id)
    .is('archived_at', null),
  'reading projects'
);

function findProject(title, firstAuthorId) {
  return (existing ?? []).find(
    (r) =>
      r.title === title &&
      (r.project_authors ?? []).some((a) => a.role === 'author' && a.user_id === firstAuthorId)
  );
}

/* Each student's place in the class, for the scores below. */
const placeOf = new Map();

for (const pr of projects) {
  const authors = pr.authors.map((k) => people.get(k));
  const group = groups.find((g) => g.name === authors[0].group);
  const elders = group.elders.map((k) => people.get(k));

  let projectId = findProject(pr.title, authors[0].id)?.id ?? null;
  let made = false;

  if (!projectId) {
    const row = await must(
      db
        .from('projects')
        .insert({
          org_id: org.id,
          title: pr.title,
          created_by: authors[0].id,
          process_id: cohort.process_id ?? 'process-science',
          started_on: STARTED_ON,
        })
        .select('id')
        .single(),
      `creating "${pr.title}"`
    );
    projectId = row.id;
    made = true;
    counts.projects += 1;
    await audit('project.created', 'projects', projectId, { cohort_id: cohort.id, loaded: true }, 'Loaded from the class roster.');
  } else {
    counts.projectsExisting += 1;
    /* A project loaded before the start date was carried gets it now. Only
       where nothing is set: a date somebody typed on the project page is
       theirs. */
    const { error: dateError } = await db
      .from('projects')
      .update({ started_on: STARTED_ON })
      .eq('id', projectId)
      .is('started_on', null);
    if (dateError) console.log(`    (start date not set on "${pr.title}": ${dateError.message})`);
  }

  /* Authors, all accepted: partners named on the roster started the year
     together and have nothing to accept. */
  for (const a of authors) {
    const held = await must(
      db.from('project_authors').select('id').eq('project_id', projectId).eq('user_id', a.id).eq('role', 'author').maybeSingle(),
      `reading authorship of "${pr.title}"`
    );
    if (!held) {
      await must(
        db.from('project_authors').insert({
          org_id: org.id,
          project_id: projectId,
          user_id: a.id,
          role: 'author',
          accepted_at: now,
          invited_at: now,
        }),
        `writing ${a.name} as an author of "${pr.title}"`
      );
    }
  }

  /* In the class, with the class's calendar copied on, as
     `set_project_cohort` and `app.copy_milestones` would. */
  const participation = await must(
    db
      .from('participations')
      .upsert(
        { org_id: org.id, project_id: projectId, program_id: cohort.id, added_by: authors[0].id },
        { onConflict: 'project_id,program_id' }
      )
      .select('id')
      .single(),
    `placing "${pr.title}" in ${cohort.name}`
  );

  const have = await must(
    db.from('entry_milestones').select('program_milestone_id').eq('participation_id', participation.id),
    `reading the calendar of "${pr.title}"`
  );
  const haveIds = new Set((have ?? []).map((m) => m.program_milestone_id));
  const copies = calendar
    .filter((m) => !haveIds.has(m.id))
    .map((m) => ({
      org_id: org.id,
      participation_id: participation.id,
      program_milestone_id: m.id,
      name: m.name,
      kind: m.kind,
      due_on: m.due_on,
      required: m.required,
      blocks_experimentation: m.blocks_experimentation,
      satisfied_by: m.satisfied_by,
      sort_order: m.sort_order,
      source: m.source,
      phase: m.phase,
      owner: m.owner ?? 'student',
      step_id: m.step_id ?? null,
      requires_step: m.requires_step ?? null,
      requires_steps: m.requires_steps ?? [],
      feedback_on: m.feedback_on ?? null,
    }));
  if (copies.length > 0) {
    await must(db.from('entry_milestones').insert(copies), `copying the calendar onto "${pr.title}"`);
  }

  /* **The group's Elders, on this place — unless one of them wrote it.**

     An Elder's own project is self-managed and needs nobody else: putting
     their co-Elder on it would name a supervisor for somebody who is one,
     and the assign screen would read as two people looking after a project
     that has an owner. Where an author is an Elder, that Elder alone is
     attached, and the row is marked self-managed exactly as
     `assign_officer` marks it (6.10). */
  const authorElders = elders.filter((e) => authors.some((a) => a.id === e.id));
  const attach = authorElders.length > 0 ? authorElders : elders;

  const names = [];
  for (const e of attach) {
    const held = await must(
      db
        .from('project_authors')
        .select('id')
        .eq('participation_id', participation.id)
        .eq('user_id', e.id)
        .eq('role', 'officer')
        .maybeSingle(),
      `reading oversight of "${pr.title}"`
    );
    const self = authors.some((a) => a.id === e.id);
    if (!held) {
      await must(
        db.from('project_authors').insert({
          org_id: org.id,
          project_id: projectId,
          participation_id: participation.id,
          user_id: e.id,
          role: 'officer',
          accepted_at: now,
          self_managed_at: self ? now : null,
        }),
        `assigning ${e.name} to "${pr.title}"`
      );
      counts.elders += 1;
      await audit('officer.assigned', 'entries', participation.id, { officer: e.id, self_managed: self, loaded: true }, 'Assigned from the class roster.');
    }
    names.push(self ? `${e.name} (self)` : e.name);
  }

  /* **Both teachers sponsor every project in the class.** IRPD is taught by
     two and both stand behind the work, which is why `record_sponsor` adds
     rather than replaces. Written straight in, with no signature date: the
     class is the sponsorship, and a date nobody signed would be read by the
     ordering check as a signature that exists. */
  for (const t of teachers.map((x) => people.get(x.key))) {
    const held = await must(
      db
        .from('project_sponsors')
        .select('id')
        .eq('participation_id', participation.id)
        .eq('teacher_email', t.email)
        .is('superseded_at', null)
        .maybeSingle(),
      `reading the sponsors of "${pr.title}"`
    );
    if (held) continue;
    await must(
      db.from('project_sponsors').insert({
        org_id: org.id,
        participation_id: participation.id,
        teacher_name: t.name,
        teacher_email: t.email,
        recorded_by: authors[0].id,
        confirmed_at: now,
        confirmed_by: t.id,
      }),
      `recording ${t.name} as a sponsor of "${pr.title}"`
    );
    counts.sponsors += 1;
  }

  /* **The obligations a fact satisfies, reconciled.**
     `record_sponsor` and `assign_officer` call `app.sync_derived` after
     they write, which is what fills `completed_on` on the rows whose
     `satisfied_by` names the fact. This writes the rows straight in, so
     nothing reconciled them: the sponsors and the Elders existed and the
     obligations that read them stayed open, which is a project that looks
     unsponsored on the one screen a student opens. `app` is not exposed to
     PostgREST, so the same two dates are written here, in the same shape
     the function writes them. */
  const derivedRows = await must(
    db
      .from('entry_milestones')
      .select('id, satisfied_by, completed_on')
      .eq('participation_id', participation.id)
      .not('satisfied_by', 'is', null),
    `reading the derived obligations of "${pr.title}"`
  );
  for (const m of derivedRows ?? []) {
    /* No start date is recorded by the load, so `start_date` stays open;
       the sponsor and the Elder are both facts as of today. */
    const on = m.satisfied_by === 'start_date' ? null : now.slice(0, 10);
    if (m.completed_on === on) continue;
    await must(
      db.from('entry_milestones').update({ completed_on: on, completed_by: null }).eq('id', m.id),
      `reconciling an obligation of "${pr.title}"`
    );
  }

  /* GRANTING (see the header). */
  let grantedHere = 0;
  if (GRANT_THROUGH && resolvedTemplate) {
    const open = await must(
      db
        .from('entry_milestones')
        .select('id, name, due_on, kind, step_id, completed_on, owner, satisfied_by')
        .eq('participation_id', participation.id)
        .eq('owner', 'student')
        .is('completed_on', null)
        .is('satisfied_by', null)
        .neq('kind', 'event')
        .lte('due_on', GRANT_THROUGH),
      `reading the open obligations of "${pr.title}"`
    );
    const have = await must(
      db.from('deliverables').select('type').eq('participation_id', participation.id).is('superseded_at', null),
      `reading the deliverables of "${pr.title}"`
    );
    const haveTypes = new Set((have ?? []).map((d) => d.type));
    for (const m of open ?? []) {
      const step =
        resolvedTemplate.steps.find((st) => st.id === m.step_id) ??
        resolvedTemplate.steps.find((st) => st.name === m.name);
      const wants = step ? deliverablesFor(resolvedTemplate, step, {}).filter((d) => d.requirement !== 'optional') : [];
      for (const d of wants) {
        if (haveTypes.has(d.id)) continue;
        await must(
          db.from('deliverables').insert({
            org_id: org.id,
            participation_id: participation.id,
            milestone_id: m.id,
            type: d.id,
            label: `${d.name} (granted at pilot start; done before SciPath)`,
            signed_on: m.due_on,
            required: true,
            submitted_at: now,
            verified_by: firstTeacher.id,
            verified_at: now,
            created_by: firstTeacher.id,
          }),
          `granting ${d.name} on "${pr.title}"`
        );
        haveTypes.add(d.id);
      }
      await must(
        db.from('entry_milestones').update({ completed_on: m.due_on, completed_by: firstTeacher.id }).eq('id', m.id),
        `granting ${m.name} on "${pr.title}"`
      );
      grantedHere += 1;
    }
    counts.granted = (counts.granted ?? 0) + grantedHere;
  }

  for (const a of authors) placeOf.set(a.key, { participation, project: pr.title, elders });

  console.log(
    `  ${pr.title.slice(0, 48).padEnd(50)} ${authors.map((a) => a.name).join(', ')}` +
      `  · Elders ${names.join(', ')}${made ? '' : ' · already'}${copies.length ? ` · ${copies.length} deadlines` : ''}${grantedHere ? ` · ${grantedHere} granted` : ''}`
  );
}

/* ── The family scores ─────────────────────────────────────────────── */
if (scores.length > 0) {
  console.log(`\nFamily scores\n`);
  const byName = new Map([...people.values()].map((p) => [p.name.toLowerCase(), p]));
  const who = (ref) => people.get(String(ref)) ?? byName.get(String(ref).replace(/\s+/g, ' ').trim().toLowerCase()) ?? null;
  let written = 0, kept = 0, skipped = 0;
  for (const sc of scores) {
    const student = who(sc.student);
    const place = student ? placeOf.get(student.key) : null;
    if (!student || !place) { console.log(`  skipped: no student "${sc.student}" in a project`); skipped += 1; continue; }
    const grader = sc.by ? who(sc.by) : place.elders[0];
    if (!grader) { console.log(`  skipped: no Elder "${sc.by}" for ${student.name}`); skipped += 1; continue; }
    const milestone = await must(
      db.from('entry_milestones').select('id, name').eq('participation_id', place.participation.id).eq('step_id', String(sc.step)).maybeSingle(),
      `finding step ${sc.step} on "${place.project}"`
    );
    if (!milestone) { console.log(`  skipped: "${place.project}" has no step ${sc.step}`); skipped += 1; continue; }
    const score = Number(sc.score);
    const comment = String(sc.comment ?? '').trim() || null;
    const { data: current } = await db
      .from('assessments')
      .select('id, score, feedback_md')
      .eq('milestone_id', milestone.id).eq('student_id', student.id).eq('grader_id', grader.id).eq('kind', 'elder')
      .is('superseded_by', null)
      .maybeSingle();
    if (current && Number(current.score) === score && (current.feedback_md ?? null) === comment) { kept += 1; continue; }
    const row = await must(
      db.from('assessments').insert({
        org_id: org.id,
        participation_id: place.participation.id,
        milestone_id: milestone.id,
        student_id: student.id,
        grader_id: grader.id,
        score,
        out_of: 4,
        feedback_md: comment,
        released_at: sc.on ? `${sc.on}T12:00:00Z` : now,
        created_at: sc.on ? `${sc.on}T12:00:00Z` : now,
        kind: 'elder',
      }).select('id').single(),
      `scoring ${milestone.name} for ${student.name}`
    );
    if (current) await must(db.from('assessments').update({ superseded_by: row.id }).eq('id', current.id), 'superseding the earlier score');
    written += 1;
    console.log(`  ${student.name.padEnd(28)} ${milestone.name.slice(0, 36).padEnd(38)} ${score} / 4${comment ? '  ' + comment.slice(0, 40) : ''}  by ${grader.name}`);
  }
  counts.scores = written;
  console.log(`\n  ${written} scores written, ${kept} already there, ${skipped} skipped.`);
}

console.log(
  `\n${counts.accounts} accounts created, ${counts.existing} already there; ${counts.roles} roles granted; ` +
    `${counts.memberships} memberships; ${counts.projects} projects created, ${counts.projectsExisting} already there; ` +
    `${counts.elders} Elder assignments; ${counts.sponsors} sponsorships.` +
    (PASSWORD ? `\nEvery account signs in with the ${cloud ? 'testing' : 'rehearsal'} password.` : '') +
    (FORGET ? `\n${counts.forgotten ?? 0} passwords replaced by ones nobody holds.` : '') +
    (GRANT_THROUGH ? `\n${counts.granted ?? 0} obligations due by ${GRANT_THROUGH} granted as complete on their due dates; tracking is real from there.` : '') +
    '\n'
);

console.log(
  'Before anybody signs in:\n' +
    `  - the Google provider is enabled on ${cloud ? ref : 'the local stack'}, and\n` +
    `    https://${org.slug}.<root domain>/auth/callback/ is a registered redirect;\n` +
    '  - a student signs in at the school\'s address, not the platform\'s, because\n' +
    '    an account belongs to one school (18.4).\n'
);
