/**
 * THE EDITOR, DRIVEN (2.9).
 *
 * The rich text surface is `contenteditable` plus commands, and the one
 * thing no static check can see is where the caret ends up. The bug this
 * was written for: Heading 1, a word, Enter, Heading 2 — the caret went
 * back to the end of the heading above and the new heading never took,
 * because the caret was remembered as one offset from the top and the
 * empty new line had the same offset as the end of the line before it.
 *
 * So the component's script is compiled as it is, mounted on the
 * component's own markup (tests/editor/page.html), and driven in a real
 * Chrome by keys and clicks. Skips cleanly when there is no Chrome, as the
 * database test skips without Postgres.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const CANDIDATES = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
const chrome = CANDIDATES.find((c) => fs.existsSync(c));
if (!chrome) { console.log('No Chrome found, so the editor test is skipped. Set CHROME=/path/to/chrome.'); process.exit(0); }

const src = fs.readFileSync('src/components/MarkdownEditor.astro', 'utf8');
const script = src.slice(src.indexOf('<script>') + 8, src.indexOf('</script>'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scipath-editor-'));
fs.writeFileSync(path.join(dir, 'editor.ts'), script);
execFileSync('npx', ['esbuild', path.join(dir, 'editor.ts'), '--bundle', '--format=iife', `--outfile=${path.join(dir, 'editor.js')}`, '--log-level=error'], { stdio: 'inherit' });
fs.copyFileSync('tests/editor/page.html', path.join(dir, 'page.html'));

const { openBrowser, wait } = await import('../scripts/browser.mjs');
const tab = await openBrowser({ port: 9455, chrome });
const type = async (text) => { for (const ch of text) await tab.send('Input.dispatchKeyEvent', { type: 'char', text: ch }); };
/* Enter carries its character, as a real key does: without `text` Chrome
   fires the event and does nothing to the surface, which hides exactly the
   list behaviour this is here to check. */
const press = async (key, code, vk) => { const text = key === 'Enter' ? '\r' : undefined; await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text, unmodifiedText: text }); await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk }); await wait(30); };
const click = (cmd) => tab.evaluate(`document.querySelector('[data-cmd=${cmd}]').click()`);
const html = () => tab.evaluate(`document.querySelector('.mdx-edit').innerHTML`);
const md = () => tab.evaluate(`document.querySelector('textarea').value`);

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed += 1; } catch (e) { console.error(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; } };

await tab.go(`file://${path.join(dir, 'page.html')}`);
await tab.evaluate(`document.querySelector('.mdx-edit').focus()`);

await test('Heading 1, a word, Enter, Heading 2: the second heading takes on its own line', async () => {
  await click('h1'); await type('Title'); await press('Enter', 'Enter', 13); await click('h2'); await type('Sub'); await wait(150);
  assert.equal(await html(), '<h1>Title</h1><h2>Sub</h2>');
  assert.equal(await md(), '# Title\n\n## Sub');
});

await test('a heading chosen with the caret at the start of a line stays on that line', async () => {
  await tab.evaluate(`(() => { const e = document.querySelector('.mdx-edit'); e.innerHTML = '<h1>Title</h1><p>Body text</p>'; const s = getSelection(); const r = document.createRange(); r.setStart(e.lastChild.firstChild, 0); r.collapse(true); s.removeAllRanges(); s.addRange(r); })()`);
  await click('h2'); await type('X'); await wait(100);
  assert.equal(await html(), '<h1>Title</h1><h2>XBody text</h2>');
});

await test('a list under a heading, Enter out of it, then Heading 3: the heading takes on its own line', async () => {
  /* The second report: the list Chrome makes on an empty line sits inside
     the paragraph, every line after it is a line inside a paragraph, and
     Heading 3 sent the caret back to the end of the last item. */
  await tab.evaluate(`(() => { const e = document.querySelector('.mdx-edit'); e.innerHTML = ''; e.focus(); })()`);
  await click('h1'); await type('Title'); await press('Enter', 'Enter', 13);
  await click('h2'); await type('Sub'); await press('Enter', 'Enter', 13);
  await click('ul'); await type('one'); await press('Enter', 'Enter', 13); await type('two'); await press('Enter', 'Enter', 13);
  await press('Enter', 'Enter', 13);
  await click('h3'); await type('Third'); await wait(150);
  assert.equal(await html(), '<h1>Title</h1><h2>Sub</h2><ul><li>one</li><li>two</li></ul><h3>Third</h3>');
  assert.equal(await md(), '# Title\n\n## Sub\n\n- one\n- two\n\n### Third');
});

if (process.exitCode) console.error(`\n${passed} passed, with failures.`);
else console.log(`${passed} editor assertions passed.`);
process.exit(process.exitCode ?? 0);
