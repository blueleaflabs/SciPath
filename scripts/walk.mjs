#!/usr/bin/env node
/**
 * EVERY WORKFLOW, WALKED (2.9).
 *
 * `shots` shows what each page looks like. This shows what the pages *do*,
 * in the order people do them: a student writes and submits, an Elder
 * answers the question and gives the feedback, the other Elder sees it
 * was handled, the student sees the score and adds to the notebook, the
 * showcase assembles, the teacher scores and looks at the class, the
 * exports open. One scenario per file in `tests/walk/`, each a list of
 * steps; each step may take a picture and may expect something of the
 * page. The pictures go to `local-data/walk/<scenario>/NN-<name>.png`,
 * and `local-data/walk/report.md` says which expectations held.
 *
 *   npm run walk -- --student s@x --elder e@x --elder2 e2@x --teacher t@x --password 'phrase'
 *   npm run walk -- ... --base https://montavista.scipath.org --only student-writes
 *
 * Against a freshly loaded pilot (`reset` then `pilot:load`), so the
 * walk starts from the same place each time: the scenarios write, and a
 * second run on the same data finds a document already submitted. The
 * report says which expectations failed; the pictures say why.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadDevVars } from './dev-vars.mjs';
import { openBrowser, wait } from './browser.mjs';

loadDevVars();

const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

const base = (opt('--base') ?? 'http://montavista.localhost:4321').replace(/\/$/, '');
const out = opt('--out') ?? 'local-data/walk';
const port = Number(opt('--port') ?? 9334);
const only = opt('--only');
const people = {
  student: opt('--student'),
  elder: opt('--elder'),
  elder2: opt('--elder2'),
  teacher: opt('--teacher'),
};
const password = opt('--password') ?? '';

function fail(m) { console.error(`\n  ${m}\n`); process.exit(1); }
if (!people.student || !people.elder || !people.teacher || !password) {
  fail('Name the accounts: --student, --elder, --elder2 (optional), --teacher, and --password.');
}

const tab = await openBrowser({ port, chrome: process.env.CHROME });
await tab.size(1280, false);
console.log(`\nWalking ${base}, pictures into ${out}/ (${tab.chrome})`);

/* ── The step vocabulary a scenario writes in ─────────────────────────── */

const report = { base, at: new Date().toISOString(), scenarios: [] };
let current = null;   // the scenario being run
let stepNo = 0;
const vars = {};      // values read off pages, shared across scenarios

const fill = (s) => String(s).replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));

