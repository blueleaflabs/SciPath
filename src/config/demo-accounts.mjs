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
 * **THE DOMAIN, AND WHY IT IS A REAL ONE.**
 *
 * This was `demo.invalid`, reserved by RFC 2606 and unregisterable, so a
 * fixture address could never become a real mailbox and no message the
 * platform sent could ever leave.
 *
 * That property is deliberately given up. Once notifications are on, the
 * thing worth demonstrating is a message arriving — a guardian consent
 * request landing in an inbox, opened, answered. A domain that cannot receive
 * mail cannot show that, and a demonstration that stops at "and then an email
 * would be sent" is asking somebody to take the most important part on trust.
 *
 * So fixtures live on a domain Blue Leaf Labs owns and can point a catch-all
 * at. Two things replace what `.invalid` was doing:
 *
 * 1. **The local part is namespaced.** Every address is
 *    `{tenant}.{handle}@`, so `demo.student.a@scipath.org` is not a shape a
 *    person's real mailbox takes. Collision was the specific risk of moving
 *    to an apex domain, and the dot is what answers it.
 *
 * 2. **Sending to them is off unless somebody turns it on.**
 *    `src/lib/notify/transport.ts` refuses this domain by default and takes
 *    `MAIL_FIXTURES=send` as the deliberate act that permits it. So the
 *    default is still that fixture mail cannot leave, and demonstrating the
 *    flow is one variable rather than an edit.
 *
 * `.invalid` stays refused unconditionally beside it, so a fixture written
 * before this move cannot become mailable.
 */

/**
 * The domain every fixture person is addressed on.
 *
 * Real, and receivable behind a catch-all. Read by the seed, by `/demo/`, and
 * by the refusal in the transport — one constant, because it had six copies
 * and a rename would have moved the addresses while leaving the guard naming
 * a domain nothing uses.
 */
export const FIXTURE_DOMAIN = 'scipath.org';

/**
 * What the seed sets, unless `DEMO_PASSWORD` says otherwise.
 *
 * The exclamation mark is not decoration: it takes the fixture password past
 * the symbol requirement several password policies impose, and a
 * demonstration that fails its own sign-in is one that stops in the first
 * thirty seconds.
 */
export const DEFAULT_PASSWORD = 'scipath!';

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
