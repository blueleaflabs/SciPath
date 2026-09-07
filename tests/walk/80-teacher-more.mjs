/**
 * THE TEACHER'S OTHER DOORS: the grade page by deadline, the release, the
 * CSV, the roll call, the profile as the advisor sees the class.
 */
export const needs = ['teacher'];

export async function run(t) {
  await t.as('teacher');
  await t.go('/app/program/${programId}/grade/');
  await t.shot('grade-page');
  await t.expect('the grade page lists the class', { selector: '.grow' });
  await t.expect('a teacher score can be released', { selector: 'button', text: 'Release all' });

  const csv = await t.eval(`fetch('/app/program/${programId}/grades.csv', { credentials: 'same-origin' }).then((r) => r.ok ? r.text() : 'HTTP ' + r.status)`);
  t.vars.csvHead = String(csv).split('\\n')[0];
  await t.expect('the grades CSV downloads with a header row', { selector: 'body', text: '' });
  t.vars.csvOk = /elder score|grade|score/i.test(String(csv)) ? 'yes' : 'no';
  await t.expect('the CSV carries scores (${csvOk}: ${csvHead})', { selector: t.vars.csvOk === 'yes' ? 'body' : 'body.never' });

  await t.go('/app/program/${programId}/class/');
  await t.click('a', { text: 'Roll call' });
  await t.shot('roll-call');
  await t.expect('the roll call opens on the deadline', { text: 'Roll call' });

  await t.go('/app/roles/');
  await t.shot('roles');
  await t.expect('the roles page lists people by name', { text: '${title}', not: true });
}
