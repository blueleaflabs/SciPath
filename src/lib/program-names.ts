/**
 * WHAT TO CALL A PROGRAM, IN FRONT OF A STUDENT.
 *
 * A program is an edition, so most names already end in their year: "Monta
 * Vista Research Club, 2027". Appending the season produced "2027 2027" on
 * two pages before anybody noticed, which is what happens when the same small
 * decision is made twice.
 */

export interface NamedProgram {
  name?: string | null;
  season_year?: number | null;
  kind?: string | null;
  /**
   * What this program calls its people, resolved from its template and
   * stored on the row. Optional because a page may select the row without
   * asking for it, and because a row written before the column existed has
   * an empty object in it.
   */
  roles?: {
    staff?: { singular?: string | null; plural?: string | null } | null;
    member?: { singular?: string | null; plural?: string | null } | null;
  } | null;
}

/** The name, with the season only where the name does not already carry it. */
export function programTitle(program: NamedProgram | null | undefined): string {
  const name = program?.name ?? '';
  const season = program?.season_year;

  if (!season || name.includes(String(season))) return name;
  return `${name} ${season}`;
}

/**
 * What kind of thing it is, in one word.
 *
 * "Fair" is wrong for a research class and "program" is our word rather than
 * a student's. One word per card does the explaining that a section heading
 * cannot do for a mixed list.
 */
export function programKind(program: NamedProgram | null | undefined): string {
  switch (program?.kind) {
    case 'course':
      return 'Class';
    case 'publication':
      return 'Journal';
    case 'grant':
      return 'Grant';
    case 'independent':
      return 'Independent';
    default:
      return 'Fair';
  }
}

/**
 * What a student is doing in it.
 *
 * You enter a fair and you are enrolled in a class, and using the wrong verb
 * in front of a class makes the software feel like it was built for something
 * else — which it was, until IRPD existed.
 */
export function participationVerb(program: NamedProgram | null | undefined): {
  noun: string;
  entered: string;
} {
  if (program?.kind === 'course') {
    return { noun: 'your project', entered: 'You are already in this class.' };
  }
  if (program?.kind === 'grant') {
    return { noun: 'your application', entered: 'You have already applied.' };
  }
  return { noun: 'your entry', entered: 'You are already entered in this fair.' };
}

/* ── What a program calls its people ──────────────────────────────────────
 *
 * A club has officers, a class has elders, a journal has editors, and a
 * grant has reviewers. They hold exactly the same powers: the template
 * supplies display names and never a second permission vocabulary, because
 * two vocabularies for one set of powers is how an access model stops being
 * auditable (6.4). The database role is `officer` in every one of them.
 *
 * The words come off `programs.roles`, resolved from the template when the
 * program was seeded, for the reason `phases` sits there too: nine screens
 * need them and only two have another reason to load the template library.
 * Every one of those screens already selects this row.
 *
 * The fallback is the resolver's own default, so a row written before the
 * column existed reads as Officer and Student rather than as blank.
 */

const FALLBACK = {
  staff: { singular: 'Officer', plural: 'Officers' },
  member: { singular: 'Student', plural: 'Students' },
};

/** What this program calls the person looking after a project. */
export function staffWord(
  program: NamedProgram | null | undefined,
  form: 'singular' | 'plural' = 'singular'
): string {
  return program?.roles?.staff?.[form] || FALLBACK.staff[form];
}

/** What this program calls the person doing the work. */
export function memberWord(
  program: NamedProgram | null | undefined,
  form: 'singular' | 'plural' = 'singular'
): string {
  return program?.roles?.member?.[form] || FALLBACK.member[form];
}

/**
 * The same word where a screen spans more than one program.
 *
 * A project may take part in the club and the class at once, and the person
 * looking after it is attached to the project rather than to either one, so
 * there is a real tension here: the attachment is project level and the
 * vocabulary is program level. Until somebody decides what a project in two
 * programs should call that person, this answers honestly and says nothing
 * when the programs disagree.
 *
 * Returns the shared word, or **null** when they differ. Null rather than a
 * neutral word of its own, because a column header wants a phrase and a
 * sentence wants a noun, and one string cannot be both: "No looked after by
 * assigned" is what happens when it tries.
 */
export function sharedStaffWord(
  programs: (NamedProgram | null | undefined)[],
  form: 'singular' | 'plural' = 'singular'
): string | null {
  const words = new Set(programs.filter(Boolean).map((p) => staffWord(p, form)));
  return words.size === 1 ? [...words][0] : null;
}
