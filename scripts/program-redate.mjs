#!/usr/bin/env node
/**
 * MOVE A PROGRAM'S CALENDAR TO WHAT ITS FILE SAYS, IN PLACE (dev-152, dev-160).
 *
 * A program's template (src/config/programs/*.yaml) is the source of its
 * calendar, and the database holds a copy: one row per step in
 * `program_milestones`, and one per step per participation in
 * `entry_milestones`, which is what every page reads. The seed writes
 * them; nothing rewrote them, so a change in the file after the pilot
 * began reached nobody. A reset would, and a reset is no longer a thing
 * that can happen to this database.
 *
 * This is the narrow rewrite, for the program named, for each school that
 * runs it:
 *
 *   - **A step whose date changed** gets the file's date on the program's
 *     row, and on each participation's copy that still carried the old
 *     date. A copy somebody moved by hand is left as it was: that copy is
 *     a decision, and this script has no way to know it was not.
 *   - **A step whose shape in the calendar changed** — required or not,
 *     what it waits on (`requires`), its name, its phase, its order, which
 *     deliverable it asks for — gets those on the row and on every copy.
 *     None of that is anybody's decision per participation.
 *   - **A step in the file with no row** (dev-160) is added: the program
 *     row exactly as the seed would have written it (`milestone-rows.mjs`,
 *     the one builder both scripts use), and a copy for every
 *     participation of the program.
 *   - **A step with a row and no step in the file** is reported and left.
 *     Nothing here deletes, and nothing a student wrote is touched.
 *
 * **Every change is on the record.** An `audit_log` row per step per
 * school (`milestone.redated` for a change, `milestone.added` for an
 * addition: before, after, how many copies, the file), and a moved date's
 * note gains "Moved from <old> on <today>." — so the trail is in the
 * database beside the row, not only in a chat, and `report:day` lists it.
 *
 * Dry by default: it prints what it would do. `--apply` does it. Safe to
 * run twice: the second run finds nothing to do.
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
import { milestoneRow, entryCopy, noteFor } from './milestone-rows.mjs';

const longDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/* The columns of the row, beyond the date, that the file decides for every
   copy alike. `deliverable_ref` is the program row's only. */
export const SHAPE = ['name', 'required', 'requires_step', 'requires_steps', 'sort_order', 'phase', 'owner', 'feedback_on', 'kind'];

/**
 * The work, over any client that speaks supabase-js (the CLI below passes
 * the real one; tests/redate.mjs passes a fake over arrays). Returns the
 * counts. `today` is YYYY-MM-DD in the school's time.
 */
