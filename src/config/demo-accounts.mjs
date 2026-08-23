/**
 * THE DEMONSTRATION SIGN-INS, IN ONE PLACE.
 *
 * `/demo/` publishes three addresses and a password so somebody evaluating
 * this can open it without asking for anything. Typing them into the page
 * would make the page a second copy of a fact the seed owns, and a copy of a
 * fact drifts the first week somebody renames a handle. The seed reads the
 * domain and the password from here, the page reads the addresses from here,
 * and a rename moves both.
 *
 * Plain JavaScript rather than TypeScript because it has two readers with
 * different runtimes: Vite bundles it into the worker, and
 * `scripts/seed-demo.mjs` imports it under plain Node with no loader.
 *
 * **`.invalid` is reserved and can never be registered**, so a fixture
 * address cannot become somebody's real mailbox and no message the platform
 * ever sends can leave.
 */

/** The reserved domain every fixture person is addressed on. */
export const FIXTURE_DOMAIN = 'demo.invalid';

/** What the seed sets, unless `DEMO_PASSWORD` says otherwise. */
export const DEFAULT_PASSWORD = 'scipath';

/** The tenant demonstrations are given from. Its org file carries `demo: true`. */
export const DEMO_SLUG = 'demo';

/**
 * The three the page offers, out of the many the seed makes.
 *
 * One per viewpoint, because the demonstration is three viewpoints rather
 * than a tour of every account: a student holding a project, an officer
 * looking after other people's, and a teacher who sees a whole program.
 * `advisor` is the unscoped one deliberately, so a visitor sees every queue
 * at once rather than one program's.
 */
export const DEMO_SIGN_INS = [
  {
    handle: 'student.a',
    label: 'Student',
    blurb:
      'Holds a project. Open its notebook, work through what the program asks for, and take it to publication.',
  },
  {
    handle: 'officer.a',
    label: 'Program leader',
    blurb:
      'Looks after other people\u2019s projects. See what is outstanding across a program and where somebody is stuck.',
  },
  {
    handle: 'advisor',
    label: 'Teacher',
    blurb:
      'Sees every program in the school at once, with the approvals, the warnings and the review queue.',
  },
];

/** The address the seed writes for a handle at a tenant. */
export function fixtureAddress(slug, handle) {
  return `${slug}.${handle}@${FIXTURE_DOMAIN}`;
}

/** What `/demo/` shows: the same three, addressed at the demonstration tenant. */
export function demoSignIns() {
  return DEMO_SIGN_INS.map((person) => ({
    ...person,
    email: fixtureAddress(DEMO_SLUG, person.handle),
  }));
}
