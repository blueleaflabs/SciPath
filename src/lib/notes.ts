/**
 * NOTE RENDERING.
 *
 * Notes are stored as Markdown with a deliberately small vocabulary:
 * headings, emphasis, lists, links, code, quotes, tables, images. Not fonts
 * and not colors. A notebook is a record, and letting people style it
 * produces worse notebooks and an export that looks like a ransom note.
 *
 * Markdown is the storage format rather than the editing format, so a
 * WYSIWYG toolbar can be laid over it later without a migration.
 *
 * Raw HTML never survives. The source is escaped before parsing, so a note
 * cannot introduce a tag, an iframe, or a handler. This is a system holding
 * minors' work; an embed surface is not worth what it buys.
 */

import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

const ENTITIES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
};

/** Neutralize every angle bracket before the parser sees them. */
function escapeHtml(source: string): string {
  return source.replace(/[<>]/g, (c) => ENTITIES[c]);
}

/** Only http and https survive. Everything else becomes inert text. */
function safeUrls(html: string): string {
  return html
    .replace(/href="(?!https?:\/\/|\/|#|mailto:)[^"]*"/gi, 'href="#"')
    .replace(/src="(?!https?:\/\/|\/)[^"]*"/gi, 'src=""');
}

/**
 * MARKDOWN, RENDERED SO THAT NOTHING IN IT CAN RUN.
 *
 * **Escaping before the parser, rather than sanitizing after it.** An
 * external review asked for an allowlist sanitizer over the output, which is
 * the usual advice and is the weaker of the two here. A sanitizer has to
 * recognize every dangerous construct in whatever the parser emitted —
 * `<script>`, event attributes, `<svg>`, `<math>`, `<iframe>`, namespace
 * tricks — and it is wrong the day one is missed. Escaping the angle brackets
 * on the way in means the parser is never handed a tag at all, so there is no
 * class of tag to have missed. Markdown's own syntax cannot introduce one.
 *
 * The URL pass is still needed after it, because `[x](javascript:...)` is
 * Markdown rather than HTML: the parser builds that `href` itself, from text
 * containing no angle brackets. Same for `data:` in an image.
 *
 * It also means no dependency. A sanitizer would be a third-party package in
 * the request path of every published page, on a runtime with no DOM.
 *
 * Named for what it does rather than for notes, because the published record
 * needs exactly this and was calling `marked.parse` directly.
 */
export function renderMarkdown(source: string): string {
  return safeUrls(marked.parse(escapeHtml(source)) as string);
}

/** A notebook entry. The same rendering, under the name its callers use. */
export function renderNote(bodyMd: string): string {
  return renderMarkdown(bodyMd);
}

/** First line, for a list or a heading. */
export function noteSummary(bodyMd: string, max = 90): string {
  const line = bodyMd
    .split('\n')
    .map((l) => l.replace(/^[#>\-*\s]+/, '').trim())
    .find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The domain of a link, shown next to it. A personal Drive URL is then
 * visible at a glance, and a mentor can ask about it before the notebook
 * becomes unreachable at graduation. Brief 7.4, and 4.3 is what that failure
 * looks like four years later.
 */
export function linkDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}
