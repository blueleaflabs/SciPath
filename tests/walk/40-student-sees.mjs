/**
 * THE STUDENT SEES THE SCORE, WRITES THE NOTEBOOK, THE SHOWCASE BUILDS.
 */
export const needs = ['student'];

export async function run(t) {
  await t.as('student');
  await t.go('${deliverables}');
  await t.shot('deliverables-scored');
  await t.expect('the Elder score is shown on the review', { text: 'Elder score' });
  await t.expect('the rationale is shown', { text: 'sources well chosen' });

  await t.go('${doc}');
  await t.shot('document-with-reply');
  await t.expect('the reply reached the document', { text: 'One good paragraph' });

  await t.go('/app/project/${projectId}/');
  await t.set('form.notef textarea[name="body_md"]', 'Read three more papers on diagnosis delays; two are worth citing.');
  await t.submit('form.notef');
  await t.shot('notebook-entry-added');
  await t.expect('the entry is in the notebook', { selector: '.entry', text: 'three more papers' });

  await t.go('/app/project/${projectId}/showcase/');
  await t.shot('showcase-assembling');
  await t.expect('the review is a section of the showcase', { text: 'Lit Review' });
  await t.expect('what comes next is listed', { text: 'Coming next' });

  await t.go('/app/project/${projectId}/notebook/');
  await t.shot('export-notebook');
  await t.expect('the notebook export carries the entry', { text: 'three more papers' });

  await t.go('/app/project/${projectId}/documents/print/');
  await t.shot('export-deliverables');
  await t.expect('the deliverables export carries the review', { text: 'Written by the walk' });
}
