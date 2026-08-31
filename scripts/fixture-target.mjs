/**
 * WHERE FIXTURES MAY BE WRITTEN, AND WHAT THEY ARE CALLED.
 *
 * Three scripts invent people and their work — `seed-demo`, `seed-scenarios`,
 * `seed-cases` — and each carried its own copy of the same two facts. The
 * copies had already drifted: `seed-demo` grew an `--allow-remote` escape and
 * the other two kept a flat refusal, and `seed-cases` had a prefix map with
 * three schools in it while `seed-demo` had four. A school added to one was a
 * school missing from the others, silently, until a fixture name came back
 * `undefined_student1` and a case seeded half of itself.
 *
 * So both live here once.
 *
 * **The permission is a fact about the school.** `demo: true` in
 * `src/config/orgs/*.yaml` marks an organization whose people are invented and
 * whose credentials are published. Writing fixtures into a project that is not
 * loopback is allowed only into those. A list of permitted slugs inside a
 * script is a list somebody edits while pointed at production; a school that
 * says of itself that it holds nothing real is checked against whatever the
 * environment happens to say on the day.
 */

import { loadOrgs } from './orgs-library.mjs';

/**
 * The production project, named rather than inferred.
 *
 * Inferring it from the URL would mean every deployment is production, which
 * is the wrong default for a project somebody spun up to try something.
 */
export const PRODUCTION_REF = 'uctbxilvfzaoroffzgen';

/**
 * A fixture's name is built from these, not chosen.
 *
 * `mv_officer1` on a page tells you the tenant, the role and which one,
 * without looking anything up, and it makes the leak test stronger than
 * invented names ever did: a `svs_` anywhere on a Monta Vista page is wrong on
 * sight. 12.11 asks for obviously fictional, and this is more obviously so
 * than a plausible invented person.
 */
export const FIXTURE_PREFIX = {
  montavista: 'mv',
  svslc: 'svs',
  scipath: 'sp',
  demo: 'dm',
};

/** `advisor` is bare and the rest carry a letter. Both become a number, so
    the handles keep their shape and the names read in order. */
export function numberOf(handle) {
  const [, suffix] = handle.split('.');
  if (!suffix) return 1;
  return suffix.charCodeAt(0) - 96;
}

/** What `seed-demo` called this person, so another script can find them. */
export function fixtureName(slug, handle) {
  const prefix = FIXTURE_PREFIX[slug];
  if (!prefix) {
    throw new Error(`No fixture prefix for "${slug}". Add one in scripts/fixture-target.mjs.`);
  }

  const [kind] = handle.split('.');
  return `${prefix}_${kind}${numberOf(handle)}`;
}

/** Which organizations hold nothing real, read from their own files. */
export function demoOnlySlugs() {
  return new Set(
    Object.values(loadOrgs())
      .filter((org) => org.demo === true)
      .map((org) => org.slug)
  );
}

/**
 * Decide whether a target may receive invented people.
 *
 * Returns `{ refuse, note }`: `refuse` is why not, or null; `note` is a line
 * to print when the target is remote and permitted, so a run that writes into
 * the deployed project says so rather than looking like a local one.
 *
 * It answers rather than exits. Taking each script's `fail` as a callback was
 * shorter and made this module responsible for ending a process it knows
 * nothing about — and put a call in here that nothing in here defines, which
 * `tests/scripts.mjs` refuses for the good reason that such a call fails only
 * at run time.
 */
export function fixtureTarget({ url, slugs, allowRemote }) {
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
  if (isLoopback) return { refuse: null, note: null };

  if (!allowRemote) {
    return {
      refuse:
        `Refusing to write fixtures into ${url}.\n` +
        'Fixtures belong on the local stack. If a deployed project is\n' +
        'genuinely the target, pass --allow-remote=<project-ref> explicitly.',
      note: null,
    };
  }

  const demoOnly = demoOnlySlugs();
  const notDemo = slugs.filter((slug) => !demoOnly.has(slug));

  /* Stated as a refusal of everything else rather than as a permission, so a
     slug added in a hurry is refused rather than admitted. */
  if (notDemo.length > 0) {
    return {
      refuse:
        'These are real schools, and fixtures do not go in them:\n' +
        `  ${notDemo.join(', ')}\n\n` +
        'Only an organization whose file carries `demo: true` may be seeded\n' +
        'on a host that is not loopback. See brief 12.11a.',
      note: null,
    };
  }

  const where =
    allowRemote === PRODUCTION_REF || url.includes(PRODUCTION_REF)
      ? 'the production project'
      : url;

  return {
    refuse: null,
    note:
      `\nWriting fixtures into ${where}, for ${slugs.join(', ')}.\n` +
      'Every one of them is marked `demo: true` and holds nothing real.',
  };
}
