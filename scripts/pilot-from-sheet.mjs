#!/usr/bin/env node
/**
 * THE CLASS SPREADSHEET, READ INTO THE ROSTER FILE.
 *
 * The teachers keep the class in one sheet: a category row that opens each
 * group and names its two Elders, then one student per row with first
 * name, last name, grade, last year's idea, and this year's project. That
 * sheet is the source, and this turns it into `local-data/pilot-irpd.yaml`,
 * which `pilot-load.mjs` loads.
 *
 * ── What is read, and how ─────────────────────────────────────────────────
 *
 *   A   a category name opens a group; the number under it is the size
 *   B   the group's Elders, "First and First"
 *   C D first and last name
 *   E   grade
 *   F   last year's idea, used as the title only where G is empty
 *   G   this year's project, in the student's words
 *   H   email, if the sheet carries one
 *
 * Partners write the same project name in G, and two rows with one name
 * become one project with two authors. A student ID in a name cell is
 * dropped. Elders are matched by first name inside their own group.
 *
 * ── Emails survive a re-read ──────────────────────────────────────────────
 *
 * Column H is the address. Where a row has none, an address filled into the
 * roster file by hand is kept when the sheet is read again, matched by
 * key, so an edit to the sheet never costs forty addresses. Column H wins
 * over the file where both are present.
 *
 * ── No dependency ─────────────────────────────────────────────────────────
 *
 * An `.xlsx` is a zip of XML. The two files needed are inflated with
 * `node:zlib` and read with three regular expressions, because a spreadsheet
 * library is a large package in the dependency list of a project that
 * reads one sheet, once a year.
 *
 *   node scripts/pilot-from-sheet.mjs "Student Projects 20262027.xlsx"
 *   node scripts/pilot-from-sheet.mjs sheet.xlsx --out local-data/pilot-irpd.yaml
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('--'));
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'local-data/pilot-irpd.yaml';

function fail(message) {
  console.error(`\n  ${message.replace(/\n/g, '\n  ')}\n`);
  process.exit(1);
}

if (!source) fail('Name the spreadsheet: node scripts/pilot-from-sheet.mjs "Student Projects 20262027.xlsx"');
if (!fs.existsSync(source)) fail(`${source} does not exist.`);

/* ── A zip, read just far enough ──────────────────────────────────────── */

function unzip(buffer) {
  const files = new Map();
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) fail(`${source} is not a zip, so not an .xlsx.`);
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) fail('central directory is not where the zip says it is');
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buffer.subarray(start, start + compressed);
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));

    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const files = unzip(fs.readFileSync(source));
const sheetXml = files.get('xl/worksheets/sheet1.xml')?.toString('utf8');
if (!sheetXml) fail('no first worksheet in the file');
const sharedXml = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '';

const unescape = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/* Shared strings, in order. A rich-text cell holds several <t>; joined. */
const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
  unescape([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))
);

/* Cells, by row and column letter. */
const rows = new Map();
for (const m of sheetXml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
  const [, col, row, attrs, inner] = m;
  if (!inner) continue;
  const type = attrs.match(/t="(\w+)"/)?.[1];
  let value = '';
  if (type === 's') value = shared[Number(inner.match(/<v>(.*?)<\/v>/)?.[1] ?? -1)] ?? '';
  else if (type === 'inlineStr') value = unescape(inner.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '');
  else value = unescape(inner.match(/<v>(.*?)<\/v>/)?.[1] ?? '');
  if (!rows.has(Number(row))) rows.set(Number(row), {});
  rows.get(Number(row))[col] = value;
}