const t = {
  vars,
  /** Sign in as one of the named people (student, elder, elder2, teacher). */
  async as(who) {
    const email = people[who];
    if (!email) throw new Error(`no account for ${who}`);
    await tab.signOut();
    const { ok, where } = await tab.signIn(base, email, password);
    /* Both halves have to be true: the form was there to fill (nobody was
       still signed in) and the page after it is the Workbench. The first
       walk missed the first half and ran the teacher's scenario as the
       student who had not been signed out. */
    if (ok !== 'submitted') throw new Error(`sign-in as ${who}: ${ok}`);
    if (!where.startsWith('/app')) throw new Error(`sign-in as ${who} landed on ${where}`);
    const me = await tab.evaluate(`(document.querySelector('.mnav-me')?.textContent || '').trim()`);
    current.log.push(`as ${who} (${email}) → ${me}`);
  },
  async go(p) { await tab.go(`${base}${fill(p)}`); current.log.push(`go ${fill(p)}`); },
  /** Run JavaScript on the page and return its value. */
  async eval(expr) { return tab.evaluate(fill(expr)); },
  /** Click the first element matching a selector, or the first link/button whose text contains `text`. */
  async click(selector, { text = null, nav = true } = {}) {
    const loaded = nav ? tab.nextLoad(8000) : null;
    const hit = await tab.evaluate(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(fill(selector))})];
      const el = ${text === null ? 'els[0]' : `els.find((e) => (e.textContent || '').trim().includes(${JSON.stringify(fill(text))}))`};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return (el.textContent || '').trim().slice(0, 60);
    })()`);
    if (hit === null) throw new Error(`nothing to click: ${selector}${text ? ` "${text}"` : ''}`);
    if (nav) await loaded;
    await wait(nav ? 700 : 300);
    current.log.push(`click ${selector}${text ? ` "${text}"` : ''} → "${hit}"`);
  },
  /**
   * Put a value in a form control (textarea, input, select) and fire
   * input/change. A textarea behind the Markdown editor is written through
   * its surface: the editor re-reads the surface into the textarea on
   * every submit, so a value set on the textarea alone is gone by the
   * time the form goes.
   */
  async set(selector, value) {
    const ok = await tab.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(fill(selector))});
      if (!el) return false;
      const v = ${JSON.stringify(fill(String(value)))};
      const edit = el.tagName === 'TEXTAREA' ? el.closest('[data-md-editor]')?.querySelector('.mdx-edit') : null;
      if (edit) {
        edit.innerHTML = '';
        const p = document.createElement('p'); p.textContent = v; edit.appendChild(p);
        edit.dispatchEvent(new Event('input', { bubbles: true }));
        if (!el.value) el.value = v;
      } else {
        el.value = v;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error(`nothing to set: ${selector}`);
    current.log.push(`set ${selector}`);
  },
  /** Check a radio or checkbox. */
  async check(selector) {
    const ok = await tab.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(fill(selector))}); if (!el) return false; el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    if (!ok) throw new Error(`nothing to check: ${selector}`);
    current.log.push(`check ${selector}`);
  },
  /**
   * Submit the form that contains the selector (or the form itself), then
   * wait for the page. A disabled submit button is a refusal, as it is
   * for a person: the walk does not go round it.
   */
  async submit(selector) {
    const loaded = tab.nextLoad(10000);
    const ok = await tab.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(fill(selector))});
      if (!el) return 'missing';
      if (el.matches('button, input[type=submit]') && el.disabled) return 'disabled';
      const f = el.tagName === 'FORM' ? el : el.form || el.closest('form');
      if (!f) return 'missing';
      if (el.matches('button, input[type=submit]') && f.requestSubmit) f.requestSubmit(el);
      else if (f.requestSubmit) f.requestSubmit(); else f.submit();
      return 'sent';
    })()`);
    if (ok === 'missing') throw new Error(`nothing to submit: ${selector}`);
    if (ok === 'disabled') throw new Error(`the submit is disabled: ${selector}`);
    await loaded;
    await wait(700);
    current.log.push(`submit ${selector}`);
  },
  /** Read a value off the page into a variable: an attribute, or the text. */
  async read(name, selector, attr = null) {
    const v = await tab.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(fill(selector))}); if (!el) return null; return ${attr ? `el.getAttribute(${JSON.stringify(attr)})` : '(el.textContent || "").trim()'}; })()`);
    if (v === null) throw new Error(`nothing to read: ${selector}`);
    vars[name] = v;
    current.log.push(`read ${name} = ${JSON.stringify(v).slice(0, 80)}`);
    return v;
  },
  /** Read the first href matching a pattern into a variable. */
  async readHref(name, pattern) {
    const v = await tab.evaluate(`(() => { const re = new RegExp(${JSON.stringify(pattern)}); const a = [...document.querySelectorAll('a[href]')].find((x) => re.test(x.getAttribute('href'))); return a ? a.getAttribute('href') : null; })()`);
    if (v === null) throw new Error(`no link matching ${pattern}`);
    vars[name] = v;
    current.log.push(`readHref ${name} = ${v}`);
    return v;
  },
  /**
   * Expect something of the page. `text`: the page's text contains it.
   * `selector`: an element exists (with `text`, contains it). `absent`:
   * the text is not on the page. Recorded, never thrown: the walk goes on
   * and the report says.
   */
  async expect(what, { text = null, selector = null, absent = null, not = false } = {}) {
    let ok;
    /* Case does not count: a pill says IN PROGRESS by its style, and the
       page's text is what a person reads, not what the source said. */
    /* Nor does the run of whitespace: two spans side by side read as one
       line to a person and as a line break to innerText. */
    const lc = (v) => JSON.stringify(fill(v).toLowerCase().replace(/\s+/g, ' '));
    const norm = '(s) => (s || "").toLowerCase().replace(/\\s+/g, " ")';
    if (selector) {
      ok = await tab.evaluate(`(() => { const norm = ${norm}; const els = [...document.querySelectorAll(${JSON.stringify(fill(selector))})]; return ${text === null ? 'els.length > 0' : `els.some((e) => norm(e.innerText || e.textContent).includes(${lc(text)}))`}; })()`);
    } else if (absent !== null) {
      ok = !(await tab.evaluate(`(${norm})(document.body.innerText).includes(${lc(absent)})`));
    } else {
      ok = await tab.evaluate(`(${norm})(document.body.innerText).includes(${lc(text ?? what)})`);
    }
    if (not) ok = !ok;
    current.checks.push({ step: stepNo, what: fill(what), ok });
    current.log.push(`${ok ? 'ok  ' : 'FAIL'} ${fill(what)}`);
    console.log(`     ${ok ? 'ok  ' : 'FAIL'} ${fill(what)}`);
    return ok;
  },
  /** Press keys on the page: a string of characters, or a named key (Enter, Escape, ArrowRight). */
  async key(keys) {
    const named = { Enter: 13, Escape: 27, ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38, Tab: 9 };
    const seq = named[keys] ? [keys] : [...keys];
    for (const k of seq) {
      if (named[k]) {
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: named[k] });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: named[k] });
      } else {
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, text: k });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k });
      }
      await wait(60);
    }
    current.log.push(`key ${keys}`);
  },
  /** Give focus to an element. */
  async focus(selector) {
    const ok = await tab.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(fill(selector))}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.focus(); return document.activeElement === el; })()`);
    if (!ok) throw new Error(`could not focus: ${selector}`);
    current.log.push(`focus ${selector}`);
  },
  /** Put a file on a file input: a small PNG made here, so nothing is needed on disk. */
  async upload(selector, name = 'walk.png') {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const file = path.join(out, name);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(file, png);
    const { root } = await tab.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await tab.send('DOM.querySelector', { nodeId: root.nodeId, selector: fill(selector) });
    if (!nodeId) throw new Error(`no file input: ${selector}`);
    await tab.send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(file)] });
    current.log.push(`upload ${selector} ← ${name}`);
  },
  /** The browser's Back button. */
  async back() {
    const loaded = tab.nextLoad(8000);
    await tab.evaluate('history.back()');
    await Promise.race([loaded, wait(2500)]);
    await wait(900);
    current.log.push('back');
  },
  /** Wait up to `ms` for a selector to appear; true if it did. */
  async waitFor(selector, ms = 10000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await tab.evaluate(`Boolean(document.querySelector(${JSON.stringify(fill(selector))}))`)) return true;
      await wait(300);
    }
    return false;
  },
  /** A picture of the page as it stands, numbered in order. */
  async shot(name) {
    stepNo += 1;
    const file = path.join(out, current.name, `${String(stepNo).padStart(2, '0')}-${name}.png`);
    await tab.shot(file, 1280, 4000);
    current.shots.push(file);
    console.log(`  ${String(stepNo).padStart(2, '0')}  ${name}`);
  },
  wait,
  /** Fill every required box a student may write on the open document, from a page of sample text. */
  async fillRequired(sample) {
    const filled = await tab.evaluate(`(() => {
      const done = [];
      for (const wrap of document.querySelectorAll('.field[data-required="1"][data-writable="1"]')) {
        const kind = wrap.dataset.kind; const id = wrap.dataset.field;
        if (kind === 'long' || kind === 'text') {
          const ta = wrap.querySelector('textarea, input.in');
          if (ta) {
            const v = ${JSON.stringify(sample)} + ' (' + id + ')';
            const edit = ta.closest('[data-md-editor]')?.querySelector('.mdx-edit');
            if (edit) { edit.innerHTML = ''; const p = document.createElement('p'); p.textContent = v; edit.appendChild(p); edit.dispatchEvent(new Event('input', { bubbles: true })); }
            if (!ta.value) ta.value = v;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            done.push(id);
          }
        }
        else if (kind === 'number') { const n = wrap.querySelector('input[type=number]'); if (n) { n.value = n.max && Number(n.max) < 3.5 ? n.max : '3.5'; done.push(id); } }
        else if (kind === 'choice') { const r = wrap.querySelector('input[type=radio]'); if (r) { r.checked = true; done.push(id); } }
        else if (kind === 'choices') { const c = wrap.querySelector('input[type=checkbox]'); if (c) { c.checked = true; done.push(id); } }
        else if (kind === 'rubric') { const seen = new Set(); for (const r of wrap.querySelectorAll('input[type=radio]')) { if (!seen.has(r.name)) { r.checked = true; seen.add(r.name); } } done.push(id); }
        else if (kind === 'date') { const d = wrap.querySelector('input[type=date]'); if (d) { d.value = new Date().toISOString().slice(0, 10); done.push(id); } }
        else if (kind === 'link') { const l = wrap.querySelector('input[type=url]'); if (l) { l.value = 'https://example.org/'; done.push(id); } }
      }
      return done;
    })()`);
    current.log.push(`fillRequired: ${filled.join(', ')}`);
    return filled;
  },
};

