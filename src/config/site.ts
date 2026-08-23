/**
 * PLATFORM CONFIG
 *
 * Everything about the software itself. Organization-specific values do
 * not belong here; they live on the organization record in orgs.ts.
 *
 * No component may contain the name of a school, a district, a fair, or
 * the operator. Every such string is read from here or from the org
 * record, so running this for a different organization is a config edit
 * rather than a search and replace.
 */

export const platform = {
  name: 'SciPath',
  /** Used where the software names itself under an org lockup. */
  lockupSuffix: 'on SciPath',
  tagline:
    'Free, open source software for planning, running, and publishing student science fair projects.',
  repoUrl: 'https://github.com/blueleaflabs/SciPath',
  license: 'MIT',
  /** The single permitted mention of the operator, rendered in the footer only. */
  operatorCredit: 'A project of Blue Leaf Labs, a registered 501(c)(3) nonprofit.',
} as const;

/*
 * There was a `siteUrl` constant here, `https://scipath.pages.dev`, and it
 * was the origin every canonical tag, citation URL and sitemap line was
 * built from. Two things were wrong with it. It named a host that is no
 * longer where this runs, and it was one origin for every tenant, so four
 * schools each declared the same canonical address for the same path.
 *
 * The deployment knows where it is. `originForOrg()` in `src/lib/deployment`
 * builds a tenant's address from `PUBLIC_ROOT_DOMAIN`, which is the one
 * value that differs between a laptop, a preview and production.
 */

/*
 * There were five lifecycle stages here, and they were a competition's
 * lifecycle imposed on everything. A design research course has different
 * ones and generic research has almost none, so phases come from whichever
 * program a project belongs to. `process-standard.yaml` is what somebody with
 * no program yet sees. 7.1.
 */

/**
 * Discipline taxonomy. Classified by the domain of the question, never by
 * the method, so machine learning is a keyword rather than a field.
 * An organization may override this on its record.
 */
export const disciplines = [
  { slug: 'astronomy-astrophysics', label: 'Astronomy and astrophysics' },
  { slug: 'biology-biomedicine', label: 'Biology and biomedicine' },
  { slug: 'chemistry-materials', label: 'Chemistry and materials' },
  { slug: 'computer-science', label: 'Computer science' },
  { slug: 'earth-climate', label: 'Earth and climate' },
  { slug: 'engineering-robotics', label: 'Engineering and robotics' },
  { slug: 'mathematics', label: 'Mathematics' },
  { slug: 'neuroscience', label: 'Neuroscience' },
  { slug: 'physics', label: 'Physics' },
  { slug: 'social-science', label: 'Social science' },
] as const;

export type DisciplineSlug = (typeof disciplines)[number]['slug'];

export function disciplineLabel(slug: string): string {
  return disciplines.find((d) => d.slug === slug)?.label ?? slug;
}
