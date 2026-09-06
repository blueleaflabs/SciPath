/**
 * THE CLASS'S GRAPHICS, DRAWN IN THE BROWSER (2.8).
 *
 * Two pictures the IRPD class asks for as handouts, drawn on a canvas from
 * what the student wrote on the document page, so the deliverable is made
 * here rather than in a slide tool and re-uploaded:
 *
 * - `summary`: the research graphic. The research question in a box at
 *   the top, an arrow down to the impact in an ellipse, two arrows down to
 *   the data to collect and the users to interview.
 * - `impact`: the impact and feasibility grid. Impact up and down,
 *   feasibility left and right, "PROJECT Analysis" at the crossing, the
 *   project idea marked in its quadrant, and the two sentences from the
 *   handout underneath.
 *
 * The words come in as the editor stored them (Markdown) and keep their
 * bold, their italic, their list numbers and their nesting; the faces are
 * the page's own. PNG rather than JPEG: text and flat color on white,
 * where PNG is smaller and stays sharp. Nothing here touches the network;
 * the page decides what to do with the picture.
 */

export type GraphicName = 'summary' | 'impact';

export interface GraphicInput {
  /** Field id to the field's text, Markdown as the editor stored it. */
  values: Record<string, string>;
  /** The author names, for the "Researcher's Name" line. */
  authors?: string;
}

/* The handout's own colors, as tokens (`--graphic-*` in tokens.css) read
   from the page, so the picture is not tied to whichever theme the page
   wears; the page's own faces (`--face-ed` for the writing, `--face-ui`
   for the labels), so the picture reads like the page it was written on. */
let FILL = 'rgb(207, 226, 243)';
let LINE = 'rgb(26, 26, 26)';
let INK = 'rgb(17, 17, 17)';
let PAPER = 'rgb(255, 255, 255)';
let FACE = 'Georgia, serif';
let FACE_UI = 'system-ui, sans-serif';

function readTokens() {
  if (typeof document === 'undefined') return;
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  FILL = get('--graphic-fill', FILL);
  LINE = get('--graphic-line', LINE);
  INK = get('--graphic-ink', INK);
  PAPER = get('--graphic-paper', PAPER);
  FACE = get('--face-ed', FACE);
  FACE_UI = get('--face-ui', FACE_UI);
}

/* ── The words, as the editor stored them ──────────────────────────────── */

/** A run of text with its weight; a line is runs; `indent` is the nesting. */
export interface Run { text: string; bold: boolean; italic: boolean }
export interface Line { runs: Run[]; indent: number }

const ESCAPED = '';

/**
 * Markdown to lines of runs: bold and italic kept, list markers kept
 * with their numbers counted per level, nesting kept as `indent`, links
 * reduced to their words, and the editor's escapes undone ("\2." at the
 * start of a line is "2.", not a list). Enough for a picture.
 */
export function toLines(md: string): Line[] {
  const lines: Line[] = [];
  const counters: number[] = [];
  for (const raw of String(md ?? '').replace(/\r/g, '').split('\n')) {
    let text = raw
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*>\s?/, '');
    if (!text.trim()) {
      if (lines.length && lines[lines.length - 1].runs.length) lines.push({ runs: [], indent: 0 });
      counters.length = 0;
      continue;
    }
    const lead = text.match(/^(\s*)/)![1].length;
    const indent = Math.floor(lead / 2);
    text = text.slice(lead);
    const bullet = text.match(/^([-+*])\s+/);
    const numbered = text.match(/^(\d+)[.)]\s+/);
    let marker = '';
    if (bullet) { text = text.slice(bullet[0].length); marker = '• '; counters.length = indent; }
    else if (numbered) {
      text = text.slice(numbered[0].length);
      counters.length = indent + 1;
      counters[indent] = (counters[indent] ?? 0) + 1;
      marker = `${counters[indent]}. `;
    } else counters.length = 0;
    /* The editor's escapes: the character after the backslash is meant. */
    text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>~0-9])/g, `${ESCAPED}$1`);
    const runs = inlineRuns(text).map((r) => ({ ...r, text: r.text.split(ESCAPED).join('') }));
    if (marker) runs.unshift({ text: marker, bold: false, italic: false });
    lines.push({ runs, indent });
  }
  while (lines.length && lines[lines.length - 1].runs.length === 0) lines.pop();
  return lines;
}

/** The words alone, one line each, nesting as leading spaces. */
export function plainText(md: string): string {
  return toLines(md).map((l) => ' '.repeat(l.indent * 2) + l.runs.map((r) => r.text).join('')).join('\n');
}

/* Bold and italic as the editor writes them: **, __, *, _. Strike and
   code marks are dropped, their words kept. An escaped mark (after the
   placeholder) is a character, not a mark. */
