/**
 * Tests for the one video field.
 *
 * The addresses people paste are whatever the share button gave them, so the
 * parser has to take all of those shapes. And it has to refuse everything
 * else, because the result is rendered inside a frame on our page: an open
 * parser is an arbitrary page of somebody else's choosing embedded in ours.
 *
 * Run: npm run test:video
 */

import assert from 'node:assert/strict';
import { parseVideo } from '../src/lib/video.ts';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

test('the address the share button gives you', () => {
  assert.equal(parseVideo('https://youtu.be/Zl2a1Ehr4f0')?.id, 'Zl2a1Ehr4f0');
});

test('the address the browser bar gives you', () => {
  assert.equal(parseVideo('https://www.youtube.com/watch?v=Zl2a1Ehr4f0')?.id, 'Zl2a1Ehr4f0');
});

test('extra parameters do not become part of the id', () => {
  assert.equal(
    parseVideo('https://www.youtube.com/watch?v=Zl2a1Ehr4f0&t=42s&list=PLabc')?.id,
    'Zl2a1Ehr4f0'
  );
  assert.equal(parseVideo('https://youtu.be/Zl2a1Ehr4f0?t=42')?.id, 'Zl2a1Ehr4f0');
});

test('an embed address somebody copied out of an iframe', () => {
  assert.equal(parseVideo('https://www.youtube.com/embed/Zl2a1Ehr4f0')?.id, 'Zl2a1Ehr4f0');
});

test('vimeo, including the forms with a channel or an unlisted hash', () => {
  assert.equal(parseVideo('https://vimeo.com/76979871')?.id, '76979871');
  assert.equal(parseVideo('https://vimeo.com/channels/staffpicks/76979871')?.id, '76979871');
  assert.equal(parseVideo('https://player.vimeo.com/video/76979871')?.id, '76979871');
});

test('the embed goes to the privacy-preserving host', () => {
  assert.match(parseVideo('https://youtu.be/abc123')?.embed ?? '', /youtube-nocookie\.com/);
  assert.match(parseVideo('https://vimeo.com/12345')?.embed ?? '', /dnt=1/);
});

test('nothing else is accepted', () => {
  for (const url of [
    'https://example.com/video.mp4',
    'https://notyoutube.com/watch?v=abc',
    'https://youtube.com.evil.test/watch?v=abc',
    'javascript:alert(1)',
    'data:text/html,<script>',
    '/relative/path',
    '',
  ]) {
    assert.equal(parseVideo(url), null, url);
  }
});

test('http is refused even on a host we allow', () => {
  assert.equal(parseVideo('http://youtu.be/abc123'), null);
});

test('nonsense returns null rather than throwing', () => {
  assert.equal(parseVideo('not a url'), null);
  assert.equal(parseVideo(null), null);
  assert.equal(parseVideo(undefined), null);
});

test('a poster exists where the provider offers one without an API call', () => {
  assert.match(parseVideo('https://youtu.be/abc123')?.poster ?? '', /ytimg\.com/);
  /* Vimeo's needs a request we have said we will not make. */
  assert.equal(parseVideo('https://vimeo.com/12345')?.poster, null);
});

console.log(`${passed} video assertions passed.`);