/* ── The roster ───────────────────────────────────────────────────────── */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const keyOf = (first, last) => `${first} ${last}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const groups = [];
let group = null;

for (const n of [...rows.keys()].sort((a, b) => a - b)) {
  const r = rows.get(n);
  if (n === 1) continue;
  const a = clean(r.A);
  if (a && !/^\d+(\.\d+)?$/.test(a)) {
    group = { name: a.replace(/\/\s+/g, '/'), eldersText: '', students: [] };
    groups.push(group);
  }
  if (clean(r.B)) group.eldersText = clean(r.B);

  let first = clean(r.C);
  let last = clean(r.D);
  if (!first) continue;
  if (!group) fail(`row ${n}: a student before any group`);

  last = last.replace(/\s*\(Student ID[^)]*\)\s*$/i, '');
  if (last.startsWith(first)) last = last.slice(first.length).trim();
  const grade = Math.round(Number(r.E));
  if (!(grade >= 9 && grade <= 12)) fail(`row ${n}: ${first} ${last} has grade "${r.E}"`);

  group.students.push({
    key: keyOf(first, last),
    name: `${first} ${last}`,
    first: first.split(' ')[0],
    grade,
    email: clean(r.H).toLowerCase(),
    idea: clean(r.F),
    title: clean(r.G),
    row: n,
  });
}

if (groups.length === 0) fail('no groups read: column A should open each with a category name');

/* Elders by first name, inside their own group. */
const notes = [];
for (const g of groups) {
  const names = g.eldersText.split(/\band\b|,|&/).map(clean).filter(Boolean);
  g.elders = [];
  for (const n of names) {
    const hit = g.students.filter((s) => s.first.toLowerCase() === n.toLowerCase());
    if (hit.length === 1) g.elders.push(hit[0].key);
    else {
      g.elders.push(`UNRESOLVED-${n}`);
      notes.push(`${g.name}: Elder "${n}" is not a first name in the group. Fix the key in the file.`);
    }
  }
  if (g.elders.length === 0) notes.push(`${g.name}: no Elders named in column B`);
}

/* Projects. **The same title on two rows is one project with two authors.**
   That is the sheet's own convention: partners write the same project name,
   and nothing else in the sheet says who works with whom. Matched within a
   group, case and spacing aside; the same title in two groups is two
   projects, and is said so, because it is more likely a coincidence than
   a partnership across sections. */
const projects = [];
for (const g of groups) {
  const byTitle = new Map();
  for (const s of g.students) {
    const title = s.title || s.idea;
    if (!s.title) notes.push(`${s.name}: no column G, title taken from column F`);
    if (!title) {
      notes.push(`${s.name}: no project in column G or F, so no project is written for them`);
      continue;
    }
    const norm = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (byTitle.has(norm)) byTitle.get(norm).authors.push(s.key);
    else byTitle.set(norm, { title, authors: [s.key] });
  }
  for (const project of byTitle.values()) projects.push(project);
}
{
  const seen = new Map();
  for (const p of projects) {
    const norm = p.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(norm)) notes.push(`"${p.title}" appears in two groups and is loaded as two projects`);
    seen.set(norm, true);
  }
}

/* ── Merge with the file already there ────────────────────────────────── */

/* A bare date in the previous file parses as a timestamp; keep the day. */
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v == null ? null : String(v).trim().slice(0, 10));
let previous = {};
if (fs.existsSync(OUT)) {
  previous = yaml.load(fs.readFileSync(OUT, 'utf8')) ?? {};
  const known = new Map();
  for (const g of previous.groups ?? []) for (const s of g.students ?? []) known.set(s.key, s.email);
  let kept = 0;
  for (const g of groups) {
    for (const s of g.students) {
      if (!s.email && known.get(s.key)) {
        s.email = known.get(s.key);
        kept += 1;
      }
    }
  }
  if (kept) notes.push(`${kept} addresses kept from the existing ${OUT}`);

  /* An Elder the sheet names by a nickname was resolved by hand in the
     file; that answer survives a re-read too. */
  for (const g of groups) {
    const before = (previous.groups ?? []).find((pg) => pg.name === g.name);
    if (!before) continue;
    g.elders = g.elders.map((e, i) =>
      e.startsWith('UNRESOLVED-') && before.elders?.[i] && !String(before.elders[i]).startsWith('UNRESOLVED-')
        ? before.elders[i]
        : e
    );
  }
}

const out = {
  org: previous.org ?? 'montavista',
  cohort: previous.cohort ?? 'irpd-mvhs-2027',
  student_domain: previous.student_domain ?? 'student.fuhsd.org',
  staff_domain: previous.staff_domain ?? 'fuhsd.org',
  consent: previous.consent ?? 'school',
  graduating_year: previous.graduating_year ?? 2027,
  started_on: dayOf(previous.started_on) ?? '2026-08-17',
  /* The class was on paper until this day; the load grants the work due
     by then as done on its due dates (pilot-load.mjs, GRANTING). */
  granted_through: dayOf(previous.granted_through) ?? '2026-09-03',
  teachers: previous.teachers ?? [
    { key: 'teacher-1', name: '', email: '' },
    { key: 'teacher-2', name: '', email: '' },
  ],
  groups: groups.map((g) => ({
    name: g.name,
    elders: g.elders,
    students: g.students.map((s) => ({ key: s.key, name: s.name, grade: s.grade, email: s.email })),
  })),
  projects,
};

const head =
  `# The IRPD roster, read from ${path.basename(source)} on ${new Date().toISOString().slice(0, 10)}\n` +
  `# by scripts/pilot-from-sheet.mjs. Gitignored: it names students.\n` +
  `#\n` +
  `# Fill in every email before loading; addresses already here survive a\n` +
  `# re-read of the sheet. \`node scripts/pilot-load.mjs --check\` says what is\n` +
  `# missing without writing anything.\n\n`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, head + yaml.dump(out, { lineWidth: 100, noRefs: true }));

const students = groups.reduce((n, g) => n + g.students.length, 0);
const missing = groups.reduce((n, g) => n + g.students.filter((s) => !s.email).length, 0) + out.teachers.filter((t) => !t.email).length;

console.log(
  `\n${OUT}: ${groups.length} groups, ${students} students, ${projects.length} projects ` +
    `(${projects.filter((p) => p.authors.length > 1).length} shared), ${groups.flatMap((g) => g.elders).length} Elders.`
);
for (const n of notes) console.log(`  - ${n}`);
if (missing) console.log(`\n${missing} addresses still to fill in (teachers and students).`);
console.log('');