function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  let bold = false, italic = false, buf = '';
  const flush = () => { if (buf) runs.push({ text: buf, bold, italic }); buf = ''; };
  for (let i = 0; i < text.length; i++) {
    const one = text[i];
    if (one === ESCAPED) { buf += text[i + 1] ?? ''; i++; continue; }
    const two = text.slice(i, i + 2);
    if (two === '**' || two === '__') { flush(); bold = !bold; i++; continue; }
    if (two === '~~') { i++; continue; }
    if (one === '*' || one === '_') { flush(); italic = !italic; continue; }
    if (one === '`') continue;
    buf += one;
  }
  flush();
  return runs;
}

/* ── Laying the words out ──────────────────────────────────────────────── */

interface Word { text: string; bold: boolean; italic: boolean; glue?: boolean }
interface Laid { words: Word[]; indent: number; width: number }

function fontOf(size: number, bold: boolean, italic: boolean, face = FACE) {
  return `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${face}`;
}

/* Lines of runs into lines that fit `width` at `size`, word by word,
   each word keeping its weight. */
function layout(ctx: CanvasRenderingContext2D, lines: Line[], size: number, width: number, face: string): Laid[] {
  const out: Laid[] = [];
  for (const line of lines) {
    const pad = line.indent * size * 1.2;
    const avail = width - pad;
    const words: Word[] = [];
    /* A run that starts without a space continues the word before it
       ("**reverse electrodialysis**?"): glued, drawn with no gap. */
    let openEnd = false;
    for (const r of line.runs) {
      const parts = r.text.split(/(\s+)/);
      let first = true;
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { openEnd = false; first = false; continue; }
        words.push({ text: part, bold: r.bold, italic: r.italic, glue: first && openEnd && words.length > 0 });
        first = false;
        openEnd = true;
      }
      if (/\s$/.test(r.text)) openEnd = false;
    }
    if (words.length === 0) { out.push({ words: [], indent: line.indent, width: 0 }); continue; }
    let cur: Word[] = [], curW = 0;
    for (const w of words) {
      ctx.font = fontOf(size, w.bold, w.italic, face);
      const ww = ctx.measureText(w.text).width;
      const add = cur.length && !w.glue ? ctx.measureText(' ').width + ww : ww;
      if (cur.length && curW + add > avail) { out.push({ words: cur, indent: line.indent, width: curW }); cur = [w]; curW = ww; }
      else { cur.push(w); curW += add; }
    }
    out.push({ words: cur, indent: line.indent, width: curW });
  }
  return out;
}

interface FitOptions { max?: number; min?: number; align?: 'left' | 'center'; bold?: boolean; middle?: boolean; face?: string }

/* A block of text at a size that fits the box, shrinking to a floor;
   `middle` centers the block vertically. Returns the height used. */
function fitText(ctx: CanvasRenderingContext2D, md: string, x: number, y: number, width: number, height: number, opts: FitOptions = {}): number {
  const max = opts.max ?? 30, min = opts.min ?? 14;
  const face = opts.face ?? FACE;
  const lines = toLines(md);
  if (opts.bold) for (const l of lines) for (const r of l.runs) r.bold = true;
  let size = max;
  let laid: Laid[] = [];
  for (; size >= min; size -= 1) {
    laid = layout(ctx, lines, size, width, face);
    if (laid.length * size * 1.3 <= height) break;
  }
  const lh = size * 1.3;
  const shown = laid.slice(0, Math.max(1, Math.floor(height / lh)));
  const top = opts.middle ? y + Math.max(0, (height - shown.length * lh) / 2) : y;
  ctx.fillStyle = INK; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  shown.forEach((l, i) => {
    const pad = l.indent * size * 1.2;
    let cx = opts.align === 'center' ? x + (width - l.width) / 2 + pad / 2 : x + pad;
    l.words.forEach((w, j) => {
      ctx.font = fontOf(size, w.bold, w.italic, face);
      if (j > 0 && !w.glue) cx += ctx.measureText(' ').width;
      ctx.fillText(w.text, cx, top + i * lh);
      cx += ctx.measureText(w.text).width;
    });
  });
  return shown.length * lh;
}

/* ── The shapes ────────────────────────────────────────────────────────── */

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = FILL; ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
}

function ellipse(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = FILL; ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
}

/* A block arrow from (x1,y1) toward (x2,y2), as the handout draws them. */
function blockArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width = 34) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;
  const head = Math.min(len * 0.45, width * 1.4);
  const shaft = width / 2, wing = width;
  const bx = x2 - ux * head, by = y2 - uy * head;
  ctx.beginPath();
  ctx.moveTo(x1 + px * shaft, y1 + py * shaft);
  ctx.lineTo(bx + px * shaft, by + py * shaft);
  ctx.lineTo(bx + px * wing, by + py * wing);
  ctx.lineTo(x2, y2);
  ctx.lineTo(bx - px * wing, by - py * wing);
  ctx.lineTo(bx - px * shaft, by - py * shaft);
  ctx.lineTo(x1 - px * shaft, y1 - py * shaft);
  ctx.closePath();
  ctx.fillStyle = FILL; ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.stroke();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size = 26, align: CanvasTextAlign = 'left', bold = false) {
  ctx.font = fontOf(size, bold, false, FACE_UI);
  ctx.fillStyle = INK; ctx.textAlign = align; ctx.textBaseline = 'top';
  ctx.fillText(text, x, y);
}