/* ── Run ──────────────────────────────────────────────────────────────── */

const dir = 'tests/walk';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
fs.mkdirSync(out, { recursive: true });

for (const f of files) {
  const name = f.replace(/^\d+-/, '').replace(/\.mjs$/, '');
  if (only && !name.includes(only)) continue;
  const mod = await import(path.resolve(dir, f));
  current = { name, checks: [], shots: [], log: [], error: null };
  stepNo = 0;
  console.log(`\n── ${name}`);
  try {
    if (mod.needs && mod.needs.some((k) => !people[k])) {
      console.log(`   skipped: needs --${mod.needs.find((k) => !people[k])}`);
      current.error = 'skipped';
    } else {
      await mod.run(t);
    }
  } catch (e) {
    current.error = e.message;
    console.log(`   stopped: ${e.message}`);
    try { await t.shot('stopped'); } catch {}
  }
  report.scenarios.push(current);
}

/* ── The report ───────────────────────────────────────────────────────── */

const lines = [`# Walk · ${base} · ${report.at}`, ''];
let failed = 0;
for (const sc of report.scenarios) {
  const bad = sc.checks.filter((c) => !c.ok).length;
  failed += bad + (sc.error && sc.error !== 'skipped' ? 1 : 0);
  lines.push(`## ${sc.name} — ${sc.error === 'skipped' ? 'skipped' : sc.error ? `stopped: ${sc.error}` : bad ? `${bad} failed` : 'all held'}`, '');
  for (const c of sc.checks) lines.push(`- ${c.ok ? 'ok' : '**FAIL**'} · step ${c.step} · ${c.what}`);
  lines.push('', '<details><summary>log</summary>', '', '```', ...sc.log, '```', '', '</details>', '');
}
fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n'));
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${report.scenarios.length} scenarios; ${failed} ${failed === 1 ? 'thing' : 'things'} to look at. Pictures and report in ${out}/.`);
process.exit(failed ? 1 : 0);
