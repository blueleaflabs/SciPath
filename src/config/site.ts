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
  /**
   * The footer's directory of links (Read, Use it, Who it is for, Trust,
   * About, the source code). Off for the contained IRPD pilot (September
   * 2026): every public link is a door somebody can wander through, and
   * the pilot wants none open. The directory itself stays in
   * `Footer.astro`, untouched, for the demonstrations that come after;
   * flipping this shows it again.
   */
  footerLinks: false,
  /**
   * Whether a student sees the family's score (the Elder's, out of 4) on
   * their own deliverables list. Off until the class approves showing it
   * (September 2026); the Elders and the teachers see and write it
   * regardless, on the project page and the tracker. Flip to show.
   */
  familyScoresToStudents: false,
  /**
   * Whether a student sees the teacher's grade and its feedback at all.
   * Off until the class decides (September 2026): the release controls
   * are off the Grade page, so nothing is released, and the policy on
   * `assessments` then returns nothing to a student; the Grades section
   * and the Workbench figure stay off as well. Flip to show, and to put
   * the release controls back.
   */
  gradesToStudents: false,
  /**
   * The project page's Linked documents section (a label and a URL kept
   * on the project). Off for the pilot (September 2026): every deliverable
   * now carries its own Google Drive link, so the loose list duplicated
   * them. The section and its form stay in the page; flip to show.
   */
  linkedDocuments: false,
  /**
   * The teacher's Workbench (2.9). On, the teacher lands on the same page
   * an Elder does — the plate, then the cards, arranged by Elder — and the
   * class page leaves the bar (it still answers at its address). Off, a
   * bare /app/ sends the teacher to the class page and the bar names it.
   * On for the pilot; the class page's reports are rebuilt against what
   * the Workbench turns out to lack.
   */
  teacherWorkbench: true,
  /**
   * The profile page, pared to the class's needs (2.9). On, it is the name,
   * the graduation year and the ORCID under the same cover block every
   * other page has; the email digest settings, the confirmations box, the
   * photo consent, the outbound link and the account-deletion link are off
   * the page (their routes and columns stay). Off, the page is the full
   * account page it was.
   */
  profileEssentials: true,
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

/**
 * One colour per discipline, fixed (dev-149; richer in dev-151). The same
 * subject is the same colour on the cover, on its topic page and on each
 * of its records, so a reader learns it without being told. Hue,
 * saturation and lightness of the mid-tone; the surfaces derive their
 * lighter and darker steps from it. Greens, yellows, blues, oranges and
 * browns, a violet and a teal — no red, which the interface keeps for
 * what is late or wrong. In the list's order; an unknown slug has none.
 */
const TONES: [number, number, number][] = [
  [228, 45, 74], // astronomy: periwinkle
  [138, 40, 70], // biology: leaf green
  [30, 70, 74],  // chemistry: orange
  [205, 55, 72], // computer science: sky blue
  [80, 45, 68],  // earth and climate: olive
  [28, 35, 58],  // engineering: brown
  [46, 70, 68],  // mathematics: gold
  [282, 35, 74], // neuroscience: violet
  [186, 45, 66], // physics: teal
  [58, 45, 72],  // social science: straw
];
export function disciplineTone(slug: string): { h: number; s: number; l: number } | null {
  const i = disciplines.findIndex((d) => d.slug === slug);
  if (i < 0) return null;
  const [h, s, l] = TONES[i];
  return { h, s, l };
}
/** The three custom properties a surface reads (`--hue`, `--sat`, `--lum`), or nothing. */
export function toneStyle(slug: string): string | undefined {
  const t = disciplineTone(slug);
  return t ? `--hue: ${t.h}; --sat: ${t.s}%; --lum: ${t.l}%` : undefined;
}
export function disciplineHue(slug: string): number | null {
  return disciplineTone(slug)?.h ?? null;
}