/** The research graphic: question, impact, data, users. */
export function drawSummary(canvas: HTMLCanvasElement, input: GraphicInput) {
  const W = 1920, H = 1440;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  const v = input.values;

  /* Research question: the box across the top. */
  roundRect(ctx, 160, 60, 1600, 200, 18);
  label(ctx, 'Research Question:', 190, 84, 30);
  fitText(ctx, v.question ?? '', 190, 126, 1540, 122, { max: 30, min: 16 });

  blockArrow(ctx, 960, 275, 960, 395, 40);

  /* Impact: the wide ellipse. The words sit in the middle of it, where
     it is widest, under the label at the top. */
  ellipse(ctx, 960, 590, 640, 190);
  label(ctx, 'Impact:', 600, 440, 30);
  fitText(ctx, v.impact ?? '', 480, 480, 960, 270, { max: 28, min: 15, middle: true });

  blockArrow(ctx, 720, 800, 600, 900, 40);
  blockArrow(ctx, 1200, 800, 1320, 900, 40);

  /* Data and users: the two ellipses. */
  ellipse(ctx, 500, 1150, 380, 240);
  label(ctx, 'What data do you need to collect?', 500, 940, 26, 'center');
  fitText(ctx, v.data ?? '', 230, 985, 540, 340, { max: 26, min: 14, align: 'center', middle: true });

  ellipse(ctx, 1420, 1150, 380, 240);
  label(ctx, 'Who are your users?', 1420, 928, 26, 'center');
  label(ctx, 'Who should you interview?', 1420, 958, 26, 'center');
  fitText(ctx, v.users ?? '', 1150, 1000, 540, 330, { max: 26, min: 14, align: 'center', middle: true });
}

/** The impact and feasibility grid, with the sentences under it. */
export function drawImpact(canvas: HTMLCanvasElement, input: GraphicInput) {
  const W = 1920, H = 1560;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  const v = input.values;
  const hiImpact = /high/i.test(v.impact ?? '');
  const hiFeas = /high/i.test(v.feasibility ?? '');

  /* The cross. */
  const cx = 960, top = 150, bottom = 1010, left = 220, right = 1700;
  const cy = (top + bottom) / 2;
  ctx.strokeStyle = LINE; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, bottom); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(left, cy); ctx.lineTo(right, cy); ctx.stroke();

  label(ctx, 'HIGH IMPACT', cx, top - 60, 34, 'center', true);
  label(ctx, 'LOW IMPACT', cx, bottom + 20, 34, 'center', true);
  ctx.save(); ctx.translate(left - 40, cy); ctx.rotate(-Math.PI / 2); label(ctx, 'LOW FEASIBILITY', 0, -20, 34, 'center', true); ctx.restore();
  ctx.save(); ctx.translate(right + 60, cy); ctx.rotate(Math.PI / 2); label(ctx, 'HIGH FEASIBILITY', 0, -20, 34, 'center', true); ctx.restore();

  /* "PROJECT Analysis" on a white card at the crossing, as the handout has it. */
  ctx.fillStyle = PAPER; ctx.fillRect(cx - 120, cy - 60, 240, 120);
  label(ctx, 'PROJECT', cx, cy - 50, 30, 'center', true);
  label(ctx, 'Analysis', cx, cy + 4, 30, 'center');

  /* The idea, in its quadrant. Nothing is placed until both are chosen. */
  if (v.impact && v.feasibility) {
    const qx = hiFeas ? cx + 370 : cx - 370;
    const qy = hiImpact ? cy - 215 : cy + 215;
    ellipse(ctx, qx, qy, 300, 150);
    fitText(ctx, v.idea?.trim() ? v.idea : 'My project idea', qx - 260, qy - 110, 520, 220, { max: 26, min: 14, align: 'center', middle: true });
  }

  /* The second page: the sentences. */
  let y = bottom + 110;
  if (input.authors) { label(ctx, `Researcher's Name: ${input.authors}`, left, y, 28); y += 46; }
  label(ctx, 'Project Topic/Idea', left, y, 30, 'left', true); y += 48;
  label(ctx, 'My project idea is to.....', left, y, 28); y += 40;
  y += fitText(ctx, v.idea ?? '', left, y, right - left, 180, { max: 26, min: 15 }) + 30;
  const fe = (v.feasibility || '________').toLowerCase();
  const im = (v.impact || '________').toLowerCase();
  label(ctx, `My project idea has ${fe} feasibility and ${im} impact because`, left, y, 28); y += 40;
  fitText(ctx, v.because ?? '', left, y, right - left, H - y - 40, { max: 26, min: 15 });
}

export function draw(name: GraphicName, canvas: HTMLCanvasElement, input: GraphicInput) {
  readTokens();
  if (name === 'summary') drawSummary(canvas, input);
  else drawImpact(canvas, input);
}
