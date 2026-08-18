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

const fromVite =
  typeof import.meta !== 'undefined' ? (import.meta as any).env?.PUBLIC_ROOT_DOMAIN : undefined;
const fromNode =
  typeof process !== 'undefined' ? process.env?.PUBLIC_ROOT_DOMAIN : undefined;

export const rootDomain: string = fromVite ?? fromNode ?? 'localhost:4321';

/** Local names are not reachable over TLS; everything else is. */
export const secure: boolean = !(
  rootDomain.startsWith('localhost') || rootDomain.endsWith('.localhost')
);

/** The address of a tenant here: its label, on this deployment's domain. */
export function originFor(label: string): string {
  return `${secure ? 'https' : 'http'}://${label}.${rootDomain}`;
}

/** This deployment's own origin, for anything served at the apex. */
export function apexOrigin(): string {
  return `${secure ? 'https' : 'http'}://${rootDomain}`;
}
