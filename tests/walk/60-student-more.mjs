/**
 * THE STUDENT'S OTHER DOORS.
 *
 * Renames the project and sees the new name on the cover; adds a notebook
 * entry with a picture; keeps an earlier draft and brings it back with
 * Use this; the Back button after opening a document shows the row as
 * Continue, not Start; the showcase card takes a summary and can be hidden
 * and shown; the profile takes a new name that reaches the masthead and
 * is put back.
 */
export const needs = ['student'];

export async function run(t) {
  await t.as('student');
  await t.go('/app/');
  await t.readHref('deliverables', '^/app/project/[^/]+/in/[^/]+/$');
  t.vars.projectId = t.vars.deliverables.split('/')[3];
  t.vars.programId = t.vars.deliverables.split('/')[5];
  await t.read('title', '.cover h1, h1');

  /* Rename, and put it back. */
  await t.go('/app/project/${projectId}/');
  await t.click('details.rename summary', { nav: false });
  await t.set('form.renamef input[name="title"]', '${title} - renamed');
  await t.submit('form.renamef');
  await t.shot('renamed');
  await t.expect('the cover carries the new name', { selector: 'h1', text: '- renamed' });
  await t.click('details.rename summary', { nav: false });
  await t.set('form.renamef input[name="title"]', '${title}');
  await t.submit('form.renamef');
  await t.expect('and the old one again', { selector: 'h1', text: '${title}' });

  /* A notebook entry with a picture. */
  await t.set('form.notef textarea[name="body_md"]', 'Measured the first three samples; photo of the setup attached.');
  await t.upload('form.notef input[type=file]', 'setup.png');
  await t.set('form.notef input[name="caption"]', 'The setup on the bench');
  await t.submit('form.notef');
  await t.shot('notebook-with-picture');
  await t.expect('the entry is in the notebook', { selector: '.entry', text: 'first three samples' });
  await t.expect('with its picture', { selector: '.entry img' });

  /* Drafts: two saves of one box, then the earlier one back. */
  await t.readHref('doc', '/doc/literature_review/$');
  await t.go('${doc}');
  await t.set('#f-proud textarea', 'First wording of what I am proud of.');
  await t.wait(2500);
  await t.set('#f-proud textarea', 'Second wording, which I like less.');
  await t.wait(2500);
  await t.go('${doc}');
  await t.shot('drafts-kept');
  await t.expect('the box offers an earlier draft', { selector: '#f-proud details.fdrafts' });
  await t.click('#f-proud details.fdrafts summary', { nav: false });
  await t.click('#f-proud .fdraft-use', { nav: false });
  await t.wait(2500);
  await t.expect('Use this put the first wording back', { selector: '#f-proud textarea', text: 'First wording' });

  /* Back after opening a document: the row says Continue. */
  await t.go('${deliverables}');
  await t.click('a.btn', { text: 'Continue' });
  await t.back();
  await t.shot('back-to-deliverables');
  await t.expect('the row is current after Back', { selector: '.phased', text: 'Continue' });

  /* The showcase card. */
  await t.go('/app/project/${projectId}/showcase/');
  await t.set('#summary', 'A study of how teens are diagnosed, told in their own words.');
  await t.submit('#summary');
  await t.shot('showcase-summary-saved');
  await t.expect('the summary was saved', { text: 'The class sees it now' });
  await t.click('button', { text: 'Hide it for now' });
  await t.expect('the card is hidden', { text: 'Hidden from the class' });
  await t.click('button', { text: 'Show it again' });
  await t.expect('and shown again', { text: 'Shown to the class' });
  await t.shot('showcase-shown');

  /* The profile: a new name reaches the masthead, then the old one back. */
  await t.go('/app/profile/');
  await t.read('name', 'input[name="display_name"]', 'value');
  await t.set('input[name="display_name"]', '${name} (walk)');
  await t.submit('input[name="display_name"]');
  await t.shot('profile-renamed');
  await t.expect('the masthead carries the new name', { selector: '.mnav-me', text: '(walk)' });
  await t.set('input[name="display_name"]', '${name}');
  await t.submit('input[name="display_name"]');
  await t.expect('and the old one again', { selector: '.mnav-me', text: '${name}' });
}