export async function redate(db, { template, onlyOrg = null, apply = false, cloud = false, today, log = console.log }) {
  const must = async (promise, what) => { const { data, error } = await promise; if (error) throw new Error(`${what}: ${error.message}`); return data; };

  /* The file's calendar, resolved the way the seed resolves it. */
  const library = loadLibrary();
  if (!library.programs.get(template)) throw new Error(`No template "${template}" in src/config/programs/.`);
  const declared = resolveProgram(template, library);
  const resolved = resolveProgram(template, library, declared.processId ?? 'science');
  const dated = datesFor(resolved).filter((d) => d.date && d.step.id);

  const programs = await must(
    db.from('programs').select('id, org_id, template_id, organizations:org_id(slug)').eq('template_id', template),
    'reading the programs'
  );
  const rows = programs.filter((p) => !onlyOrg || p.organizations?.slug === onlyOrg);
  if (rows.length === 0) { log(`\n  No program from "${template}"${onlyOrg ? ` at ${onlyOrg}` : ''} in this database.\n`); return; }

  log(`\n${apply ? 'Moving' : 'Would move'} the calendar of ${template} to the file's${cloud ? ' on the hosted project' : ''}\n`);
  let changed = 0, added = 0, copies = 0;

  for (const program of rows) {
    const school = program.organizations?.slug ?? (program.org_id ? program.org_id : 'shared');
    const wanted = new Map(dated.map((d, index) => [d.step.id, { d, row: milestoneRow(d, index, { programId: program.id, orgId: program.org_id }) }]));
    const milestones = await must(
      db.from('program_milestones').select('id, step_id, name, due_on, notes, required, requires_step, requires_steps, sort_order, phase, owner, feedback_on, kind, deliverable_ref').eq('program_id', program.id).not('step_id', 'is', null),
      `reading ${school}'s milestones`
    );
    const have = new Map(milestones.map((m) => [m.step_id, m]));
    log(`  ${school}`);
    let any = false;

    /* ── Steps with a row: what differs ──────────────────────────────── */
    for (const m of milestones) {
      const w = wanted.get(m.step_id);
      if (!w) { log(`    ${m.step_id.padEnd(30)} in the database and not in the file; left as it is`); continue; }
      const dateMoves = w.row.due_on !== m.due_on;
      const shapeMoves = SHAPE.filter((k) => !same(w.row[k], m[k]));
      const refMoves = !same(w.row.deliverable_ref, m.deliverable_ref);
      if (!dateMoves && shapeMoves.length === 0 && !refMoves) continue;
      any = true;
      const entries = await must(
        db.from('entry_milestones').select('id, due_on').eq('program_milestone_id', m.id),
        `reading the copies of ${m.step_id}`
      );
      const following = entries.filter((e) => e.due_on === m.due_on);
      const kept = entries.length - following.length;
      const said = [
        dateMoves ? `${m.due_on ?? '—'} → ${w.row.due_on}` : null,
        ...shapeMoves.map((k) => `${k}: ${JSON.stringify(m[k])} → ${JSON.stringify(w.row[k])}`),
        refMoves ? `deliverable: ${m.deliverable_ref ?? '—'} → ${w.row.deliverable_ref ?? '—'}` : null,
      ].filter(Boolean).join('; ');
      log(`    ${m.step_id.padEnd(30)} ${said}   ${dateMoves ? `${following.length} participation${following.length === 1 ? '' : 's'} follow${kept ? `, ${kept} moved by hand and left` : ''}` : `${entries.length} cop${entries.length === 1 ? 'y' : 'ies'} follow`}`);
      if (!apply) continue;

      const patch = {};
      for (const k of shapeMoves) patch[k] = w.row[k];
      if (refMoves) patch.deliverable_ref = w.row.deliverable_ref;
      if (dateMoves) {
        patch.due_on = w.row.due_on;
        /* The trail on the row itself: what the seed would say, then the move. */
        patch.notes = [noteFor(w.d), `Moved from ${m.due_on ? longDate(m.due_on) : 'no date'} on ${longDate(today)}.`].filter(Boolean).join(' ');
      }
      await must(db.from('program_milestones').update(patch).eq('id', m.id), `changing ${m.step_id}`);

      const copyPatch = {};
      for (const k of shapeMoves) copyPatch[k] = w.row[k];
      if (Object.keys(copyPatch).length) {
        await must(db.from('entry_milestones').update(copyPatch).eq('program_milestone_id', m.id), `reshaping the copies of ${m.step_id}`);
      }
      if (dateMoves && following.length) {
        const q = db.from('entry_milestones').update({ due_on: w.row.due_on }).eq('program_milestone_id', m.id);
        await must(m.due_on === null ? q.is('due_on', null) : q.eq('due_on', m.due_on), `moving the copies of ${m.step_id}`);
      }
      /* And the audit row, for the report. Every program moved this way is a
         school's own, so the row's org is the program's. */
      if (program.org_id) {
        const before = { due_on: m.due_on }; const after = { due_on: w.row.due_on };
        for (const k of shapeMoves) { before[k] = m[k]; after[k] = w.row[k]; }
        if (refMoves) { before.deliverable_ref = m.deliverable_ref; after.deliverable_ref = w.row.deliverable_ref; }
        await must(db.from('audit_log').insert({
          org_id: program.org_id,
          action: 'milestone.redated',
          entity_type: 'program_milestone',
          entity_id: m.id,
          before, after,
          reason: `${m.name} (${m.step_id}): ${said}, from src/config/programs/${template}.yaml; ${dateMoves ? `${following.length} participation cop${following.length === 1 ? 'y' : 'ies'} moved${kept ? `, ${kept} left as set by hand` : ''}` : `${entries.length} copies reshaped`}`,
        }), `recording ${m.step_id}`);
      }
      changed += 1;
      copies += dateMoves ? following.length : entries.length;
    }

    /* ── Steps in the file with no row: added, with a copy for everyone ── */
    const missing = dated.filter((d) => !have.has(d.step.id));
    if (missing.length) {
      const participations = await must(
        db.from('participations').select('id, org_id').eq('program_id', program.id),
        `reading ${school}'s participations`
      );
      for (const d of missing) {
        any = true;
        const row = wanted.get(d.step.id).row;
        log(`    ${d.step.id.padEnd(30)} new: ${row.name}, due ${row.due_on}${row.requires_steps.length ? `, waits on ${row.requires_steps.join(', ')}` : ''}   ${participations.length} cop${participations.length === 1 ? 'y' : 'ies'} to make`);
        if (!apply) continue;
        const inserted = await must(db.from('program_milestones').insert(row).select('id').single(), `adding ${d.step.id}`);
        const toCopy = participations.map((p) => entryCopy(row, inserted.id, { participationId: p.id, orgId: p.org_id }));
        if (toCopy.length) await must(db.from('entry_milestones').insert(toCopy), `copying ${d.step.id}`);
        if (program.org_id) {
          await must(db.from('audit_log').insert({
            org_id: program.org_id,
            action: 'milestone.added',
            entity_type: 'program_milestone',
            entity_id: inserted.id,
            before: null,
            after: { due_on: row.due_on, required: row.required, requires_steps: row.requires_steps, name: row.name },
            reason: `${row.name} (${d.step.id}) added, due ${row.due_on}, from src/config/programs/${template}.yaml; ${toCopy.length} participation cop${toCopy.length === 1 ? 'y' : 'ies'} made`,
          }), `recording ${d.step.id}`);
        }
        added += 1;
        copies += toCopy.length;
      }
    }

    if (!any) log('    the calendar already matches the file');
  }

  log(apply
    ? `\nDone: ${changed} step${changed === 1 ? '' : 's'} changed, ${added} added, ${copies} participation cop${copies === 1 ? 'y' : 'ies'} with them. Open tabs see the new calendar on their next load.\n`
    : '\nNothing changed. Add --apply to do it.\n');
  return { changed, added, copies };
}

/* ── The command ─────────────────────────────────────────────────────── */
if (process.argv[1] && /program-redate\.mjs$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const cloud = args.includes('--cloud');
  const apply = args.includes('--apply');
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : null; };
  const template = arg('--program');
  const onlyOrg = arg('--org');
  if (!template) { console.error('\n  --program <template-id> is needed, for example --program irpd-mvhs-2027.\n'); process.exit(1); }

  loadDevVars();
  if (cloud) loadCloudVars();
  const URL = process.env.PUBLIC_SUPABASE_URL;
  const KEY = process.env.SUPABASE_SECRET_KEY;
  if (!URL || !KEY) { console.error('PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY are both needed (.cloud.vars with --cloud, .dev.vars otherwise).'); process.exit(1); }
  const db = createClient(URL, KEY, { auth: { persistSession: false } });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  redate(db, { template, onlyOrg, apply, cloud, today }).catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
}
