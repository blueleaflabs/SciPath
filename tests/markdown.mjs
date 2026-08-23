/**
 * HOSTILE MARKDOWN.
 *
 * Everything a person writes and somebody else reads goes through one
 * renderer. A published record is the case that matters most: the author and
 * the reader are different people, the reader has no reason to distrust the
 * page, and until this test existed the published body was handed straight to
 * `marked.parse` while notebook entries were not.
 *
 * Each case below is a thing that must not reach the page as something a
 * browser will act on. They are written as inputs rather than as a list of
 * tags, because the point is that the escape happens before the parser and
 * therefore covers constructs nobody thought of.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/lib/notes.ts';

let passed = 0;
const check = (name, fn) =>
  test(name, () => {
    fn();
    passed += 1;
  });

/* What `marked` itself emits, with `breaks` and `gfm` on. Anything outside
   this set came from the source rather than from the parser. */
const FROM_MARKDOWN = new Set([
  'p', 'br', 'hr', 'em', 'strong', 'del', 'code', 'pre', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'a', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
]);

const hostile = [
  ['a script element', '<script>alert(1)</script>'],
  ['a script with attributes', '<script src="https://evil.example/x.js"></script>'],
  ['an image with an error handler', '<img src=x onerror=alert(1)>'],
  ['an svg with a handler', '<svg onload="alert(1)"><circle r="1"/></svg>'],
  ['an iframe', '<iframe src="https://evil.example/"></iframe>'],
  ['a form posting elsewhere', '<form action="https://evil.example/"><input name="a"></form>'],
  ['an anchor with a handler', '<a href="#" onclick="alert(1)">click</a>'],
  ['a style block', '<style>body{display:none}</style>'],
  ['a mixed-case script', '<ScRiPt>alert(1)</ScRiPt>'],
  ['an unclosed tag', '<script>alert(1)'],
  ['a comment hiding a tag', '<!-- --><script>alert(1)</script>'],
  ['a math element', '<math><mtext><script>alert(1)</script></mtext></math>'],
];

for (const [what, source] of hostile) {
  check(`${what} does not reach the page`, () => {
    const html = renderMarkdown(source);

    /* Every tag in the output, checked against what Markdown is allowed to
       produce — rather than a list of the dangerous ones, which is a list
       somebody has to keep complete.
    
       The first version of this asserted `\son[a-z]+=` was absent, and
       failed on `&lt;img src=x onerror=alert(1)&gt;`: the handler was
       harmless escaped text and the assertion could not tell text from an
       attribute. A test that cannot tell those apart would also have passed
       a renderer that emitted the tag. */
    const tags = [...html.matchAll(/<([a-z][a-z0-9]*)/gi)].map((m) => m[1].toLowerCase());
    const strays = [...new Set(tags)].filter((t) => !FROM_MARKDOWN.has(t));

    assert.deepEqual(strays, [], `these reached the page as elements`);

    /* And it is still readable. Escaping that swallowed the text would be a
       different bug: somebody writing about a script tag should see one. */
    assert.match(html, /&lt;/, 'the text was dropped rather than escaped');
  });
}

const urls = [
  ['javascript', '[click](javascript:alert(1))'],
  ['javascript with mixed case', '[click](JaVaScRiPt:alert(1))'],
  ['data html', '[click](data:text/html;base64,PHNjcmlwdD4=)'],
  ['vbscript', '[click](vbscript:msgbox(1))'],
  ['a data image', '![x](data:image/svg+xml;base64,PHN2Zz4=)'],
];

for (const [what, source] of urls) {
  check(`a ${what} URL is defused`, () => {
    const html = renderMarkdown(source);

    assert.doesNotMatch(html, /href="\s*javascript:/i);
    assert.doesNotMatch(html, /href="\s*data:/i);
    assert.doesNotMatch(html, /href="\s*vbscript:/i);
    assert.doesNotMatch(html, /src="\s*data:/i);
  });
}

check('ordinary Markdown still works', () => {
  /* A test that only proves nothing renders would pass on a function
     returning the empty string. */
  const html = renderMarkdown(
    '# A heading\n\nSome **bold** text and [a link](https://example.org/).\n\n- one\n- two'
  );

  assert.match(html, /<h1/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example\.org\/"/);
  assert.match(html, /<li>one<\/li>/);
});

check('a relative link and an anchor still work', () => {
  const html = renderMarkdown('[here](/showcase/) and [there](#section)');
  assert.match(html, /href="\/showcase\/"/);
  assert.match(html, /href="#section"/);
});

/* Printed after the runner has finished, not while it is queueing. The
   first version logged from the top level, which runs before any test body
   does, and reported zero. */
process.on('exit', () => {
  console.log(
    `\n${passed} markdown assertions passed. ${hostile.length + urls.length} hostile inputs.`
  );
});
