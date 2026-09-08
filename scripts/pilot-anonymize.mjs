/**
 * THE ROSTER WITH NO PEOPLE IN IT.
 *
 * Reads a roster the sheet script wrote (local-data/pilot-irpd.yaml) and
 * writes a copy in which every person is an identifier and nothing else:
 * students S00, S01, …; Elders E00, E01, … (an Elder who is also a student
 * in the class is the E, once); teachers T00, T01, …. Every place the file
 * names a person changes together — `key`, `name`, `email`, the `elders`
 * of a group, the `authors` of a project, and `student` and `by` on a
 * score — so the file still loads: the loader matches people by key and
 * by address and never by anything else. The address becomes
 * `<id>@scipath.org` in lower case, which is not a mailbox anybody holds,
 * and both domain fields become `scipath.org` so the loader's domain check
 * still passes. Group names, project titles, grades, dates and scores are
 * untouched.
 *
 * Who gets which number is drawn at random, except one: `--me <name>`
 * names the person who becomes E00 (default "Rohan Agarwal"). The drawing
 * is written beside the output as a CSV — real key, real name, real
 * address, identifier — which is the only way back and lives in
 * `local-data/`, gitignored, like everything else that names a student.
 *
 *   node scripts/pilot-anonymize.mjs                        # local-data/pilot-irpd.yaml → local-data/pilot-irpd.anon.yaml
 *   node scripts/pilot-anonymize.mjs --in a.yaml --out b.yaml --me "Rohan Agarwal"
 *
 * Nothing here touches a database.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import yaml from 'js-yaml';

const args = process.argv.slice(2);
const arg = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const IN = arg('--in', 'local-data/pilot-irpd.yaml');
const OUT = arg('--out', IN.replace(/\.ya?ml$/, '') + '.anon.yaml');
const MAP = arg('--map', OUT.replace(/\.ya?ml$/, '') + '.idmap.csv');
const ME = arg('--me', 'Rohan Agarwal');
const DOMAIN = arg('--domain', 'scipath.org');

const fail = (m) => { console.error(m); process.exit(1); };
if (!fs.existsSync(IN)) fail(`No roster at ${IN}.`);

/* JSON schema: dates stay the text they were written as, rather than
   becoming timestamps on the way through. */
const doc = yaml.load(fs.readFileSync(IN, 'utf8'), { schema: yaml.JSON_SCHEMA });
if (!doc || typeof doc !== 'object') fail(`${IN} is not a roster.`);

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/* ── Who is in the file ───────────────────────────────────────────────── */
const people = new Map();         // key -> { key, name, email, kind }
const byName = new Map();         // normalised name -> key
const byEmail = new Map();        // normalised email -> key
const add = (row, kind) => {
  const key = String(row?.key ?? '').trim();
  if (!key) fail(`a ${kind} has no key`);
  if (people.has(key)) fail(`key ${key} appears twice`);
  const p = { key, name: String(row.name ?? '').trim(), email: String(row.email ?? '').trim(), kind };
  people.set(key, p);
  if (p.name) byName.set(norm(p.name), key);
  if (p.email) byEmail.set(norm(p.email), key);
};
for (const t of doc.teachers ?? []) add(t, 'teacher');
for (const g of doc.groups ?? []) for (const s of g.students ?? []) add(s, 'student');

const elderKeys = new Set();
for (const g of doc.groups ?? []) for (const e of g.elders ?? []) {
  const k = String(e);
  if (k.startsWith('UNRESOLVED-')) continue;
  if (!people.has(k)) fail(`group "${g.name}" names Elder ${k}, who is not in the file`);
  elderKeys.add(k);
}

/* A reference anywhere in the file: a key, a full name, or an address. */
const resolve = (ref) => {
  const s = String(ref ?? '').trim();
  if (people.has(s)) return s;
  if (byName.has(norm(s))) return byName.get(norm(s));
  if (byEmail.has(norm(s))) return byEmail.get(norm(s));
  return null;
};

/* ── The drawing ─────────────────────────────────────────────────────── */
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const two = (n) => String(n).padStart(2, '0');

const meKey = resolve(ME);
if (!meKey) fail(`--me "${ME}" is not in the file (by key, name or address).`);
if (!elderKeys.has(meKey)) fail(`${ME} is not an Elder of any group, so cannot be E00.`);

const ids = new Map();
let n = 0;
ids.set(meKey, 'E00');
n = 1;
for (const k of shuffle([...elderKeys].filter((k) => k !== meKey))) ids.set(k, `E${two(n++)}`);
n = 0;
for (const k of shuffle([...people.keys()].filter((k) => people.get(k).kind === 'student' && !elderKeys.has(k)))) ids.set(k, `S${two(n++)}`);
n = 0;
for (const k of shuffle([...people.keys()].filter((k) => people.get(k).kind === 'teacher'))) ids.set(k, `T${two(n++)}`);

const idOf = (ref, where) => {
  const k = resolve(ref);
  if (!k) fail(`${where}: "${ref}" is not anybody in the file`);
  return ids.get(k);
};
const emailOf = (id) => `${id.toLowerCase()}@${DOMAIN}`;

/* ── The copy ────────────────────────────────────────────────────────── */
const out = structuredClone(doc);
out.student_domain = DOMAIN;
out.staff_domain = DOMAIN;
for (const t of out.teachers ?? []) {
  const id = ids.get(t.key);
  t.key = id; t.name = id; t.email = emailOf(id);
}
for (const g of out.groups ?? []) {
  g.elders = (g.elders ?? []).map((e) => (String(e).startsWith('UNRESOLVED-') ? e : idOf(e, `group "${g.name}" elders`)));
  for (const s of g.students ?? []) {
    const id = ids.get(s.key);
    s.key = id; s.name = id; s.email = emailOf(id);
  }
}
for (const p of out.projects ?? []) {
  p.authors = (p.authors ?? []).map((a) => idOf(a, `project "${p.title}" authors`));
}
for (const [i, sc] of (out.scores ?? []).entries()) {
  if (sc.student != null) sc.student = idOf(sc.student, `scores[${i}] student`);
  if (sc.by != null) sc.by = idOf(sc.by, `scores[${i}] by`);
}

/* Nothing that was a name may survive: every real key, name and address
   from the input is searched for in the output text. */
const text = yaml.dump(out, { lineWidth: 100, noRefs: true, schema: yaml.JSON_SCHEMA });
const lower = text.toLowerCase();
for (const p of people.values()) {
  for (const needle of [p.key, p.name, p.email].map(norm).filter((s) => s.length > 2)) {
    if (lower.includes(needle)) fail(`"${needle}" still appears in the output — nothing was written.`);
  }
}

const head =
  `# The IRPD roster with every person replaced by an identifier, written on ${new Date().toISOString().slice(0, 10)}\n` +
  `# by scripts/pilot-anonymize.mjs from ${path.basename(IN)}. The drawing is in ${path.basename(MAP)}.\n\n`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, head + text);

const csv = [['key', 'name', 'email', 'id']]
  .concat([...people.values()].map((p) => [p.key, p.name, p.email, ids.get(p.key)]))
  .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
  .join('\n') + '\n';
fs.writeFileSync(MAP, csv, { mode: 0o600 });

const count = (prefix) => [...ids.values()].filter((v) => v.startsWith(prefix)).length;
console.log(`Wrote ${OUT}: ${count('S')} students, ${count('E')} Elders (E00 is ${people.get(meKey).name}), ${count('T')} teachers.`);
console.log(`The drawing is in ${MAP} (mode 600). Keep it in local-data; it is the only way back.`);
