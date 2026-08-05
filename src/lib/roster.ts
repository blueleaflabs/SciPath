/**
 * READING A ROSTER.
 *
 * A club starts with a spreadsheet, so this accepts one. Pure: text in, rows
 * and complaints out, no database and no clock.
 *
 * It is deliberately forgiving about shape and unforgiving about content. A
 * person pasting from Excel will have a header row or not, quoted fields or
 * not, a trailing blank line, and a column order they chose. None of that is
 * worth an error message. An address that is not an address is.
 */

export type RosterRole = 'officer' | 'editor';

export interface RosterRow {
  email: string;
  display_name: string | null;
  role: RosterRole;
  /** Which line of the file, so a complaint can point at it. */
  line: number;
}

export interface RosterProblem {
  line: number;
  text: string;
  reason: string;
}

export interface RosterParse {
  rows: RosterRow[];
  problems: RosterProblem[];
}

/** One line of CSV, respecting quotes, because names contain commas. */
export function splitLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (quoted) {
      if (char === '"') {
        /* A doubled quote inside a quoted field is one quote. */
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      out.push(field.trim());
      field = '';
    } else field += char;
  }

  out.push(field.trim());
  return out;
}

const ROLES: RosterRole[] = ['officer', 'editor'];

/** Looks like an address. Not a validator: the database and the person decide. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

const HEADER_WORDS = ['email', 'e-mail', 'address', 'role', 'name', 'display_name'];

/**
 * Column order is discovered rather than required, from a header row if there
 * is one and from the content if there is not. Insisting on an order means
 * telling somebody their spreadsheet is wrong when it is perfectly clear.
 */
export function parseRoster(text: string): RosterParse {
  const rows: RosterRow[] = [];
  const problems: RosterProblem[] = [];
  const lines = text.split(/\r?\n/);

  let emailAt: number | null = null;
  let roleAt: number | null = null;
  let nameAt: number | null = null;
  let start = 0;

  /* A header row is one whose cells are all words we recognize as headings
     and none of which is an address. */
  const first = lines.find((l) => l.trim() !== '');
  if (first) {
    const cells = splitLine(first).map((c) => c.toLowerCase());
    const isHeader =
      cells.length > 1 &&
      cells.every((c) => HEADER_WORDS.includes(c)) &&
      !cells.some(looksLikeEmail);

    if (isHeader) {
      emailAt = cells.findIndex((c) => ['email', 'e-mail', 'address'].includes(c));
      roleAt = cells.findIndex((c) => c === 'role');
      nameAt = cells.findIndex((c) => ['name', 'display_name'].includes(c));
      start = lines.indexOf(first) + 1;
    }
  }

  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;

    const cells = splitLine(raw);
    const line = i + 1;

    /* Without a header, find the address and the role wherever they are. */
    const email = (emailAt !== null && emailAt >= 0 ? cells[emailAt] : cells.find(looksLikeEmail)) ?? '';
    /* Without a header, a known role wherever it sits. Failing that, a
       single bare word that is not the address, so "advisor" can be refused
       by name rather than reported as a missing role, while "A Person" is
       still read as a name. */
    const roleGuess =
      roleAt !== null && roleAt >= 0
        ? cells[roleAt]
        : (cells.find((c) => ROLES.includes(c.toLowerCase() as RosterRole)) ??
           /* From the end, because a name comes before a role in every
              spreadsheet anybody has ever handed over. */
           [...cells].reverse().find(
             (c) => c !== email && c !== '' && !/\s/.test(c) && !looksLikeEmail(c)
           ));

    const role = (roleGuess ?? '').toLowerCase();
    const name =
      nameAt !== null && nameAt >= 0
        ? cells[nameAt]
        : cells.find((c) => c !== email && c.toLowerCase() !== role && c !== '');

    if (!looksLikeEmail(email)) {
      problems.push({ line, text: raw.trim(), reason: 'no email address on this line' });
      continue;
    }

    if (!ROLES.includes(role as RosterRole)) {
      problems.push({
        line,
        text: raw.trim(),
        reason: role ? `"${role}" is not a role you can give out` : 'no role on this line',
      });
      continue;
    }

    rows.push({
      email: email.toLowerCase(),
      display_name: name?.trim() || null,
      role: role as RosterRole,
      line,
    });
  }

  /* The same person and role twice is a copy and paste, not an instruction. */
  const seen = new Set<string>();
  const unique: RosterRow[] = [];
  for (const row of rows) {
    const key = `${row.email}:${row.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  return { rows: unique, problems };
}

export const ROSTER_EXAMPLE = `email,name,role
s.okonkwo@school.example,J. Okonkwo,editor
t.marchetti@student.school.example,T. Marchetti,officer
t.marchetti@student.school.example,T. Marchetti,editor`;
