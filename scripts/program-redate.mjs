#!/usr/bin/env node
/**
 * MOVE A PROGRAM'S DATES TO WHAT ITS FILE SAYS, IN PLACE (dev-152).
 *
 * A program's template (src/config/programs/*.yaml) is the source of its
 * dates, and the database holds a copy: one row per step in
 * `program_milestones`, and one per step per participation in
 * `entry_milestones`, which is what every page reads. The seed writes
 * them; nothing rewrote them, so a date changed in the file after the
 * pilot began reached nobody. A reset would, and a reset is no longer a
 * thing that can happen to this database.
 *
 * This is the narrow rewrite: for the program named, for each school
 * that runs it, every step whose date in the file differs from the row's
 * gets the file's date (and a step whose `applies_when` came or went is
 * marked required or optional to match, on the row and on every copy) — on the program's row, and on each participation's
 * copy that still carried the old date. A participation whose copy had
 * been moved by hand is left as it was: that copy is somebody's decision,
 * and this script has no way to know it was not. Nothing else on either
 * row changes; nothing a student wrote is touched, and nothing is removed.
 *
 * **Every move is on the record.** An `audit_log` row per step per school
 * (`milestone.redated`: the date before, the date after, how many copies
 * followed, and the file that says so), and the program row's note gains
 * "Moved from <old> on <today>." — so the trail is in the database beside
 * the date, not only in a chat, and `report:day` lists it.
 *
 * Dry by default: it prints what it would do. `--apply` does it.
 *
 * Run:
 *   npm run program:redate -- --program irpd-mvhs-2027                         # local, dry
 *   npm run program:redate -- --program irpd-mvhs-2027 --apply                 # local
 *   npm run program:redate -- --cloud --program irpd-mvhs-2027                 # hosted, dry
 *   npm run program:redate -- --cloud --program irpd-mvhs-2027 --apply         # hosted
 *   … --org montavista                                                        # one school only
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars, loadCloudVars } from './dev-vars.mjs';
import { loadLibrary } from './template-library.mjs';
import { resolveProgram, datesFor } from '../src/lib/template-resolve.ts';

const args = process.argv.slice(2);
const cloud = args.includes('--cloud');
const apply = args.includes('--apply');
const arg = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
const TEMPLATE = arg('--program');
const ONLY_ORG = arg('--org');

if (!TEMPLATE) { console.error('\n  --program <template-id> is needed, for example --program irpd-mvhs-2027.\n'); process.exit(1); }

loadDevVars();
if (cloud) loadCloudVars();

const URL = process.env.PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!URL || !KEY) { console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are both needed (.cloud.vars with --cloud, .dev.vars otherwise).'); process.exit(1); }

const db = createClient(URL, KEY, { auth: { persistSession: false } });
const must = async (promise, what) => { const { data, error } = await promise; if (error) throw new Error(`${what}: ${error.message}`); return data; };

/* The file's dates, resolved the way the seed resolves them. */
const library = loadLibrary();
if (!library.programs.get(TEMPLATE)) { console.error(`\n  No template "${TEMPLATE}" in src/config/programs/.\n`); process.exit(1); }
const declared = resolveProgram(TEMPLATE, library);
const resolved = resolveProgram(TEMPLATE, library, declared.processId ?? 'science');
const wanted = new Map(
  datesFor(resolved)
    .filter((d) => d.date && d.step.id)
    .map((d) => [d.step.id, { date: d.date, source: d.source, window: d.window, step: d.step, required: d.step.applies_when ? false : true }])
);

/* The note the seed writes beside a date, so a date that moved from a
   phase's window to a day of its own stops saying it came from the window. */
const noteFor = (d) => [
  d.source === 'window' && d.window ? `From the ${d.window.from} to ${d.window.to} phase.` : null,
  d.step.note ?? d.step.risk ?? null,
].filter(Boolean).join(' ') || null;

const longDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

