export const prerender = false;

/**
 * ONE ANSWER, OR ONE "NOT NOW" (dev-156).
 *
 * The survey card (src/components/SurveyCard.astro) posts here from
 * wherever it was shown — the document page after a submission or
 * feedback, the Workbench on a sampled load — and this route records the
 * event through `record_survey_event` and sends the person straight back
 * where they were. A form post, not JSON, so the card works with nothing
 * running in the browser; a 303 back to `back` so a refresh re-reads a
 * page instead of answering twice.
 *
 * A refusal from the database is logged and never shown: the work the
 * question was about is already done, and a red sentence about a survey
 * would be the one thing on the page that was about us rather than them.
 */

import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/supabase';
import { questionById, COMMENT_MAX, NUMBER_MAX } from '../../../config/survey';

/** Only a path of this site, and only inside the app. */
function backTo(raw: string): string {
  const path = raw.startsWith('/app/') && !raw.startsWith('//') && !raw.includes('\\') ? raw.replace(/[#?].*$/, '') : '/app/';
  return `${path}#outcome`;
}

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const session = (locals as any).session;
  const form = await request.formData();
  const back = backTo(String(form.get('back') ?? ''));
  const gone = new Response(null, { status: 303, headers: { Location: back } });
  if (!session) return new Response(null, { status: 303, headers: { Location: '/app/' } });

  const q = questionById(String(form.get('question') ?? ''));
  /* "Not now" is the one button that names its event; every other button
     on the card is an answer. */
  const event = String(form.get('event') ?? '') === 'dismissed' ? 'dismissed' : 'answered';
  if (!q) return gone;

  const answerRaw = Number(form.get('answer') ?? NaN);
  const answer = q.kind === 'scale' ? ((answerRaw === 1 || answerRaw === 2 || answerRaw === 3) ? answerRaw : null)
    : q.kind === 'number' ? (Number.isInteger(answerRaw) && answerRaw >= 0 && answerRaw <= NUMBER_MAX ? answerRaw : null)
    : null;
  const comment = String(form.get('comment') ?? '').trim().slice(0, COMMENT_MAX) || null;
  if (event === 'answered' && answer == null && !comment) return gone;

  const supabase = serverClient(request, cookies, (locals as any).runtime?.env);
  const { error } = await supabase.rpc('record_survey_event', {
    p_question_id: q.id,
    p_moment: q.moment,
    p_event: event,
    p_answer: event === 'answered' ? answer : null,
    p_comment: event === 'answered' ? comment : null,
    p_document_id: String(form.get('document_id') ?? '') || null,
  });
  if (error) console.error(JSON.stringify({ record_survey_event: error.message }));

  /* An answer earns a word; a "Not now" earns silence. */
  if (event !== 'answered') return gone;
  return new Response(null, { status: 303, headers: { Location: `${back.replace(/#outcome$/, '')}?m=${encodeURIComponent('Thank you.')}#outcome` } });
};
