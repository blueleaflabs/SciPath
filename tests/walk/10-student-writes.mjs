/**
 * THE STUDENT WRITES, ASKS, SUBMITS.
 *
 * Parnavi opens her deliverables, starts the literature review, fills
 * every required box, saves, asks her Elder a question on the
 * introduction, and submits. The deadlines table then says Submitted and
 * the notebook has the line.
 */
export const needs = ['student'];

export async function run(t) {
  await t.as('student');
  await t.go('/app/');
  await t.readHref('deliverables', '^/app/project/[^/]+/in/[^/]+/$');
  t.vars.projectId = t.vars.deliverables.split('/')[3];
  t.vars.programId = t.vars.deliverables.split('/')[5];
  await t.go('${deliverables}');
  await t.read('title', '.cover h1, h1');
  await t.shot('deliverables-before');
  await t.expect('the literature review is on the deadlines', { text: 'Lit Review v2' });

  await t.readHref('doc', '/doc/literature_review/$');
  await t.go('${doc}');
  await t.shot('document-opened');
  await t.expect('the document says In Progress', { text: 'In Progress' });

  await t.fillRequired('Written by the walk, to see the whole path through.');
  await t.submit('#save-all');
  await t.shot('document-saved');
  await t.expect('the save was acknowledged', { text: 'Saved' });
  await t.expect('every required box is answered, so Submit is open', { selector: '#ds-submit:not([disabled])' });

  await t.click('#f-introduction details.tadd summary', { nav: false });
  await t.set('#f-introduction textarea[name="c:introduction"]', 'Is one paragraph enough for the introduction?');
  await t.click('#f-introduction [data-send=comment]', { nav: false });
  await t.wait(1500);
  await t.shot('question-asked');
  await t.expect('the question is on the field', { selector: '#f-introduction .tlist', text: 'Is one paragraph enough' });

  await t.submit('#ds-submit');
  await t.shot('submitted');
  await t.expect('the submission was acknowledged', { text: 'Submitted' });

  await t.go('${deliverables}');
  await t.shot('deliverables-after');
  await t.expect('the deadlines table shows the review submitted', { selector: '.phased', text: 'Submitted' });

  await t.go('/app/project/${projectId}/');
  await t.shot('notebook-after-submit');
  await t.expect('the notebook records the submission', { selector: '.entry', text: 'Lit Review' });
}
