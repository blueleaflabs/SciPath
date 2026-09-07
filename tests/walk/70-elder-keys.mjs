/**
 * THE ELDER AT THE KEYBOARD.
 *
 * On the tracker's grid, keys into a cell of their family that is in and
 * unscored, presses a number, and the cell carries the score; ? opens the
 * keys; the three views answer g, a and s. Then a nudge is not offered on
 * a project that is not late.
 */
export const needs = ['elder'];

export async function run(t) {
  await t.as('elder');
  await t.go('/app/program/${programId}/tracker/');
  await t.click('.seg-b[data-view="grid"]', { nav: false });
  await t.shot('grid');
  await t.expect('the grid has a cell of my family that is in and unscored', { selector: 'td.c[data-w="1"][data-state="in"]' });
  await t.focus('td.c[data-w="1"][data-state="in"]');
  await t.read('cellSid', 'td.c[data-w="1"][data-state="in"]', 'data-sid');
  await t.read('cellCol', 'td.c[data-w="1"][data-state="in"]', 'data-col');
  await t.key('3');
  await t.wait(2000);
  await t.shot('scored-by-key');
  await t.expect('the cell carries the score pressed', { selector: 'td.c[data-sid="${cellSid}"][data-col="${cellCol}"][data-score="3"]' });
  await t.key('Escape');
  await t.key('?');
  await t.wait(300);
  await t.expect('? opens the keys', { selector: 'dialog#keys[open]' });
  await t.key('Escape');
  await t.key('a');
  await t.wait(300);
  await t.expect('a shows by assignment', { selector: '#view-assignment:not([hidden])' });
  await t.key('s');
  await t.wait(300);
  await t.expect('s shows by student', { selector: '#view-student:not([hidden])' });
  await t.shot('by-student');

  await t.go('/app/');
  await t.expect('no nudge is offered on a project that is not late', { selector: '.cc-nudge', not: true });
}
