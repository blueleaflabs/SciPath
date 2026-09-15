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
/* `--print` (dev-154): the same numbers, to the terminal, nothing written
   — the ad hoc look during the day. Adds a "right now" line: who has
   saved anything in the last quarter hour, and the hour's saves. */
const PRINT = args.includes('--print');
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
/* Uploaded or typed (dev-161): per deliverable, of the documents
   submitted, how many carry a photo or PDF in the upload boxes, how many
   carry typed work, and how many carry only an upload. Read from the
   fields as they stand: an upload is a file value in `upload_N`; typed is
   any other student field with something in it. */
const fieldsNow = docIds.length
  ? await all(() => db.from('document_fields').select('document_id, field_id, value').in('document_id', docIds), 'fields now')
  : [];
const hasValue = (v) => v != null && (typeof v === 'object' ? (Array.isArray(v) ? v.some((x) => x != null && String(x).trim()) : Object.keys(v).length > 0) : String(v).trim().length > 0);
const uploadedDocs = new Set(), typedDocs = new Set();
for (const f of fieldsNow) {
  if (/^upload_\d+$/.test(f.field_id)) { if (f.value && typeof f.value === 'object' && f.value.path) uploadedDocs.add(f.document_id); }
  else if (!/^(url|note|_doc_link|elder_|oral_feedback)/.test(f.field_id) && hasValue(f.value)) typedDocs.add(f.document_id);
}
const uploadsBy = {};
for (const d of documents) {
  if (d.status !== 'submitted') continue;
  const row = uploadsBy[d.deliverable] ?? (uploadsBy[d.deliverable] = { submitted: 0, with_upload: 0, with_typing: 0, upload_only: 0, typed_only: 0 });
  row.submitted += 1;
  const up = uploadedDocs.has(d.id), ty = typedDocs.has(d.id);
  if (up) row.with_upload += 1;
  if (ty) row.with_typing += 1;
  if (up && !ty) row.upload_only += 1;
  if (ty && !up) row.typed_only += 1;
}
const uploadsAll = Object.values(uploadsBy).reduce((a, r) => ({ submitted: a.submitted + r.submitted, with_upload: a.with_upload + r.with_upload, with_typing: a.with_typing + r.with_typing, upload_only: a.upload_only + r.upload_only, typed_only: a.typed_only + r.typed_only }), { submitted: 0, with_upload: 0, with_typing: 0, upload_only: 0, typed_only: 0 });

/* The days anybody wrote (0002, dev-157): one row per person per project
   per day, rolled up from every save — the cheap read for the week's
   actives and the quiet projects, whatever the size of the history. */
const activity = projectIds.length
  ? await all(() => db.from('activity_days').select('user_id, project_id, day, saves, last_at').in('project_id', projectIds), 'activity days')
  : [];
/* Reminders: nudges a teacher or an Elder sent about a step (the platform's
   `nudge` kinds), which is what "interventions" means here. */
const reminders = await all(() => db.from('notifications').select('kind, actor_id, recipient_id, created_at').eq('org_id', org.id).in('kind', ['nudge', 'nudge_officer']), 'reminders');
const incidents = await must(db.from('transport_incidents').select('state, created_at').gte('created_at', `${today}T00:00:00-07:00`), 'incidents');
const attempts = await must(db.from('password_attempts').select('email, ok, at').gte('at', `${today}T00:00:00-07:00`), 'password attempts');
/* Dates moved on this program by `program:redate` (dev-152): all of them,
   since the start, so the teacher's report carries the whole trail. */
const redates = await must(db.from('audit_log').select('entity_id, before, after, reason, occurred_at').eq('org_id', org.id).in('action', ['milestone.redated', 'milestone.added']).order('occurred_at'), 'schedule changes');

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

const count = (xs, f) => xs.filter(f).length;

/* ── The deeper measures (dev-155) ───────────────────────────────────── */
/* Each one is a claim a reviewer can check: the mechanism, then the
   number. All from rows that exist; nothing new is written to record them. */
const staffIds = new Set([...elders, ...teachers]);
const dayStart = Date.parse(`${today}T00:00:00-07:00`);
const week = (iso) => iso && dayStart + 86400000 - Date.parse(iso) < 7 * 86400000 && Date.parse(iso) < dayStart + 86400000;
const projectOfDoc = new Map(documents.map((d) => [d.id, d.project_id]));
const projectOfPlace = new Map(places.map((p) => [p.id, p.project_id]));

