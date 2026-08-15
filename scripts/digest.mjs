/**
 * BUILDING AND SENDING DIGESTS.
 *
 * The half of the notification system that reads the templates rather than
 * the outbox. Nothing here schedules anything in advance: a digest is
 * computed at the moment it is queued, from state as it stands, which is why
 * a form signed at seven cannot be described by a message written at six
 * (20.2).
 *
 * A script for now rather than a scheduled Worker, so it can be run by hand
 * against the local database and read in a terminal. The Worker is the same
 * three steps behind a cron trigger.
 *
 *   npm run digest            print what would be sent, send nothing
 *   npm run digest -- --send  actually hand it to the transport
 *
 * `--send` is still governed by everything in transport.ts: the default is
 * the console transport, `@demo.invalid` is refused, and `MAIL_ALLOWLIST`
 * decides who may be written to at all. Three guards, and this flag is not
 * one of them.
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars } from './dev-vars.mjs';
import { loadLibrary } from './template-library.mjs';
import { resolveProgram, datesFor } from '../src/lib/template-resolve.ts';
import { projectStatus } from '../src/lib/status.ts';
import { renderDigest, cadenceNeeded } from '../src/lib/notify/digest.ts';
import { transportFor } from '../src/lib/notify/transport.ts';
import { orgs } from '../src/config/orgs.ts';

loadDevVars();

const URL_ = process.env.PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SECRET_KEY ?? '';

if (!URL_ || !KEY) {
  console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are needed. They live in .dev.vars.');
  process.exit(1);
}

/**
 * What this run will actually do, printed before it does it.
 *
 * The mail configuration comes from two places and one of them wins
 * silently: `loadDevVars` never overwrites a variable already in
 * `process.env`, so anything exported into the shell beats the file. Somebody
 * who comments a line out of `.dev.vars`, reloads, and runs again gets the
 * old value with nothing to suggest why. That cost a debugging session, and
 * printing four lines is cheaper than the next one.
 *
 * So the run says what it is holding. The key is shown as present or absent
 * and never printed.
 */
function announce(env) {
  const transport = env.MAIL_TRANSPORT === 'resend' ? 'resend' : 'console';

  console.log('Mail configuration for this run:');
  console.log(`  transport   ${transport}${transport === 'console' ? '  (prints, sends nothing)' : ''}`);
  console.log(`  from        ${env.MAIL_FROM || '(unset)'}`);
  console.log(`  allowlist   ${env.MAIL_ALLOWLIST || '(none, so every address is permitted)'}`);
  console.log(`  api key     ${env.RESEND_API_KEY ? 'set' : 'not set'}`);

  console.log('');
}

const send = process.argv.includes('--send');

/**
 * `npm run digest --send` does not do what it looks like.
 *
 * npm treats a bare `--send` as its own flag and never passes it on, so the
 * script runs in dry mode and prints, and somebody who asked for a send and
 * got a printout reasonably concludes nothing happened. The separator is
 * required: `npm run digest -- --send`.
 */
if (!send && process.env.npm_config_send) {
  console.log('\nIt looks like you meant: npm run digest -- --send');
  console.log('npm keeps a bare --send for itself. Printing instead.\n');
}
announce(process.env);

const db = createClient(URL_, KEY, { auth: { persistSession: false } });
const library = loadLibrary();

/**
 * Where a link should point.
 *
 * Built from the organization record rather than a constant, for the same
 * reason no page contains a school's name. Local development has no scheme
 * on the hostname, so one is added: a link in a message has to be absolute
 * or it is not a link.
 */
function originFor(slug) {
  const org = orgs[slug];
  const host = org?.hostname ?? `${slug}.localhost`;
  const local = host.endsWith('.localhost') || host.startsWith('localhost');
  return local ? `http://${host}:4321` : `https://${host}`;
}

/* Everything the status computation needs, in four queries rather than four
   per project: a season is a few hundred rows, and a query per entry is how
   a script that runs in a second starts taking a minute. */
const { data: entries, error } = await db
  .from('opportunity_participations')
  .select(
    'id, project_id, status, org_id, ' +
      'programs(id, name, season_year, template_id), ' +
      'projects(id, title, facts, process_id, project_authors(role, accepted_at, self_managed_at, users(id, display_name)))'
  )
  .in('status', ['entered', 'competed']);

