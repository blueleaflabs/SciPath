/**
 * THE PROJECT THAT HOLDS REAL STUDENTS.
 *
 * From the IRPD pilot there is a Supabase project whose rows are a class's
 * actual work: their projects, their notebooks, their deadlines, their
 * guardians' answers. Nothing in this repository could previously tell that
 * project apart from any other, and `reset-cloud.mjs` truncates by table
 * rather than by organization — so refreshing the demonstration tenant takes
 * the pilot with it, in one command, with no warning that names the loss.
 *
 * **The demo and the pilot share one database for now.** That is a decision
 * taken deliberately with two days to go, and it is fine as long as nothing
 * destructive can reach it. This file is what makes that true.
 *
 * ── Why a positive declaration rather than a blocklist ────────────────────
 *
 * The obvious shape is "refuse if the target is the pilot", and it fails the
 * way 19.9's tenancy guard failed: `account && accountSlug && accountSlug !==
 * slug` admitted the account whenever the slug was missing. A guard whose
 * subject can be absent is a guard that opens when the configuration is
 * incomplete, which is exactly when somebody is most likely to be running the
 * wrong thing.
 *
 * So the rule is stated the other way round. **You must say which project
 * holds real students before a destructive command will run at all.** Not
 * knowing is refused, because "I do not know which one is production" is not
 * a state in which anything should be dropped.
 *
 * ── Why there is no override flag ─────────────────────────────────────────
 *
 * A `--i-really-mean-it` is how a refusal becomes a warning, and a warning is
 * what somebody types past at eleven at night. If the pilot genuinely has to
 * be rebuilt, that is an edit to `.cloud.vars` made in daylight with the file
 * open, which is a slower and more deliberate act than a flag, and that
 * slowness is the whole feature.
 */

import { loadCloudVars } from './dev-vars.mjs';

/* Loaded here as well as in the caller, and harmlessly: the loader fills a
   variable only where nothing has set one. It is here for the reason
   `notebook-bucket.mjs` gives about itself — a module that reads
   configuration and trusts somebody else to have loaded it is a module that
   works until it is imported by the one script that did not. On a guard, that
   script is the one where it fails open. */
loadCloudVars();

/**
 * Refuse a destructive command against the project holding real students.
 *
 * @param {string} ref   the project ref the command is about to act on
 * @param {string} what  what the command would do, said plainly
 * @param {(message: string) => never} fail  the caller's own refusal
 */
export function refuseAgainstPilot(ref, what, fail) {
  const pilot = (process.env.PILOT_PROJECT_REF ?? '').trim();

  if (!pilot) {
    fail(
      'PILOT_PROJECT_REF is not set, so this cannot tell whether the project\n' +
        'it is pointed at holds real students.\n\n' +
        `  It would ${what}\n` +
        `  against  ${ref}\n\n` +
        'Add the ref of the project the pilot runs on to .cloud.vars:\n\n' +
        '  PILOT_PROJECT_REF=abcdefghijklmnop\n\n' +
        'Set it even when the two are the same project. Not knowing which one\n' +
        'is production is not a state in which anything should be dropped.\n\n' +
        'Nothing has been changed.'
    );
  }

  if (ref === pilot) {
    fail(
      `${ref} is the pilot project, and it holds a class's real work.\n\n` +
        `  This would ${what}\n\n` +
        'There is no flag that permits it. If the pilot really has to be\n' +
        'rebuilt, take a backup first:\n\n' +
        '  npm run backup -- --cloud\n\n' +
        'and then change PILOT_PROJECT_REF in .cloud.vars, which is a slower\n' +
        'and more deliberate act than typing past a prompt.\n\n' +
        'Nothing has been changed.'
    );
  }
}