/* Weekly active: anybody who wrote anything in the seven days ending today. */
const wroteThisWeek = new Set();
for (const h of history) if (week(h.saved_at)) wroteThisWeek.add(h.saved_by);
for (const a of activity) if (week(a.last_at)) wroteThisWeek.add(a.user_id);
for (const l of lines) if (week(l.created_at)) wroteThisWeek.add(l.author_id);
for (const n of notes) if (week(n.created_at)) wroteThisWeek.add(n.author_id);
for (const a of assessments) if (week(a.created_at)) wroteThisWeek.add(a.grader_id);
const activeWeek = [...wroteThisWeek].filter((id) => everyone.has(id));
const activeWeekStudents = activeWeek.filter((id) => studentIds.has(id));

/* Feedback latency after a submission: hours from submitted_at to the
   first staff line or Elder score on that document's project. */
const latencies = [];
for (const d of documents) {
  if (!d.submitted_at) continue;
  const t0 = Date.parse(d.submitted_at);
  const firstLine = lines.filter((l) => l.document_id === d.id && staffIds.has(l.author_id) && Date.parse(l.created_at) > t0).map((l) => Date.parse(l.created_at));
  const firstScore = assessments.filter((a) => a.kind === 'elder' && projectOfPlace.get(a.participation_id) === d.project_id && Date.parse(a.created_at) > t0).map((a) => Date.parse(a.created_at));
  const first = Math.min(...firstLine, ...firstScore);
  if (Number.isFinite(first)) latencies.push((first - t0) / 3600000);
}
const submittedAwaiting = documents.filter((d) => d.submitted_at && !lines.some((l) => l.document_id === d.id && staffIds.has(l.author_id) && Date.parse(l.created_at) > Date.parse(d.submitted_at)) && !assessments.some((a) => a.kind === 'elder' && projectOfPlace.get(a.participation_id) === d.project_id && Date.parse(a.created_at) > Date.parse(d.submitted_at))).length;

/* Revision after feedback: a staff line on a field, then an author's save
   to that same field within 48 hours. */
let staffLinesOnFields = 0, revisedAfter = 0;
for (const l of lines) {
  if (!staffIds.has(l.author_id) || !l.field_id) continue;
  staffLinesOnFields += 1;
  const t0 = Date.parse(l.created_at);
  if (history.some((h) => h.document_id === l.document_id && h.field_id === l.field_id && !staffIds.has(h.saved_by) && Date.parse(h.saved_at) > t0 && Date.parse(h.saved_at) - t0 < 48 * 3600000)) revisedAfter += 1;
}