if (error) {
  console.error(`Could not read the entries: ${error.message}`);
  process.exit(1);
}

/* Which school each entry belongs to, so a link points at the right
   hostname. Taken from the row rather than guessed: an earlier version of
   this picked the first organization that was not the platform, which is
   correct exactly when there is one school and silently wrong after that. */
const { data: organizations } = await db.from('organizations').select('id, slug');
const slugOf = new Map((organizations ?? []).map((o) => [o.id, o.slug]));

/**
 * Addresses, from the auth directory rather than from `public.users`.
 *
 * There is no `email` column on `public.users` and there should not be: an
 * address is a credential, it belongs to the auth schema, and fixtures are
 * made with `auth.admin.createUser`, which never writes a profile row. This
 * script asked `public.users` for one and PostgREST answered
 * `column users_3.email does not exist` — the alias being its own name for
 * the third join to that table, which is normal, and the column being a
 * mistake, which is not.
 *
 * Paged, because the directory returns fifty at a time by default and one
 * school alone has more than that.
 */
const emailOf = new Map();

for (let page = 1; page <= 20; page += 1) {
  const { data, error: authError } = await db.auth.admin.listUsers({ page, perPage: 200 });

  if (authError) {
    console.error(`Could not read the directory: ${authError.message}`);
    process.exit(1);
  }

  for (const user of data?.users ?? []) {
    if (user.email) emailOf.set(user.id, user.email);
  }

  if ((data?.users?.length ?? 0) < 200) break;
}

/* What each person asked for. Absent means the default: weekly, with urgent
   items on. A screen that offers a choice and a sender that ignores it is
   worse than offering no choice (20.4). */
const { data: settings } = await db
  .from('notification_settings')
  .select('user_id, enabled, cadence, urgent')
  .eq('category', 'reminders')
  .eq('channel', 'email');

const wants = new Map((settings ?? []).map((row) => [row.user_id, row]));

console.log(
  `Read ${entries?.length ?? 0} ${entries?.length === 1 ? 'participation' : 'participations'} ` +
    `that were granted a place.`
);

if ((entries?.length ?? 0) === 0) {
  console.log(
    'Nothing was granted, so there is nobody to write to. An entry still\n' +
      'waiting on a decision is deliberately excluded: a digest is about work\n' +
      'somebody has been let into.'
  );
}

const ids = (entries ?? []).map((e) => e.id);

const { data: recorded } = ids.length
  ? await db.from('deliverables').select('participation_id, type').in('participation_id', ids)
  : { data: [] };

const recordedFor = new Map();
for (const row of recorded ?? []) {
  const held = recordedFor.get(row.participation_id) ?? new Set();
  held.add(row.type);
  recordedFor.set(row.participation_id, held);
}

/* Resolved once per template rather than once per entry. Fifteen entries in
   one program is one resolution, not fifteen. */
const templates = new Map();
const dueByTemplate = new Map();

/**
 * The program as this project sees it.
 *
 * Keyed on both, because the same fair resolves differently for a scientific
 * project and an engineering one: the process comes from the work rather
 * than from the venue (22.4). Resolved once per pair rather than once per
 * entry, since fifteen projects in one program with one process is one
 * resolution.
 */
function templateFor(programTemplate, processId) {
  if (!programTemplate) return null;

  const key = `${programTemplate}::${processId ?? ''}`;

  if (!templates.has(key)) {
    try {
      const resolved = resolveProgram(programTemplate, library, processId);
      templates.set(key, resolved);
      dueByTemplate.set(key, new Map(datesFor(resolved).map((d) => [d.step.id, d.date])));
    } catch {
      templates.set(key, null);
      dueByTemplate.set(key, new Map());
    }
  }

  return { template: templates.get(key), dueBy: dueByTemplate.get(key) ?? new Map() };
}

/**
 * Who hears about what.
 *
 * An author hears about their own project. Everybody else is looking after
 * it, which is a different section of the message and a different question:
 * "what do I owe" against "what is somebody I look after behind on".
 */
const people = new Map();

function note(user, slug, status, mine) {
  const email = user?.id ? emailOf.get(user.id) : null;

  /* Somebody with no address in the directory is skipped rather than
     failing the run: a pending role grant has a name and no account yet. */
  if (!email) return;

  const held = people.get(user.id) ?? {
    id: user.id,
    name: user.display_name ?? 'there',
    email,
    slug,
    mine: [],
    watched: [],
  };

  (mine ? held.mine : held.watched).push(status);
  people.set(user.id, held);
}

