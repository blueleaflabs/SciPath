/**
 * THE SENTENCE AFTER A SAVE.
 *
 * Recording something on the plate answers one question and raises the
 * next one at once: what now? The page comes back with the next row on
 * top, and the outcome line says the same thing in words, so somebody who
 * saved and looked at the notice rather than the bar is told where to
 * look. Read from the rows the way the plate reads them: the student's
 * own open obligations on this place, dated, not events, nearest first.
 */

import { formatDate } from './dates';

export async function nextUpNote(supabase: any, participationId: string, did = 'Submitted'): Promise<string> {
  const { data } = await supabase
    .from('entry_milestones')
    .select('name, due_on')
    .eq('participation_id', participationId)
    .eq('owner', 'student')
    .is('completed_on', null)
    .neq('kind', 'event')
    .not('due_on', 'is', null)
    .order('due_on', { ascending: true })
    .limit(1);

  const next = (data ?? [])[0];
  if (!next) return `${did}. Nothing else is on the calendar.`;
  return `${did}. Next up: ${next.name}, due ${formatDate(next.due_on, 'short')}.`;
}
