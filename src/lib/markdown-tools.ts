/**
 * The formatting bar's buttons, in order: what the notebook editor
 * (`MarkdownEditor.astro`) draws, and what a page draws once for a group
 * of editors that share one bar (the source cards on the lit review).
 * The tooltip is assembled in the browser, because only the browser knows
 * whether the person is on a Mac.
 */
export interface Tool { cmd: string; label: string; title: string; keys: string | null; cls?: string }

export const TOOLS: Tool[] = [
  { cmd: 'bold', label: 'B', title: 'Bold', keys: 'B', cls: 'b' },
  { cmd: 'italic', label: 'I', title: 'Italic', keys: 'I', cls: 'i' },
  { cmd: 'strike', label: 'S', title: 'Strikethrough', keys: '⇧X', cls: 's' },
  { cmd: 'h1', label: 'H1', title: 'Heading 1', keys: '⌥1' },
  { cmd: 'h2', label: 'H2', title: 'Heading 2', keys: '⌥2' },
  { cmd: 'h3', label: 'H3', title: 'Heading 3', keys: '⌥3' },
  { cmd: 'ul', label: '• List', title: 'Bulleted list', keys: '⇧8' },
  { cmd: 'ol', label: '1. List', title: 'Numbered list', keys: '⇧7' },
  /* Indentation (dev-151): a paragraph in from the margin, a list item
     under its parent. Tab and Shift+Tab, as in Docs; no modifier, so
     `keys` is null and the key is named in the title. */
  { cmd: 'indent', label: '⇥', title: 'Indent (Tab)', keys: null, cls: 'ind' },
  { cmd: 'outdent', label: '⇤', title: 'Outdent (Shift+Tab)', keys: null, cls: 'ind' },
  { cmd: 'quote', label: '“ Quote', title: 'Quote', keys: null },
  { cmd: 'code', label: '</>', title: 'Code', keys: null },
  { cmd: 'link', label: 'Link', title: 'Link', keys: 'K' },
];
