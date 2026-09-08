/**
 * A CHROME, DRIVEN (2.9).
 *
 * The one thin DevTools client both `shots` (every page as a picture) and
 * `walk` (every workflow, step by step) use: find a Chrome, start it
 * headless on a throwaway profile, open one tab, and offer navigate,
 * evaluate, resize, screenshot, sign in and sign out. No browser download,
 * no test framework; Node's own WebSocket.
 *
 * Nothing here knows what a page is for. The scripts that import it do.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

/* The usual places, after whatever the caller names (CHROME=/path). */
const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter(Boolean);

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(m) { console.error(`\n  ${m}\n`); process.exit(1); }

/** Start a headless Chrome on `port`; returns the tab client, already open. */
export async function openBrowser({ port = 9333, width = 1280, height = 900, chrome: named = null } = {}) {
  const chrome = [named, ...CANDIDATES].filter(Boolean).find((c) => fs.existsSync(c));
  if (!chrome) fail('No Chrome found. Set CHROME=/path/to/chrome.');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'scipath-browser-'));
  const proc = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--disable-extensions',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill(); } catch {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });

  let list = null;
  for (let i = 0; i < 40 && !list; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) list = await r.json(); } catch {}
    if (!list) await wait(250);
  }
  if (!list) fail('Chrome did not answer on its debugging port.');
  const page = list.find((t) => t.type === 'page') ?? list[0];
  const tab = tabOn(page.webSocketDebuggerUrl);
  await tab.open();
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  await tab.send('Network.enable');
  tab.chrome = chrome;
  return tab;
}

/* One tab: request and reply matched by id, page events on the side. */
function tabOn(url) {
  const ws = new WebSocket(url);
  let n = 0;
  const waits = new Map();
  let events = [];
  const got = (m) => {
    if (m.id && waits.has(m.id)) { const { res, rej } = waits.get(m.id); waits.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const fn of events) fn(m);
  };
  const open = () => new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = rej; ws.onmessage = (e) => got(JSON.parse(e.data)); });
  const send = (method, params = {}) => { const id = ++n; return new Promise((res, rej) => { waits.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); }); };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluate failed');
    return r.result?.value;
  };
  /** Wait for the next load event, with a ceiling. */
  const nextLoad = (ceiling = 15000) => {
    const loaded = new Promise((res) => { const fn = (m) => { if (m.method === 'Page.loadEventFired') { events = events.filter((f) => f !== fn); res(); } }; events.push(fn); });
    return Promise.race([loaded, wait(ceiling)]);
  };
  const go = async (url2) => {
    const loaded = nextLoad();
    await send('Page.navigate', { url: url2 });
    await loaded;
    await wait(600);
  };
  const size = async (width, mobile) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile, screenWidth: width, screenHeight: 900 });
    await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 });
  };
  /** A full-page picture; returns the elements wider than the screen. */
  const shot = async (file, expectWidth, maxHeight = 6000) => {
    for (let i = 0; i < 5; i += 1) {
      const now = await evaluate('window.innerWidth');
      if (!expectWidth || now === expectWidth) break;
      await size(expectWidth, expectWidth < 800);
      await wait(400);
    }
    const h = await evaluate(`Math.min(document.documentElement.scrollHeight, ${maxHeight})`);
    const w = await evaluate('window.innerWidth');
    /* What runs past the screen and is not inside something that scrolls
       sideways on purpose (a wide table, the tab strip): those are the
       elements the page clips, and the only ones worth a look. */
    const over = await evaluate(`(() => {
      const vw = window.innerWidth; const out = [];
      const scrolls = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1 && getComputedStyle(el).position !== 'fixed' && !scrolls(el)) out.push(el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.') : '') + ' +' + Math.round(r.right - vw));
      }
      return out.slice(0, 6);
    })()`);
    const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
    return over;
  };
  /** Sign in with email and password on the sign-in page (fixture and rehearsal accounts). */
  const signIn = async (base, email, password) => {
    await go(`${base}/app/`);
    const ok = await evaluate(`(async () => {
      const f = document.querySelector('form[action*="password"], form:has(input[type=password])');
      if (!f) return 'no password form on ' + location.pathname;
      const e = f.querySelector('input[type=email], input[name=email]'); const p = f.querySelector('input[type=password]');
      if (!e || !p) return 'no email/password inputs';
      e.value = ${JSON.stringify(email)}; p.value = ${JSON.stringify(password)};
      f.submit(); return 'submitted';
    })()`);
    await wait(2500);
    const where = await evaluate('location.pathname + location.search');
    return { ok, where };
  };
  /** Sign out, and be sure of it: the sign-in page must be back before this returns. */
  const signOut = async () => {
    let had = await evaluate(`Boolean(document.querySelector('form[action="/auth/signout/"]'))`);
    /* A print page or an export has no masthead, so no sign-out form, and
       "no form" used to be read as "nobody signed in": the teacher's
       scenario then ran as the student the export had left behind. The
       Workbench always has the masthead; ask there before deciding. */
    if (!had) {
      const origin = await evaluate('location.origin');
      if (/^https?:/.test(String(origin))) { await go(`${origin}/app/`); had = await evaluate(`Boolean(document.querySelector('form[action="/auth/signout/"]'))`); }
    }
    if (!had) return;
    const loaded = nextLoad(8000);
    await evaluate(`(() => { const f = document.querySelector('form[action="/auth/signout/"]'); if (f) f.submit(); })()`);
    await loaded;
    await wait(500);
    for (let i = 0; i < 10; i += 1) {
      const gone = await evaluate(`!document.querySelector('form[action="/auth/signout/"]')`);
      if (gone) return;
      await wait(400);
    }
  };
  return { open, send, evaluate, go, nextLoad, size, shot, signIn, signOut };
}
