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
import fs from 'node:fs';
import { parseVideo, posterFor } from '../src/lib/video.ts';

let passed = 0;
/**
 * Awaits, which the first version did not.
 *
 * `fn()` without `await` counts an async assertion as passed the moment it
 * starts, and a rejection surfaces later as an unhandled promise that
 * nothing is watching. Four assertions here were reporting success without
 * having run: breaking the code they check changed nothing.
 */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (e) {
    console.error(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
}

await test('the address the share button gives you', () => {
  assert.equal(parseVideo('https://youtu.be/Zl2a1Ehr4f0')?.id, 'Zl2a1Ehr4f0');
});

await test('the address the browser bar gives you', () => {
  assert.equal(parseVideo('https://www.youtube.com/watch?v=Zl2a1Ehr4f0')?.id, 'Zl2a1Ehr4f0');
});

await test('extra parameters do not become part of the id', () => {
  assert.equal(
    parseVideo('https://www.youtube.com/watch?v=Zl2a1Ehr4f0&t=42s&list=PLabc')?.id,
    'Zl2a1Ehr4f0'
  );
  assert.equal(parseVideo('https://youtu.be/Zl2a1Ehr4f0?t=42')?.id, 'Zl2a1Ehr4f0');
});

await test('an embed address somebody copied out of an iframe', () => {
  assert.equal(parseVideo('https://www.youtube.com/embed/Zl2a1Ehr4f0')?.id, 'Zl2a1Ehr4f0');
});

await test('vimeo, including the forms with a channel or an unlisted hash', () => {
  assert.equal(parseVideo('https://vimeo.com/76979871')?.id, '76979871');
  assert.equal(parseVideo('https://vimeo.com/channels/staffpicks/76979871')?.id, '76979871');
  assert.equal(parseVideo('https://player.vimeo.com/video/76979871')?.id, '76979871');
});

await test('the embed goes to the privacy-preserving host', () => {
  assert.match(parseVideo('https://youtu.be/abc123')?.embed ?? '', /youtube-nocookie\.com/);
  assert.match(parseVideo('https://vimeo.com/12345')?.embed ?? '', /dnt=1/);
});

await test('nothing else is accepted', () => {
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

await test('http is refused even on a host we allow', () => {
  assert.equal(parseVideo('http://youtu.be/abc123'), null);
});

await test('nonsense returns null rather than throwing', () => {
  assert.equal(parseVideo('not a url'), null);
  assert.equal(parseVideo(null), null);
  assert.equal(parseVideo(undefined), null);
});

await test('a poster exists where the provider offers one without an API call', () => {
  assert.match(parseVideo('https://youtu.be/abc123')?.poster ?? '', /ytimg\.com/);
  /* Vimeo's needs a request we have said we will not make. */
  assert.equal(parseVideo('https://vimeo.com/12345')?.poster, null);
});

/* ── The still, fetched once ─────────────────────────────────────────────── */

await test('a YouTube still needs no call', () => {
  const video = parseVideo('https://www.youtube.com/watch?v=o5mbqkXb6YA');
  assert.match(video.poster, /^https:\/\/i\.ytimg\.com\//);
});

await (async () => {
  const vimeo = parseVideo('https://vimeo.com/76979871');

  await test('a Vimeo still comes from its oEmbed answer', async () => {
    const url = await posterFor(vimeo, async () => ({
      ok: true,
      json: async () => ({ thumbnail_url: 'https://i.vimeocdn.com/video/1_640.jpg' }),
    }));
    assert.equal(url, 'https://i.vimeocdn.com/video/1_640.jpg');
  });

  await test('and only from Vimeo\u2019s own image host', async () => {
    /* An oEmbed answer is somebody else's JSON. A URL taken from it and put
       in an <img> is a request made on a reader's behalf to wherever it
       points. */
    const url = await posterFor(vimeo, async () => ({
      ok: true,
      json: async () => ({ thumbnail_url: 'https://tracker.test/pixel.jpg' }),
    }));
    assert.equal(url, null);
  });

  await test('nor over plain http', async () => {
    const url = await posterFor(vimeo, async () => ({
      ok: true,
      json: async () => ({ thumbnail_url: 'http://i.vimeocdn.com/video/1_640.jpg' }),
    }));
    assert.equal(url, null);
  });

  await test('a failed call is a missing still, not a failed publication', async () => {
    const url = await posterFor(vimeo, async () => {
      throw new Error('offline');
    });
    assert.equal(url, null);
  });
})();

await test('the still is stored with the record rather than pointed at', () => {
  /* Even a still on the host's own CDN is a request a reader's browser makes
     to that host, which is exactly what the facade exists to avoid. */
  const files = fs.readFileSync('src/lib/record-files.ts', 'utf8');
  assert.match(files, /videoPosterKey/);
  assert.match(files, /posterFor/);

  const detail = fs.readFileSync('src/components/RecordDetail.astro', 'utf8');
  assert.match(detail, /d\.videoPoster \?\? video\?\.poster/, 'the stored one should win');
});

console.log(`${passed} video assertions passed.`);
