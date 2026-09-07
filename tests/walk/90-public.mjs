/**
 * THE FRONT DOOR, SIGNED OUT: the home page, About, the public showcase,
 * the feedback form (which sends), the search, and that a guarded page
 * asks for a sign-in rather than showing anything.
 */
export const needs = [];

export async function run(t) {
  await t.go('/app/');
  await t.eval(`(() => { const f = document.querySelector('form[action="/auth/signout/"]'); if (f) f.submit(); })()`);
  await t.wait(1500);
  await t.go('/');
  await t.shot('home');
  await t.expect('the home page opens', { selector: 'h1' });
  await t.go('/about/');
  await t.shot('about');
  await t.go('/showcase/');
  await t.shot('public-showcase');
  await t.go('/search/?q=research');
  await t.shot('search');
  await t.go('/feedback/');
  await t.set('#fb-happened', 'Sent by the walk: the feedback form, signed out.');
  await t.submit('#fb-happened');
  await t.shot('feedback-sent');
  await t.expect('the feedback was recorded', { text: 'Thank you' });
  await t.go('/app/');
  await t.shot('signed-out-app');
  await t.expect('a guarded page asks for a sign-in', { text: 'Sign in' });
  await t.expect('and shows no work', { text: 'In my care', not: true });
}
