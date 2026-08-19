/**
 * TWO AXES, NOT ONE.
 *
 * The club has a standing fact about a person, and a set of attachments to
 * projects. Conflating them is what made assignment awkward.
 *
 *   IN THE CLUB
 *     student   runs their own projects
 *     officer   a student, several of them, each holding five or six projects
 *     advisor   the Teacher Club Advisor. One person, runs the club, decides
 *               which projects the school puts forward
 *
 *   ON A PROJECT
 *     author    does the work
 *     officer   manages it, comments, chases
 *
 * The Teacher Project Sponsor is neither. It is a fact about a project: a
 * named teacher, recorded by the student, who signs the fair's form and may
 * never sign in. If they do sign in, the email match is the grant.
 */

export type ClubRole = 'student' | 'officer' | 'advisor' | 'editor';
export type Attachment = 'author' | 'officer';

export interface Standing {
  names: ClubRole[];
  isStudent: boolean;
  /** A club officer. Sees every project, assigns officers, manages their own. */
  isOfficer: boolean;
  /** The Teacher Club Advisor. One person. */
  isAdvisor: boolean;
  /** Runs the editorial queue. The advisor always is one, because the advisor decides. */
  isEditor: boolean;
  /** Either club role: has a queue of projects to look after. */
  runsTheClub: boolean;
  /**
   * The programs these roles are held in, and whether any is held at the
   * school.
   *
   * **`scope_id` was fetched and then discarded here.** The middleware selects
   * it, this reduced the rows to a list of names, and every page downstream
   * asked *does this person run the club* — a question with no room in it for
   * *which club*. So a club officer's own page listed every project at the
   * school including the class's, with the class's Elder in the officer
   * column: work they cannot act on, under a heading saying it is theirs.
   *
   * `anywhere` is somebody whose role names no program, which is the widest
   * there is and fits everything. That is the right default for an advisor
   * and wrong for an officer of one club, and only the scope can tell them
   * apart.
   */
  scopes: string[];
  anywhere: boolean;
}

/**
 * Population is passed in because being a student is a fact about the person,
 * not a grant. An officer is a student who also runs the club, and gating the
 * student half of the interface on holding the `student` role meant an
 * officer could not enter a fair of their own — which is the wrong answer to
 * a question nobody asked.
 */
export function standing(
  roles: { role: string; scope_id?: string | null }[] = [],
  population?: string | null
): Standing {
  const names = roles
    .map((r) => r.role as ClubRole)
    .filter(
      (r) => r === 'student' || r === 'officer' || r === 'advisor' || r === 'editor'
    );

  const isOfficer = names.includes('officer');
  const isAdvisor = names.includes('advisor');

  /* Only the roles that carry responsibility for other people's projects.
     A `student` row is not scoped and would otherwise read as somebody who
     runs everything. */
  const running = roles.filter((r) => r.role === 'officer' || r.role === 'advisor');

  return {
    scopes: [...new Set(running.map((r) => r.scope_id).filter(Boolean) as string[])],
    anywhere: running.some((r) => !r.scope_id),
    names,
    isStudent: names.includes('student') || population === 'student',
    isOfficer,
    isAdvisor,
    isEditor: names.includes('editor') || isAdvisor,
    runsTheClub: isOfficer || isAdvisor,
  };
}

export function isAuthorOf(
  attachments: { role: string; users?: { id?: string } | null }[] = [],
  userId?: string
): boolean {
  if (!userId) return false;
  return attachments.some((a) => a.role === 'author' && a.users?.id === userId);
}

/**
 * The roles the advisor hands out.
 *
 * Advisor is absent deliberately: a teacher's standing comes from the school
 * rather than from this software, so it is set when the organization is
 * provisioned. A role that can appoint itself only has to be captured once.
 * Student is absent because it follows from the account rather than being
 * granted.
 */
export const GRANTABLE: ClubRole[] = ['officer', 'editor'];

export const roleLabel: Record<ClubRole, string> = {
  student: 'Student',
  officer: 'Club officer',
  advisor: 'Teacher club advisor',
  editor: 'Editor',
};

export const attachmentLabel: Record<string, string> = {
  author: 'Author',
  officer: 'Club officer',
};

export const selectionLabel: Record<string, string> = {
  candidate: 'Under consideration',
  selected: 'Selected',
  not_selected: 'Not selected',
  withdrawn: 'Withdrawn',
};
