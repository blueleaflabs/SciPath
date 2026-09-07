/**
 * THE ELDER ANSWERS AND GIVES THE FEEDBACK.
 *
 * Rohan's Workbench shows the question and the task. Answer takes him
 * to the field with the reply box open; he replies, fills the rating and
 * the rationale, presses Give the feedback, and the tracker shows 3.5.
 */
export const needs = ['elder'];

export async function run(t) {
  await t.as('elder');
  await t.go('/app/');
  await t.shot('workbench-with-question');
  await t.expect('the question is on the plate', { text: 'Question' });
  await t.expect('the Elder task is on the plate', { text: 'Elder Feedback: Lit Review' });

  await t.click('a', { text: 'Answer' });
  await t.shot('landed-on-the-field');
  await t.expect('the reply box opened on arrival', { selector: '#f-introduction details.tadd[open]' });
  await t.set('#f-introduction textarea[name="c:introduction"]', 'One good paragraph is enough. Name the gap.');
  await t.click('#f-introduction [data-send=comment]', { nav: false });
  await t.wait(1500);
  await t.expect('the reply is in the thread', { selector: '#f-introduction .tlist', text: 'One good paragraph' });

  await t.check('input[name="f:elder_score"][value="3.5"]');
  await t.set('textarea[name="f:elder_rationale"]', 'Clear question, sources well chosen; the gap could be sharper.');
  const ready = await t.waitFor('#give-btn:not([disabled])', 12000);
  await t.shot('elder-part-filled');
  await t.expect('the Elder part autosaved', { text: 'Saved' });
  await t.expect('Give the feedback is ready within twelve seconds', { selector: ready ? '#give-btn:not([disabled])' : '#give-btn.never-ready' });

  await t.submit('#give-btn');
  await t.shot('feedback-given');
  await t.expect('the feedback was given', { text: 'Feedback given' });

  await t.go('/app/program/${programId}/tracker/');
  await t.shot('tracker-scored');
  await t.expect('the tracker carries the score', { selector: 'td.c[data-col="literature_review"][data-score="3.5"]' });

  await t.go('/app/');
  await t.shot('workbench-after');
  await t.expect('the task has left the plate', { absent: 'Yours to do: Elder Feedback: Lit Review' });
}