/* Work outside class hours: saves on a school day before 8 or after 15:30, or on a weekend. */
const outside = (iso) => {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('en-US', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  const wd = d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' });
  return wd === 'Sat' || wd === 'Sun' || hm < '08:00' || hm > '15:30';
};
const savesToday = history.filter((h) => onDay(h.saved_at));
const afterHoursToday = savesToday.filter((h) => outside(h.saved_at)).length;

/* Elder coverage: projects touched by staff (a line or a score) this week. */
const touched = new Set();
for (const l of lines) if (staffIds.has(l.author_id) && week(l.created_at)) touched.add(projectOfDoc.get(l.document_id));
for (const a of assessments) if (a.kind === 'elder' && week(a.created_at)) touched.add(projectOfPlace.get(a.participation_id));
const coveredWeek = projectIds.filter((id) => touched.has(id)).length;

/* Interviews written, per project (the empathy-interviews boxes). */
const interviewDocs = documents.filter((d) => d.deliverable === 'interview_synthesis');
const interviewFields = interviewDocs.length
  ? await all(() => db.from('document_fields').select('document_id, field_id, value').in('document_id', interviewDocs.map((d) => d.id)).like('field_id', 'interview_%'), 'interview boxes')
  : [];
const interviewsPer = new Map();
for (const f of interviewFields) if (typeof f.value === 'string' && f.value.trim()) interviewsPer.set(f.document_id, (interviewsPer.get(f.document_id) ?? 0) + 1);
const interviewCounts = [...interviewsPer.values()];

/* The survey (0002): shown, answered, dismissed, per question, and the
   answers' spread; the lines stay in the database. Response rate is
   answered over shown — the number that says whether the cadence is
   right. */
const surveyRows = await must(db.from('survey_events').select('user_id, question_id, moment, event, answer, comment, created_at').eq('org_id', org.id), 'survey events');
const surveyOf = (rows) => {
  const per = {};
  for (const id of [...new Set(rows.map((x) => x.question_id))].sort()) {
    const mine = rows.filter((x) => x.question_id === id);
    const shown = count(mine, (x) => x.event === 'shown');
    const answered = count(mine, (x) => x.event === 'answered');
    per[id] = {
      shown, answered, dismissed: count(mine, (x) => x.event === 'dismissed'),
      response_rate: shown ? Math.round((answered / shown) * 100) : null,
      high: count(mine, (x) => x.event === 'answered' && x.answer === 3), mid: count(mine, (x) => x.event === 'answered' && x.answer === 2), low: count(mine, (x) => x.event === 'answered' && x.answer === 1),
      with_a_line: count(mine, (x) => x.event === 'answered' && x.comment),
    };
  }
  const shown = count(rows, (x) => x.event === 'shown');
  const answered = count(rows, (x) => x.event === 'answered');
  return { shown, answered, dismissed: count(rows, (x) => x.event === 'dismissed'), response_rate: shown ? Math.round((answered / shown) * 100) : null, people_asked: new Set(rows.filter((x) => x.event === 'shown').map((x) => x.user_id)).size, questions: per };
};

/* Quiet projects: no save, feedback line, notebook entry or score on the
   project in the seven days ending today. The share of the class's
   projects is the number to watch. */
const lastTouch = new Map();
const touch = (projectId, iso) => { if (!projectId || !iso) return; const t = Date.parse(iso); if (t < dayStart + 86400000 && t > (lastTouch.get(projectId) ?? 0)) lastTouch.set(projectId, t); };
for (const a of activity) touch(a.project_id, a.last_at);
for (const h of history) touch(projectOfDoc.get(h.document_id), h.saved_at);
for (const l of lines) touch(projectOfDoc.get(l.document_id), l.created_at);
for (const n of notes) touch(n.project_id, n.created_at);
for (const a of assessments) touch(projectOfPlace.get(a.participation_id), a.created_at);
const staleProjects = projectIds.filter((id) => !lastTouch.has(id) || dayStart + 86400000 - lastTouch.get(id) >= 7 * 86400000);

/* The student's side of the loop: hours from a staff line on a document to
   the author's next save on that document, for lines that got one. */
const responses = [];
let staffLinesTotal = 0, staffLinesUnanswered = 0;
for (const l of lines) {
  if (!staffIds.has(l.author_id)) continue;
  staffLinesTotal += 1;
  const t0 = Date.parse(l.created_at);
  const next = history.filter((h) => h.document_id === l.document_id && !staffIds.has(h.saved_by) && Date.parse(h.saved_at) > t0).map((h) => Date.parse(h.saved_at));
  if (next.length) responses.push((Math.min(...next) - t0) / 3600000);
  else staffLinesUnanswered += 1;
}

/* The teacher's Friday number (dev-157): minutes saved this week, one per
   teacher per week, listed by week so the run of them reads as a series. */
const teacherMinutes = surveyRows.filter((x) => x.question_id === 'teacher_minutes' && x.event === 'answered' && typeof x.answer === 'number')
  .map((x) => ({ week: dayOf(x.created_at), by: label.get(x.user_id) ?? roleOf(x.user_id), minutes: x.answer }))
  .sort((a, b) => a.week.localeCompare(b.week));

/* ── The file ────────────────────────────────────────────────────────── */
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
  /* dev-155 */
  week: {
    active_people: activeWeek.length, active_students: activeWeekStudents.length,
    active_share_of_roster: Math.round((activeWeek.length / everyone.size) * 100),
    active_share_of_students: Math.round((activeWeekStudents.length / Math.max(1, students.size)) * 100),
    projects_with_staff_touch: coveredWeek, projects: projectIds.length,
  },
  feedback_loop: {
    submissions_answered: latencies.length, submissions_awaiting: submittedAwaiting,
    median_hours_to_first_feedback: latencies.length ? Math.round(median(latencies) * 10) / 10 : null,
    answered_within_24h: count(latencies, (h) => h <= 24),
    staff_lines_on_fields: staffLinesOnFields, revised_within_48h: revisedAfter,
    revision_rate: staffLinesOnFields ? Math.round((revisedAfter / staffLinesOnFields) * 100) : null,
  },
  hours: { saves_today: savesToday.length, saves_outside_class_today: afterHoursToday },
  interviews: {
    projects_with_notes: interviewCounts.length, at_least_3: count(interviewCounts, (n) => n >= 3), at_least_5: count(interviewCounts, (n) => n >= 5),
    total_written: interviewCounts.reduce((a, b) => a + b, 0),
  },
  survey: { total: surveyOf(surveyRows), today: surveyOf(surveyRows.filter((x) => onDay(x.created_at))) },
  teacher_minutes: teacherMinutes,
  uploads: { total: uploadsAll, by_deliverable: uploadsBy },
  stale: { projects: staleProjects.length, share_of_projects: projectIds.length ? Math.round((staleProjects.length / projectIds.length) * 100) : null },
  student_response: {
    staff_lines: staffLinesTotal, answered_by_a_save: responses.length, unanswered: staffLinesUnanswered,
    median_hours_to_next_save: responses.length ? Math.round(median(responses) * 10) / 10 : null,
    within_48h: count(responses, (h) => h <= 48),
  },
  reminders: { today: count(reminders, (r) => onDay(r.created_at)), this_week: count(reminders, (r) => week(r.created_at)), total: reminders.length, by_staff_total: count(reminders, (r) => staffIds.has(r.actor_id)) },
  health: {
    transport_incidents_today: incidents.length,
    incidents_by_state: Object.fromEntries([...new Set(incidents.map((i) => i.state))].map((k) => [k, count(incidents, (i) => i.state === k)])),
  },
  people,
};

