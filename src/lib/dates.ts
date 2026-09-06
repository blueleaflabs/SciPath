/**
 * DATES ON SCREEN.
 *
 * Two kinds of value come out of this database and they must not be handled
 * the same way.
 *
 * A `date` column arrives as `2026-08-19` and has no time and no zone. Passed
 * to `new Date()` on its own it is read as midnight UTC, which renders as the
 * eighteenth for anybody west of Greenwich, so a deadline silently shows the
 * day before. Appending `T00:00:00` fixes it by forcing local time.
 *
 * A `timestamptz` arrives as `2026-08-19T00:00:00+00:00` and already carries
 * its zone. Appending `T00:00:00` to that produces a string with two times in
 * it, which is not a date at all, and the page prints "Invalid Date".
 *
 * Six pages had their own copy of the first case written inline. The first
 * timestamp to reach one of them broke it. This tells the two apart.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Local midnight for a bare date, and the value itself for a timestamp. */
export function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(DATE_ONLY.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export type DateStyle = 'long' | 'short' | 'numeric' | 'withTime';

const STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  long: { month: 'long', day: 'numeric', year: 'numeric' },
  short: { month: 'short', day: 'numeric', year: 'numeric' },
  numeric: { month: 'numeric', day: 'numeric', year: '2-digit' },
  withTime: {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  },
};

/**
 * The fallback is a parameter because the honest words differ: a fair with no
 * date is "to be announced", a milestone with none is a dash.
 */
export function formatDate(
  value: string | Date | null | undefined,
  style: DateStyle = 'long',
  fallback = '—',
  timezone?: string
): string {
  const date = toDate(value);
  if (!date) return fallback;
  /* A bare date was parsed as server-local midnight, so it must be printed
     server-local too or it steps back a day; only a real timestamp is
     moved into the school's zone. */
  const zoned = timezone && !(typeof value === 'string' && DATE_ONLY.test(value))
    ? { timeZone: timezone }
    : {};
  return style === 'withTime'
    ? date.toLocaleString('en-US', { ...STYLES.withTime, ...zoned })
    : date.toLocaleDateString('en-US', { ...STYLES[style], ...zoned });
}

/** Whole days from today. Negative is in the past. */
export function daysFrom(value: string | Date | null | undefined): number | null {
  const date = toDate(value);
  if (!date) return null;
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(date) - midnight(new Date())) / 86400000);
}

export function isPast(value: string | Date | null | undefined): boolean {
  const date = toDate(value);
  return date ? date.getTime() < Date.now() : false;
}

/**
 * When something arrived, as somebody would say it.
 *
 * "3 days" told an editor how long a submission had waited and not when it
 * landed, so two an hour apart on the same morning read identically, and
 * "today" hid the difference between nine o'clock and five minutes ago.
 *
 * Today gets a clock, because the hour is what distinguishes one from
 * another. Any other day gets its date, because by then the hour has stopped
 * mattering and what somebody wants is which day it was.
 *
 * **Today means the same calendar day**, not "within twenty-four hours".
 * `daysFrom` compares midnights, so something submitted at eleven last night
 * is yesterday at one this morning, which is what a person would say and
 * what a rolling window would get wrong.
 */
export function arrivedAt(value: string | Date | null | undefined): string {
  const days = daysFrom(value);
  if (days === null) return '';

  if (days !== 0) return formatDate(value, 'short');

  const at = toDate(value);
  return at
    ? `today, ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : 'today';
}

/**
 * TODAY, WHERE THE SCHOOL IS.
 *
 * The server runs in UTC. `new Date().toISOString().slice(0, 10)` is
 * therefore tomorrow's date for anybody in California from five in the
 * afternoon, and a student writing up an afternoon's work found the entry
 * dated the next day. A date default has to be taken in the tenant's own
 * zone, which every organization file declares.
 *
 * `en-CA` because its short form is `YYYY-MM-DD`, the shape a date input
 * and a `date` column both want, with no reassembly.
 */
export function todayIn(timezone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}
