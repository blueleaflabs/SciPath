/**
 * THREE ROLES.
 *
 *   student  runs their own projects
 *   officer  runs the club, and is usually a student, usually the president
 *   mentor   is the teacher, and is also the sponsor
 *
 * The officer holding real authority while being a student is not an
 * oversight. In a school club the administrative work is done by students,
 * so the structure follows the club rather than an org chart.
 *
 * Sponsor is not a separate role. A teacher who has taken responsibility for
 * a project is that project's mentor, and attaching them is the approval.
 */

export type RoleName = 'student' | 'officer' | 'mentor';

export interface Standing {
  names: RoleName[];
  isStudent: boolean;
  isOfficer: boolean;
  isMentor: boolean;
  /** Sees other people's projects and may attach people to them. */
  runsTheClub: boolean;
}

export function standing(roles: { role: string }[] = []): Standing {
  const names = roles
    .map((r) => r.role as RoleName)
    .filter((r) => r === 'student' || r === 'officer' || r === 'mentor');

  const isOfficer = names.includes('officer');
  const isMentor = names.includes('mentor');

  return {
    names,
    isStudent: names.includes('student'),
    isOfficer,
    isMentor,
    runsTheClub: isOfficer || isMentor,
  };
}

export const roleLabel: Record<RoleName, string> = {
  student: 'Student',
  officer: 'Club officer',
  mentor: 'Club mentor',
};
