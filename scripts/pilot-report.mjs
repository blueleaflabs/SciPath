/**
 * THE DAY, IN NUMBERS — WITH NOBODY IN IT.
 *
 * One file per day about the class: who signed in (as identifiers), what
 * was written, submitted, asked, answered and scored, how long a question
 * waited, where every project stands, and whether the transport held.
 * Every number is a count, a length, a duration or a rate; no text that
 * anybody typed leaves the database, no address, and a display name is
 * carried only when it is an identifier of the pilot's form (S07, E00,
 * T01) — anything else is replaced by its role. The file can be sent on.
 *
 * Two kinds of number, side by side: **today** (Pacific) and **since the
 * class began**, because the second is what a grant or an application
 * reads and the first is what a teacher acts on tomorrow.
 *
 *   npm run report:day -- --cloud                      # local-data/reports/<date>.json and .md
 *   npm run report:day -- --cloud --date 2026-09-10
 *   npm run report:day -- --cloud --org montavista
 *
 * Reads with the secret key (the class's rows are behind policies a
 * session cannot cross); writes only files. Safe to run any number of
 * times; each run overwrites its day.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const cloud = args.includes('--cloud');
const ORG = opt('--org', 'montavista');
const TZ = 'America/Los_Angeles';
const OUT = opt('--out', 'local-data/reports');

if (cloud) loadCloudVars();
else loadDevVars();

const URL_ = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!URL_ || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are both needed (.cloud.vars with --cloud, .dev.vars otherwise).');
  process.exit(1);
}
const db = createClient(URL_, KEY, { auth: { persistSession: false } });

const fail = (m) => { console.error(m); process.exit(1); };
const must = async (p, what) => {
  const { data, error } = await p;
  if (error) fail(`${what}: ${error.message}`);
  return data ?? [];
};
/* Every row, a thousand at a time. */
const all = async (build, what) => {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await must(build().range(from, from + 999), what);
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
};

/* ── The day ─────────────────────────────────────────────────────────── */
const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const today = opt('--date', dayOf(new Date().toISOString()));
const onDay = (iso) => iso && dayOf(iso) === today;

/* ── Who is in the class ─────────────────────────────────────────────── */
const org = (await must(db.from('organizations').select('id, slug').eq('slug', ORG), 'organization'))[0];
if (!org) fail(`no organization ${ORG}`);
const programs = await must(db.from('programs').select('id, slug, name, program_role, status').eq('org_id', org.id), 'programs');
const cohort = programs.find((p) => p.program_role === 'cohort' && p.status === 'open') ?? programs.find((p) => p.program_role === 'cohort');
if (!cohort) fail(`no class program at ${ORG}`);

const roles = await must(db.from('user_roles').select('user_id, role, scope_id').is('revoked_at', null).eq('org_id', org.id), 'roles');
const members = await must(db.from('memberships').select('user_id, state').eq('cohort_id', cohort.id).eq('state', 'member'), 'memberships');
const elders = new Set(roles.filter((r) => r.role === 'officer' && r.scope_id === cohort.id).map((r) => r.user_id));
const teachers = new Set(roles.filter((r) => r.role === 'advisor' && r.scope_id === cohort.id).map((r) => r.user_id));
const students = new Set(members.map((m) => m.user_id).filter((id) => !elders.has(id)));
const everyone = new Set([...students, ...elders, ...teachers]);

const users = await must(db.from('users').select('id, display_name').in('id', [...everyone]), 'users');
/* The label a person carries in the file: their identifier when the
   display name is one, else their role. Never an address. */
const ID_SHAPE = /^[SET][0-9]{2}$/;
const roleOf = (id) => (teachers.has(id) ? 'teacher' : elders.has(id) ? 'elder' : 'student');
const label = new Map(users.map((u) => [u.id, ID_SHAPE.test(u.display_name ?? '') ? u.display_name : `${roleOf(u.id)}-${u.id.slice(0, 4)}`]));

/* Accounts, for sign-ins: the admin list carries last_sign_in_at and
   nothing about it leaves here but the day. */
const accounts = new Map();
for (let page = 1; ; page += 1) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) fail(`listing accounts: ${error.message}`);
  for (const u of data?.users ?? []) if (everyone.has(u.id)) accounts.set(u.id, u.last_sign_in_at ?? null);
  if ((data?.users ?? []).length < 1000) break;
}

