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

export type ClubRole = 'student' | 'officer' | 'advisor';
export type Attachment = 'author' | 'officer';

export interface Standing {
  names: ClubRole[];
  isStudent: boolean;
  /** A club officer. Sees every project, assigns officers, manages their own. */
  isOfficer: boolean;
  /** The Teacher Club Advisor. One person. */
  isAdvisor: boolean;
  /** Either club role: sees every project at the school. */
  runsTheClub: boolean;
}

/**
 * Population is passed in because being a student is a fact about the person,
 * not a grant. An officer is a student who also runs the club, and gating the
 * student half of the interface on holding the `student` role meant an
 * officer could not enter a fair of their own — which is the wrong answer to
 * a question nobody asked.
 */
export function standing(
  roles: { role: string }[] = [],
  population?: string | null
): Standing {
  const names = roles
    .map((r) => r.role as ClubRole)
    .filter((r) => r === 'student' || r === 'officer' || r === 'advisor');

  const isOfficer = names.includes('officer');
  const isAdvisor = names.includes('advisor');

  return {
    names,
    isStudent: names.includes('student') || population === 'student',
    isOfficer,
    isAdvisor,
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

export const roleLabel: Record<ClubRole, string> = {
  student: 'Student',
  officer: 'Club officer',
  advisor: 'Teacher club advisor',
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
