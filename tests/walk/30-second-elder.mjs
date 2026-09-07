/**
 * THE OTHER ELDER SEES IT WAS HANDLED.
 *
 * Saanj shares the project. Her Workbench no longer carries the question,
 * says who answered it, and the tracker shows the same 3.5.
 */
export const needs = ['elder2'];

export async function run(t) {
  await t.as('elder2');
  await t.go('/app/');
  await t.shot('workbench');
  await t.expect('the answered question is named under the plate', { text: 'answered' });
  await t.expect('the question is no longer a row on her plate', { selector: '.plate', text: 'Question', not: true });
  await t.go('/app/program/${programId}/tracker/');
  await t.shot('tracker');
  await t.expect('the tracker carries the score for her too', { selector: 'td.c[data-col="literature_review"][data-score="3.5"]' });
}