/* ── The class's projects and places ─────────────────────────────────── */
const places = await must(db.from('participations').select('id, project_id, status').eq('program_id', cohort.id).in('status', ['entered', 'competed']), 'places');
const projectIds = [...new Set(places.map((p) => p.project_id))];
const placeIds = places.map((p) => p.id);
const authors = await all(() => db.from('project_authors').select('project_id, user_id, role').in('project_id', projectIds), 'authors');
const projectOfStudent = new Map();
for (const a of authors) if (a.role === 'author') projectOfStudent.set(a.user_id, a.project_id);

/* ── What was written ────────────────────────────────────────────────── */
const documents = await all(() => db.from('documents').select('id, project_id, deliverable, status, opened_at, updated_at, submitted_at, opened_by').in('project_id', projectIds), 'documents');
const docIds = documents.map((d) => d.id);
const history = docIds.length
  ? await all(() => db.from('document_field_history').select('document_id, field_id, value, saved_by, saved_at').in('document_id', docIds).order('saved_at'), 'field history')
  : [];
const lines = docIds.length
  ? await all(() => db.from('deliverable_feedback').select('id, document_id, field_id, author_id, created_at, body_md, seen_at').in('document_id', docIds).order('created_at'), 'feedback lines')
  : [];
const assessments = placeIds.length
  ? await all(() => db.from('assessments').select('participation_id, student_id, grader_id, kind, score, out_of, created_at, released_at').in('participation_id', placeIds).is('superseded_by', null), 'assessments')
  : [];
const notes = await all(() => db.from('field_notes').select('project_id, author_id, created_at, body_md').in('project_id', projectIds), 'notebook entries');
const milestones = placeIds.length
  ? await all(() => db.from('entry_milestones').select('participation_id, step_id, name, owner, kind, due_on, completed_on').in('participation_id', placeIds), 'milestones')
  : [];
const incidents = await must(db.from('transport_incidents').select('state, created_at').gte('created_at', `${today}T00:00:00-07:00`), 'incidents');
const attempts = await must(db.from('password_attempts').select('email, ok, at').gte('at', `${today}T00:00:00-07:00`), 'password attempts');
/* Dates moved on this program by `program:redate` (dev-152): all of them,
   since the start, so the teacher's report carries the whole trail. */
const redates = await must(db.from('audit_log').select('entity_id, before, after, reason, occurred_at').eq('org_id', org.id).eq('action', 'milestone.redated').order('occurred_at'), 'schedule changes');

/* ── Words, from the values kept in the history ───────────────────────── */
const words = (v) => {
  const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
  return s.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
};
/* Words as of the last save on each field, and as of the last save
   before today — the difference is the day's writing. */
const latest = new Map();  // doc:field -> last row
const before = new Map();  // doc:field -> last row before today
for (const h of history) {
  const k = `${h.document_id}:${h.field_id}`;
  latest.set(k, h);
  if (dayOf(h.saved_at) < today) before.set(k, h);
}
const wordsNow = [...latest.values()].reduce((n, h) => n + words(h.value), 0);
const wordsBefore = [...before.values()].reduce((n, h) => n + words(h.value), 0);

/* ── Per person ──────────────────────────────────────────────────────── */
const per = new Map([...everyone].map((id) => [id, {
  who: label.get(id) ?? roleOf(id), role: roleOf(id),
  signed_in_ever: Boolean(accounts.get(id)), signed_in_today: onDay(accounts.get(id)),
  saves_today: 0, saves_total: 0, documents_today: new Set(), first_save: null, last_save: null,
  lines_today: 0, lines_total: 0, notes_today: 0, notes_total: 0,
  scores_given_today: 0, scores_given_total: 0,
  submitted_total: 0, submitted_today: 0,
}]));
const bump = (id, key, iso) => { const p = per.get(id); if (!p) return; p[`${key}_total`] += 1; if (onDay(iso)) p[`${key}_today`] += 1; };
for (const h of history) {
  const p = per.get(h.saved_by); if (!p) continue;
  p.saves_total += 1;
  if (onDay(h.saved_at)) {
    p.saves_today += 1; p.documents_today.add(h.document_id);
    if (!p.first_save || h.saved_at < p.first_save) p.first_save = h.saved_at;
    if (!p.last_save || h.saved_at > p.last_save) p.last_save = h.saved_at;
  }
}
for (const l of lines) bump(l.author_id, 'lines', l.created_at);
for (const n of notes) bump(n.author_id, 'notes', n.created_at);
for (const a of assessments) if (a.kind === 'elder') bump(a.grader_id, 'scores_given', a.created_at);
for (const d of documents) if (d.submitted_at) for (const a of authors) if (a.project_id === d.project_id && a.role === 'author') bump(a.user_id, 'submitted', d.submitted_at);

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }) : null);
const people = [...per.values()].map((p) => ({
  ...p, documents_today: p.documents_today.size, first_save: clock(p.first_save), last_save: clock(p.last_save),
})).sort((a, b) => b.saves_today - a.saves_today || a.who.localeCompare(b.who));