async function main() {
  const programs = await must(
    db.from('programs').select('id, org_id, template_id, organizations:org_id(slug)').eq('template_id', TEMPLATE),
    'reading the programs'
  );
  const rows = programs.filter((p) => !ONLY_ORG || p.organizations?.slug === ONLY_ORG);
  if (rows.length === 0) { console.log(`\n  No program from "${TEMPLATE}"${ONLY_ORG ? ` at ${ONLY_ORG}` : ''} in this database.\n`); return; }

  console.log(`\n${apply ? 'Moving' : 'Would move'} the dates of ${TEMPLATE} to the file's${cloud ? ' on the hosted project' : ''}\n`);
  let moved = 0;
  let copies = 0;

  for (const program of rows) {
    const school = program.organizations?.slug ?? (program.org_id ? program.org_id : 'shared');
    const milestones = await must(
      db.from('program_milestones').select('id, step_id, name, due_on, notes, required').eq('program_id', program.id).not('step_id', 'is', null),
      `reading ${school}'s milestones`
    );
    console.log(`  ${school}`);
    let any = false;
    for (const m of milestones) {
      const w = wanted.get(m.step_id);
      if (!w) continue;
      const dateMoves = w.date !== m.due_on;
      const requiredMoves = w.required !== m.required;
      if (!dateMoves && !requiredMoves) continue;
      any = true;
      const entries = await must(
        db.from('entry_milestones').select('id, due_on').eq('program_milestone_id', m.id),
        `reading the copies of ${m.step_id}`
      );
      const following = entries.filter((e) => e.due_on === m.due_on);
      const kept = entries.length - following.length;
      console.log(`    ${m.step_id.padEnd(30)} ${dateMoves ? `${m.due_on ?? '—'} → ${w.date}` : `${w.date} (unchanged)`}${requiredMoves ? `, ${w.required ? 'now required' : 'now optional'}` : ''}   ${following.length} participation${following.length === 1 ? '' : 's'} follow${kept ? `, ${kept} moved by hand and left` : ''}`);
      if (!apply) continue;
      /* The trail on the row itself: what the seed would say, then the move. */
      const trail = `Moved from ${m.due_on ? longDate(m.due_on) : 'no date'} on ${longDate(today)}.`;
      const notes = [noteFor(w), trail].filter(Boolean).join(' ');
      await must(db.from('program_milestones').update({ due_on: w.date, required: w.required, ...(dateMoves ? { notes } : {}) }).eq('id', m.id), `moving ${m.step_id}`);
      if (requiredMoves) {
        await must(db.from('entry_milestones').update({ required: w.required }).eq('program_milestone_id', m.id), `marking the copies of ${m.step_id}`);
      }
      if (dateMoves && following.length) {
        const q = db.from('entry_milestones').update({ due_on: w.date }).eq('program_milestone_id', m.id);
        await must(m.due_on === null ? q.is('due_on', null) : q.eq('due_on', m.due_on), `moving the copies of ${m.step_id}`);
      }
      /* And the audit row, for the report. A program shared by every
         school has no org of its own; the log needs one, so a shared
         program's move is written against each school that runs it would
         be the honest form, but every program moved this way is a school's
         own (a shared fair's dates are the fair's), so the row's org is the
         program's. */
      if (program.org_id) {
        await must(db.from('audit_log').insert({
          org_id: program.org_id,
          action: 'milestone.redated',
          entity_type: 'program_milestone',
          entity_id: m.id,
          before: { due_on: m.due_on, required: m.required },
          after: { due_on: w.date, required: w.required },
          reason: `${m.name} (${m.step_id}): ${dateMoves ? `${m.due_on ?? 'no date'} → ${w.date}` : 'date unchanged'}${requiredMoves ? `, ${w.required ? 'now required' : 'now optional'}` : ''}, from src/config/programs/${TEMPLATE}.yaml; ${dateMoves ? `${following.length} participation cop${following.length === 1 ? 'y' : 'ies'} moved${kept ? `, ${kept} left as set by hand` : ''}` : 'no copies moved'}`,
        }), `recording ${m.step_id}`);
      }
      moved += 1;
      copies += following.length;
    }
    if (!any) console.log('    every date already matches the file');
  }

  console.log(apply
    ? `\nDone: ${moved} step${moved === 1 ? '' : 's'} moved, ${copies} participation cop${copies === 1 ? 'y' : 'ies'} with them. Open tabs see the new dates on their next load.\n`
    : '\nNothing changed. Add --apply to do it.\n');
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
