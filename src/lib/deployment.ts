/**
 * WHERE THIS DEPLOYMENT LIVES.
 *
 * One value: `PUBLIC_ROOT_DOMAIN`, the domain tenants hang off.
 *
 *   development   localhost:4321   ->  http://montavista.localhost:4321
 *   production    scipath.org      ->  https://montavista.scipath.org
 *
 * A tenant stores only its label, so this is the other half of every address.
 * It was briefly three values in three committed YAML files: two of them were
 * derivable from the third, and a committed file describing a deployment is
 * configuration in source control, which is the thing we are trying not to
 * have. One variable, set on the deployment.
 *
 * The default is local. A fresh clone with nothing set behaves like a laptop
 * rather than like production, which is the safer way round to be wrong.
 */

/**
 * READ WHEN ASKED, NOT WHEN IMPORTED.
 *
 * `import.meta.env` is inlined at build time, so in the application this is a
 * constant either way. In a script it is not: an ES import is evaluated
 * before any statement in the file that imports it, so a module that captured
 * `process.env` at the top was read *before* `loadCloudVars()` ran, and the
 * value in `.cloud.vars` arrived too late to matter.
 *
 * That is how the cloud reset printed `http://demo.localhost:4321` while the
 * variable it needed sat correctly in the file two lines above the import —
 * and how a check on `process.env.PUBLIC_ROOT_DOMAIN` could pass in the same
 * run whose output was wrong, which is the shape of a fix that changes
 * nothing.
 *
 * A function that builds an address reads its configuration at the moment it
 * is asked for one. The Vite branch still wins where there is one, because a
 * built worker has no `.cloud.vars` and never will.
 */
function currentRootDomain(): string {
  const fromVite =
    typeof import.meta !== 'undefined' ? (import.meta as any).env?.PUBLIC_ROOT_DOMAIN : undefined;
  const fromNode =
    typeof process !== 'undefined' ? process.env?.PUBLIC_ROOT_DOMAIN : undefined;

  return fromVite ?? fromNode ?? 'localhost:4321';
}

/**
 * The domain as it stood when this module loaded.
 *
 * Kept for the application, where it is a build-time constant and reading it
 * once is right. Anything running in Node should call the functions below,
 * which ask again.
 */
export const rootDomain: string = currentRootDomain();

/** Local names are not reachable over TLS; everything else is. */
function isSecure(domain: string): boolean {
  return !(domain.startsWith('localhost') || domain.endsWith('.localhost'));
}

export const secure: boolean = isSecure(rootDomain);

/** The address of a tenant here: its label, on this deployment's domain. */
export function originFor(label: string): string {
  const domain = currentRootDomain();
  return `${isSecure(domain) ? 'https' : 'http'}://${label}.${domain}`;
}

/** This deployment's own origin, for anything served at the apex. */
export function apexOrigin(): string {
  const domain = currentRootDomain();
  return `${isSecure(domain) ? 'https' : 'http'}://${domain}`;
}

/**
 * The address of one tenant, from its record.
 *
 * The canonical tag used to be built from a constant in `src/config/site.ts`
 * that read `https://scipath.pages.dev`, which was wrong twice over. It named
 * a host the site no longer answers on, and it was one value for four
 * tenants: one school's `/about/` and another's declared the same canonical
 * URL, which tells a crawler they are the same page and asks it to drop one
 * of them.
 *
 * The deployment already knew the right answer. `astro.config.mjs` derives
 * `site` from `PUBLIC_ROOT_DOMAIN`, and the two functions above build a
 * tenant's origin from the same variable. This is the third caller of the
 * same fact rather than a fourth copy of it.
 */
export function originForOrg(org: {
  id: string;
  subdomain?: string;
  isPlatform?: boolean;
}): string {
  return org.isPlatform ? apexOrigin() : originFor(org.subdomain ?? org.id);
}