/* ── Questions and how long they waited ───────────────────────────────── */
const studentIds = new Set(students);
const threads = new Map();
for (const l of lines) { const k = `${l.document_id}:${l.field_id ?? ''}`; if (!threads.has(k)) threads.set(k, []); threads.get(k).push(l); }
const waits = []; let asked = 0, answered = 0, askedToday = 0, answeredToday = 0, open = 0;
for (const t of threads.values()) {
  for (let i = 0; i < t.length; i += 1) {
    const l = t[i];
    if (!studentIds.has(l.author_id)) continue;
    asked += 1; if (onDay(l.created_at)) askedToday += 1;
    const reply = t.slice(i + 1).find((r) => !studentIds.has(r.author_id));
    if (reply) {
      answered += 1; if (onDay(reply.created_at)) answeredToday += 1;
      waits.push((new Date(reply.created_at) - new Date(l.created_at)) / 60000);
    } else open += 1;
  }
}
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* ── Where the class stands ──────────────────────────────────────────── */
const byStep = new Map();
for (const m of milestones) {
  if (m.owner !== 'student' || m.kind === 'event') continue;
  const s = byStep.get(m.step_id) ?? { step: m.step_id, name: m.name, due_on: m.due_on, places: 0, done: 0, on_time: 0, late: 0 };
  s.places += 1;
  if (m.completed_on) { s.done += 1; if (!m.due_on || m.completed_on <= m.due_on) s.on_time += 1; else s.late += 1; }
  byStep.set(m.step_id, s);
}
const steps = [...byStep.values()].sort((a, b) => String(a.due_on ?? '9999').localeCompare(String(b.due_on ?? '9999')));
const docsBy = (f) => documents.filter(f).length;

/* ── The file ────────────────────────────────────────────────────────── */
const count = (xs, f) => xs.filter(f).length;
const report = {
  date: today, timezone: TZ, org: org.slug, class: cohort.slug, generated_at: new Date().toISOString(),
  roster: { students: students.size, elders: elders.size, teachers: teachers.size, projects: projectIds.length },
  sign_ins: {
    ever: count(people, (p) => p.signed_in_ever), today: count(people, (p) => p.signed_in_today),
    students_ever: count(people, (p) => p.role === 'student' && p.signed_in_ever),
    students_today: count(people, (p) => p.role === 'student' && p.signed_in_today),
    password_failures_today: count(attempts, (a) => !a.ok),
    accounts_with_failures_today: new Set(attempts.filter((a) => !a.ok).map((a) => a.email)).size,
  },
  writing: {
    people_who_saved_today: count(people, (p) => p.saves_today > 0),
    students_who_saved_today: count(people, (p) => p.role === 'student' && p.saves_today > 0),
    saves_today: people.reduce((n, p) => n + p.saves_today, 0),
    saves_total: history.length,
    words_written_today: Math.max(0, wordsNow - wordsBefore),
    words_in_documents_now: wordsNow,
    documents_opened_total: documents.length,
    documents_opened_today: docsBy((d) => onDay(d.opened_at)),
    documents_in_progress: docsBy((d) => d.status !== 'submitted'),
    documents_submitted_total: docsBy((d) => d.status === 'submitted'),
    documents_submitted_today: docsBy((d) => onDay(d.submitted_at)),
    notebook_entries_today: count(notes, (n) => onDay(n.created_at)),
    notebook_entries_total: notes.length,
  },
  questions: {
    asked_total: asked, asked_today: askedToday, answered_total: answered, answered_today: answeredToday, open,
    median_wait_minutes: median(waits) == null ? null : Math.round(median(waits)),
    answered_within_an_hour: count(waits, (w) => w <= 60),
    lines_total: lines.length, lines_today: count(lines, (l) => onDay(l.created_at)),
  },
  feedback: {
    elder_scores_total: count(assessments, (a) => a.kind === 'elder'),
    elder_scores_today: count(assessments, (a) => a.kind === 'elder' && onDay(a.created_at)),
    teacher_grades_total: count(assessments, (a) => a.kind === 'teacher'),
    teacher_grades_today: count(assessments, (a) => a.kind === 'teacher' && onDay(a.created_at)),
  },
  standing: steps,
  schedule_changes: redates.map((x) => ({ on: x.occurred_at, was: x.before?.due_on ?? null, now: x.after?.due_on ?? null, what: x.reason })),
  health: {
    transport_incidents_today: incidents.length,
    incidents_by_state: Object.fromEntries([...new Set(incidents.map((i) => i.state))].map((k) => [k, count(incidents, (i) => i.state === k)])),
  },
  people,
};