/* ── Right now (dev-154) ─────────────────────────────────────────────── */
const nowMs = Date.now();
const recent = (minutes) => history.filter((h) => nowMs - Date.parse(h.saved_at) < minutes * 60 * 1000);
const quarter = recent(15);
const hour = recent(60);
const activeNow = [...new Set(quarter.map((h) => h.saved_by))].map((id) => label.get(id) ?? roleOf(id)).sort();
const submittedRecently = documents.filter((d) => d.submitted_at && nowMs - Date.parse(d.submitted_at) < 60 * 60 * 1000).length;
const openNow = report.questions.open;

/* Nothing typed and no address leaves: the file is checked before it is
   written. */
const text = JSON.stringify(report, null, 2);
if (/@/.test(text)) fail('an address survived into the report — nothing was written');
for (const l of lines) if (l.body_md && l.body_md.length > 12 && text.includes(l.body_md.slice(0, 40))) fail('a line of text survived into the report — nothing was written');

if (PRINT) {
  const at = new Date().toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const busiest = people.filter((p) => p.saves_today > 0).slice(0, 8).map((p) => `${p.who} ${p.saves_today}`).join(', ');
  const stepsLive = steps.filter((st) => st.due_on && st.due_on <= today).slice(-4).map((st) => `${st.name} ${st.done}/${st.places}${st.late ? ` (${st.late} late)` : ''}`).join(' · ');
  console.log(`
${org.slug} · ${cohort.name} · ${today} at ${at}

  Right now   ${activeNow.length ? `${activeNow.length} writing in the last 15 min: ${activeNow.join(', ')}` : 'nobody has saved anything in the last 15 min'}; ${hour.length} saves in the last hour; ${submittedRecently} submitted in the last hour; ${openNow} question${openNow === 1 ? '' : 's'} open
  Today       ${report.sign_ins.today} signed in (${report.sign_ins.students_today} students); ${report.writing.people_who_saved_today} wrote, ${report.writing.saves_today} saves, ~${report.writing.words_written_today} words; ${report.writing.documents_submitted_today} submitted; ${report.questions.asked_today} asked, ${report.questions.answered_today} answered; ${report.feedback.elder_scores_today} Elder scores; ${report.health.transport_incidents_today} transport incidents; ${report.sign_ins.password_failures_today} wrong passwords
  This week   ${report.week.active_people} of ${everyone.size} active (${report.week.active_share_of_students}% of students); staff touched ${report.week.projects_with_staff_touch}/${report.week.projects} projects; feedback median ${report.feedback_loop.median_hours_to_first_feedback ?? '–'} h, ${report.feedback_loop.submissions_awaiting} awaiting; revisions after comments ${report.feedback_loop.revised_within_48h}/${report.feedback_loop.staff_lines_on_fields}
  Quiet       ${report.stale.projects} of ${projectIds.length} projects with nothing in 7 days (${report.stale.share_of_projects ?? '–'}%); students answer a staff line by a save in median ${report.student_response.median_hours_to_next_save ?? '–'} h (${report.student_response.answered_by_a_save}/${report.student_response.staff_lines}); ${report.reminders.this_week} reminders this week (${report.reminders.total} in all); teacher minutes saved: ${teacherMinutes.map((t) => `${t.week} ${t.minutes}`).join(', ') || 'none yet'}
  Uploads     of ${uploadsAll.submitted} submitted: ${uploadsAll.with_upload} with a photo or PDF (${uploadsAll.upload_only} upload only), ${uploadsAll.with_typing} typed (${uploadsAll.typed_only} typed only)
  Survey      ${report.survey.total.shown} shown to ${report.survey.total.people_asked}, ${report.survey.total.answered} answered (${report.survey.total.response_rate ?? '–'}%), ${report.survey.total.dismissed} not now · ${Object.entries(report.survey.total.questions).map(([id, q]) => `${id} ${q.high}/${q.mid}/${q.low}`).join(' · ') || 'nothing asked yet'}
  Busiest     ${busiest || '—'}
  Due so far  ${stepsLive || '—'}
`);
  process.exit(0);
}

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
  `**This week** ${r.week.active_people} of ${everyone.size} active (${r.week.active_share_of_students}% of students); staff touched ${r.week.projects_with_staff_touch} of ${r.week.projects} projects.`,
  `**Feedback loop** ${r.feedback_loop.submissions_answered} submissions answered, median ${r.feedback_loop.median_hours_to_first_feedback ?? '–'} h to first feedback, ${r.feedback_loop.answered_within_24h} within a day; ${r.feedback_loop.submissions_awaiting} awaiting. ${r.feedback_loop.revised_within_48h} of ${r.feedback_loop.staff_lines_on_fields} field comments followed by a revision within 48 h${r.feedback_loop.revision_rate != null ? ` (${r.feedback_loop.revision_rate}%)` : ''}.`,
  `**Outside class** ${r.hours.saves_outside_class_today} of ${r.hours.saves_today} saves today. **Interviews** ${r.interviews.total_written} written on ${r.interviews.projects_with_notes} projects; ${r.interviews.at_least_3} at three or more, ${r.interviews.at_least_5} at five.`,
  `**Quiet projects** ${r.stale.projects} of ${projectIds.length} (${r.stale.share_of_projects ?? '–'}%) with nothing in seven days. **Student response** ${r.student_response.answered_by_a_save} of ${r.student_response.staff_lines} staff lines followed by a save, median ${r.student_response.median_hours_to_next_save ?? '–'} h, ${r.student_response.within_48h} within 48 h. **Reminders** ${r.reminders.today} today, ${r.reminders.this_week} this week, ${r.reminders.total} in all. **Teacher minutes saved** ${r.teacher_minutes.length ? r.teacher_minutes.map((t) => `${t.week}: ${t.minutes} (${t.by})`).join('; ') : 'none yet'}.`,
  `**Uploaded or typed** of ${r.uploads.total.submitted} submitted documents, ${r.uploads.total.with_upload} carry a photo or PDF (${r.uploads.total.upload_only} upload only) and ${r.uploads.total.with_typing} carry typed work (${r.uploads.total.typed_only} typed only).` + (Object.keys(r.uploads.by_deliverable).length ? ' By deliverable: ' + Object.entries(r.uploads.by_deliverable).map(([k, x]) => `${k} ${x.with_upload}/${x.with_typing} of ${x.submitted}`).join('; ') + ' (upload/typed of submitted).' : ''),
  `**Survey** ${r.survey.total.shown} shown to ${r.survey.total.people_asked} people, ${r.survey.total.answered} answered (${r.survey.total.response_rate ?? '–'}% response), ${r.survey.total.dismissed} not now; today ${r.survey.today.shown} shown, ${r.survey.today.answered} answered.` + (Object.keys(r.survey.total.questions).length ? ' Per question (high/mid/low): ' + Object.entries(r.survey.total.questions).map(([id, q]) => `${id} ${q.high}/${q.mid}/${q.low} of ${q.shown} shown${q.with_a_line ? `, ${q.with_a_line} with a line` : ''}`).join('; ') + '.' : ''),
  '',
  '| Step | Due | Done | On time | Late | Of |',
  '|---|---|---|---|---|---|',
  ...steps.map((s) => `| ${s.name} | ${s.due_on ?? ''} | ${s.done} | ${s.on_time} | ${s.late} | ${s.places} |`),
  '',
  ...(redates.length ? [
    '| Schedule change | Was | Now | Changed on |',
    '|---|---|---|---|',
    ...redates.map((x) => `| ${(x.reason ?? '').split(':')[0]} | ${x.before?.due_on ?? (x.before ? '' : 'new')} | ${x.after?.due_on ?? ''} | ${x.occurred_at.slice(0, 10)} |`),
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
