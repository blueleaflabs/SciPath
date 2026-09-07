/**
 * THE TEACHER SCORES AND LOOKS AT THE CLASS.
 */
export const needs = ['teacher'];

export async function run(t) {
  await t.as('teacher');
  await t.go('/app/');
  await t.shot('class-overview');

  await t.go('${deliverables}');
  await t.shot('project-deadlines-as-teacher');
  await t.expect('the Elder score is on the row', { text: 'Elder score 3.5' });
  await t.expect('the teacher score is still to give', { text: 'Teacher score: not graded' });
  await t.set('details.grade input[name="score"]', '3.8');
  await t.set('details.grade textarea[name="feedback"]', 'Agree with the Elder; tighten the gap statement.');
  await t.submit('details.grade form.gform');
  await t.shot('teacher-scored');
  await t.expect('the teacher score is recorded', { text: 'Teacher score 3.8' });

  await t.go('/app/program/${programId}/tracker/');
  await t.shot('tracker-as-teacher');
  await t.expect('the tracker shows the class', { selector: 'td.c[data-col="literature_review"][data-score="3.5"]' });

  await t.go('/app/program/${programId}/grade/');
  await t.shot('grade-page');
  await t.expect('the grade page opens', { text: 'Elder score' });

  await t.go('/app/program/${programId}/class/');
  await t.shot('class-page');

  await t.go('/app/program/${programId}/showcase/');
  await t.shot('class-showcase');
  await t.expect('the project is on the class showcase', { text: '${title}' });

  await t.go('/app/live/');
  await t.shot('live-log');
}