/* Nothing typed and no address leaves: the file is checked before it is
   written. */
const text = JSON.stringify(report, null, 2);
if (/@/.test(text)) fail('an address survived into the report — nothing was written');
for (const l of lines) if (l.body_md && l.body_md.length > 12 && text.includes(l.body_md.slice(0, 40))) fail('a line of text survived into the report — nothing was written');

fs.mkdirSync(OUT, { recursive: true });
const jsonPath = path.join(OUT, `${today}.json`);
fs.writeFileSync(jsonPath, text + '\n');

const r = report;
const md = [
  `# ${org.slug} · ${cohort.name} · ${today}`,
  '',
  `**Roster** ${r.roster.students} students, ${r.roster.elders} Elders, ${r.roster.teachers} teachers, ${r.roster.projects} projects.`,
  `**Sign-ins** ${r.sign_ins.today} today (${r.sign_ins.students_today} students); ${r.sign_ins.ever} of ${everyone.size} ever. ${r.sign_ins.password_failures_today} wrong-password tries on ${r.sign_ins.accounts_with_failures_today} accounts.`,
  `**Writing** ${r.writing.people_who_saved_today} people saved today (${r.writing.students_who_saved_today} students), ${r.writing.saves_today} saves, about ${r.writing.words_written_today} words written; ${r.writing.documents_submitted_today} submitted today, ${r.writing.documents_submitted_total} in all; ${r.writing.documents_in_progress} in progress.`,
  `**Questions** ${r.questions.asked_today} asked today, ${r.questions.answered_today} answered; ${r.questions.open} open; median wait ${r.questions.median_wait_minutes ?? '–'} min; ${r.questions.answered_within_an_hour} of ${r.questions.answered_total} answered within an hour.`,
  `**Feedback** ${r.feedback.elder_scores_today} Elder scores today (${r.feedback.elder_scores_total} in all); ${r.feedback.teacher_grades_today} teacher grades today.`,
  `**Health** ${r.health.transport_incidents_today} transport incidents.`,
  '',
  '| Step | Due | Done | On time | Late | Of |',
  '|---|---|---|---|---|---|',
  ...steps.map((s) => `| ${s.name} | ${s.due_on ?? ''} | ${s.done} | ${s.on_time} | ${s.late} | ${s.places} |`),
  '',
  ...(redates.length ? [
    '| Schedule change | Was | Now | Changed on |',
    '|---|---|---|---|',
    ...redates.map((x) => `| ${(x.reason ?? '').split(':')[0]} | ${x.before?.due_on ?? ''} | ${x.after?.due_on ?? ''} | ${x.occurred_at.slice(0, 10)} |`),
    '',
  ] : []),
  '| Who | Role | In today | Saves | Docs | First | Last | Lines | Notes | Scores |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...people.map((p) => `| ${p.who} | ${p.role} | ${p.signed_in_today ? 'yes' : ''} | ${p.saves_today} | ${p.documents_today} | ${p.first_save ?? ''} | ${p.last_save ?? ''} | ${p.lines_today} | ${p.notes_today} | ${p.scores_given_today} |`),
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, `${today}.md`), md);

console.log(`\n${today}: ${r.sign_ins.today} signed in, ${r.writing.people_who_saved_today} wrote (${r.writing.words_written_today} words), ${r.questions.asked_today} asked, ${r.questions.answered_today} answered, ${r.writing.documents_submitted_today} submitted.`);
console.log(`Written to ${jsonPath} and ${path.join(OUT, `${today}.md`)}. No names, addresses or text inside.\n`);
