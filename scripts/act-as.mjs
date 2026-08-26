/**
 * ACTING AS A PERSON, IN A SEED.
 *
 * Almost everything a seed writes goes straight into the table, and that
 * bypass is the point of a fixture (12.11a). A few writes must not, because
 * the thing that makes them correct is a check inside a SECURITY DEFINER
 * function: a fair result may only be recorded by an author or by somebody
 * running the club, and a record may only be allocated by an editor.
 *
 * Those functions read `auth.uid()`, and the secret key carries no subject.
 * The seed is therefore nobody, `auth.uid()` is null, and the function
 * raises `not authenticated` before it looks at anything. Verified against
 * the migration on an empty database rather than inferred.
 *
 * So a seed that wants to call one signs in the ordinary way and gets a
 * client with a real session on it. Fixtures carry passwords for exactly
 * this reason, and the payoff is that the seeded row was written by the same
 * function the screen calls, with the same checks, by somebody who could
 * actually have done it. A fixture in a state the interface cannot produce
 * teaches whoever clicks through it something untrue.
 *
 * **Only ever an invented person.** The guard used to be the target: local
 * stack or nothing. That was the same rule as everywhere else while fixtures
 * only existed on a laptop, and it stopped being right when the
 * demonstration tenant moved into the deployed project — `seed-scenarios`
 * reached the point of recording a fair result and refused, halfway through
 * a seed, having already written the projects.
 *
 * The target is the wrong thing to check here anyway. What matters is whose
 * session this is, and the answer is bounded by construction: a fixture's
 * address ends in `demo.invalid`, a reserved domain that cannot receive mail
 * and that no real person can hold. So this signs in as somebody invented or
 * it does not sign in, wherever the project is, and there is nothing to
 * forget.
 */

import { createClient } from '@supabase/supabase-js';
import { loadDevVars } from './dev-vars.mjs';
import { FIXTURE_DOMAIN as FIXTURE_HOST, DEFAULT_PASSWORD } from '../src/config/demo-accounts.mjs';

loadDevVars();

const URL = process.env.PUBLIC_SUPABASE_URL ?? '';
const PUBLISHABLE = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';
const PASSWORD = process.env.DEMO_PASSWORD ?? DEFAULT_PASSWORD;

/* The domain every fixture address carries. Reserved by RFC 6761: it resolves
   nowhere, so an account on it is invented whatever project it lives in. */
/* One home for this, in src/config/demo-accounts.mjs. Six files held
   their own copy and the seventh would have been the one that missed a
   rename. */
const FIXTURE_DOMAIN = FIXTURE_HOST;

/* One client per address. A scenario loop asks for the same officer nine
   times and nine sign-ins is nine round trips for one session. */
const sessions = new Map();

/**
 * A client holding a fixture's session.
 *
 * Throws rather than returning null on failure. A seed that carries on
 * without the session it asked for writes rows nobody authorised and reports
 * nothing, which is the failure this whole file exists to remove.
 */
export async function actingAs(email) {
  if (!email.endsWith(`@${FIXTURE_DOMAIN}`)) {
    throw new Error(
      `actingAs will only sign in as a fixture, and ${email} is not one.\n` +
        `Fixture addresses end in @${FIXTURE_DOMAIN}, which is a reserved\n` +
        'domain no real person can hold.'
    );
  }

  if (!PUBLISHABLE) {
    throw new Error(
      'PUBLIC_SUPABASE_PUBLISHABLE_KEY is missing, so nothing can sign in.\n' +
        'It normally comes from .dev.vars. `npx supabase start` prints it.'
    );
  }

  const held = sessions.get(email);
  if (held) return held;

  const client = createClient(URL, PUBLISHABLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });

  if (error) {
    throw new Error(
      `Could not sign in as ${email}: ${error.message}\n` +
        'Fixtures are created with a password by seed-demo.mjs, so this usually\n' +
        'means the accounts have not been seeded, or DEMO_PASSWORD disagrees\n' +
        'with the one they were made with.'
    );
  }

  sessions.set(email, client);
  return client;
}

/** Forget every session. Worth calling at the end of a long seed. */
export async function signOutAll() {
  for (const client of sessions.values()) await client.auth.signOut();
  sessions.clear();
}
