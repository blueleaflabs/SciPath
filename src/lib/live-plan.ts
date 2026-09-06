/**
 * WHEN THE BACKUP PULSE ASKS (2.8).
 *
 * Live updates come over a socket. The pulse is the backup for a browser
 * whose socket will not connect, and it is paced by the school's clock:
 * inside a class period it asks quickly (the class is in the room and a
 * reply should land while they are looking), and outside one it asks
 * once an hour, because a tab left open all evening is a tab nobody is
 * reading. Pure, so a test can hand it a clock; the same function runs
 * in the browser and on the server.
 */

import type { LivePlan } from '../config/org-shape';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The weekday and HH:MM of a moment, on the school's clock. */
export function localClock(at: Date, timezone: string): { day: string; hhmm: string } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const hour = get('hour') === '24' ? '00' : get('hour');
    return { day: get('weekday'), hhmm: `${hour}:${get('minute')}` };
  } catch {
    return { day: DAYS[at.getDay()], hhmm: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` };
  }
}

/** Whether the class is meeting at this moment. */
export function inClass(plan: LivePlan, at: Date, timezone: string): boolean {
  const { day, hhmm } = localClock(at, timezone);
  return plan.classPeriods.some((p) => p.days.includes(day) && hhmm >= p.from && hhmm < p.to);
}

/**
 * How long the backup waits before asking again, in milliseconds, or null
 * for "not until they touch the page". In class: quick while the person
 * has touched the page in the last two minutes, slower for the next
 * quarter hour, then asleep. Out of class: the off-hours interval, and no
 * faster however busy they are, since nobody else is writing.
 */
export function fallbackDelay(plan: LivePlan, idleMs: number, classNow: boolean): number | null {
  const ATTENTIVE = 2 * 60 * 1000, ASLEEP = 15 * 60 * 1000;
  if (!classNow) return idleMs < ASLEEP * 4 ? plan.fallback.offHours * 1000 : null;
  if (idleMs < ATTENTIVE) return plan.fallback.inClass * 1000;
  if (idleMs < ASLEEP) return plan.fallback.inClassIdle * 1000;
  return null;
}
