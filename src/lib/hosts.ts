/**
 * WHICH HOSTNAMES THIS DEPLOYMENT ANSWERS FOR (2.9).
 *
 * A tenant's label on the root domain, the root domain itself (with or
 * without www), a local name, or a platform preview host. Anything else
 * pointed at the Worker used to render the platform's front door under a
 * stranger's name; it is refused now, so an unknown host is not another
 * origin wearing the site's branding. Pure, so a test can read it without
 * the tenant registry behind it: the caller says which labels are tenants.
 */
export function hostIsKnown(hostname: string, rootDomain: string, isTenantLabel: (host: string) => boolean): boolean {
  const host = hostname.toLowerCase().split(':')[0];
  const root = rootDomain.toLowerCase().split(':')[0];
  if (host === root || host === `www.${root}`) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1') return true;
  if (host.endsWith('.workers.dev') || host.endsWith('.pages.dev')) return true;
  /* A tenant's label on any domain, as resolveOrg has always read it, so a
     build whose root domain is unset still answers for its tenants. */
  return isTenantLabel(host);
}