for (const entry of entries ?? []) {
  const project = entry.projects;
  const program = entry.programs;
  if (!project) continue;

  const resolvedFor = templateFor(program?.template_id, project.process_id);

  const status = projectStatus({
    entryId: entry.id,
    projectId: project.id,
    title: project.title,
    programName: program ? `${program.name}, ${program.season_year}` : 'No program',
    template: resolvedFor?.template ?? null,
    facts: project.facts ?? {},
    recorded: recordedFor.get(entry.id) ?? new Set(),
    dueBy: resolvedFor?.dueBy ?? new Map(),
  });

  const slug = slugOf.get(entry.org_id) ?? 'montavista';

  for (const attachment of project.project_authors ?? []) {
    const isAuthor = attachment.role === 'author' && attachment.accepted_at;
    const looksAfter = attachment.role === 'officer' || attachment.self_managed_at;
    if (!isAuthor && !looksAfter) continue;

    note(attachment.users, slug, status, Boolean(isAuthor));
  }
}

/* ── What would go out ─────────────────────────────────────────────────── */

const transport = transportFor(process.env);
let written = 0;
let quiet = 0;

/* Why somebody heard nothing. A run that reports "0 digests" and stops is
   indistinguishable from a broken one, which is the whole reason this
   script was hard to trust the first time it produced nothing. */
const why = [];

for (const person of people.values()) {
  const origin = originFor(person.slug ?? 'montavista');

  const input = {
    mine: person.mine,
    watched: person.watched,
    origin,
    schoolName: orgs[person.slug ?? 'montavista']?.name ?? 'SciPath',
    settingsPath: '/app/profile/?at=notifications',
  };

  const cadence = cadenceNeeded(input);

  /* Nothing outstanding, nothing sent. A weekly message saying there is
     nothing to do is how somebody learns to filter the one that matters. */
  if (cadence === 'none') {
    quiet += 1;
    why.push(`${person.email}: nothing is inside a reminder window yet`);
    continue;
  }

  const asked = wants.get(person.id);

  /* Turned off entirely. */
  if (asked && !asked.enabled) {
    quiet += 1;
    why.push(`${person.email}: turned the digest off on their profile`);
    continue;
  }

  /* Somebody on the weekly setting, on a day when nothing is urgent, hears
     from the weekly run rather than from every daily one. What the contents
     earned decides whether there is anything worth saying today; what the
     person asked for decides whether today is their day. */
  const wanted = asked?.cadence ?? 'weekly';

  if (cadence === 'daily' && wanted === 'weekly' && asked?.urgent === false) {
    quiet += 1;
    why.push(`${person.email}: on weekly, and asked not to hear about urgent items`);
    continue;
  }

  const message = renderDigest(input);
  if (!message) {
    quiet += 1;
    continue;
  }

  written += 1;

  if (send) {
    const result = await transport.send({
      to: person.email,
      subject: message.subject,
      text: message.text,
    });
    if (!result.ok) console.error(`  failed   ${person.email}  ${result.error}`);
  } else {
    console.log(
      [
        '',
        '='.repeat(72),
        `To:       ${person.name} <${person.email}>`,
        `Cadence:  ${cadence}`,
        `Subject:  ${message.subject}`,
        '='.repeat(72),
        message.text,
      ].join('\n')
    );
  }
}

console.log(
  `\n${people.size} ${people.size === 1 ? 'person' : 'people'} on those projects. ` +
    `${written} ${written === 1 ? 'digest' : 'digests'}, ${quiet} silent.`
);

if (why.length > 0) {
  console.log('\nWhy somebody heard nothing:');
  for (const line of why) console.log(`  ${line}`);
}

if (people.size === 0 && (entries?.length ?? 0) > 0) {
  console.log(
    '\nThose participations have no author with an address in the auth\n' +
      'directory. An author is somebody with an accepted `project_authors`\n' +
      'row; a project created by somebody else and never accepted has none.'
  );
}

if (!send) {
  console.log('Nothing was sent. Add --send to hand these to the transport.');
} else {
  console.log(`Sent through the ${transport.name} transport.`);
}
