/**
 * WHAT GETS COMMITTED.
 *
 * Two pure functions: a title becomes a slug, and a record becomes the file
 * the archive reads. Both produce something permanent, which is the reason
 * they are testable in isolation rather than only through a screen.
 *
 * The format is specified in scipath-article-format.md. Three things write
 * it and must agree: this, the external manuscript form, and a person
 * migrating the back catalog by hand.
 */

/**
 * A title becomes a URL segment, once.
 *
 * Lowercase, transliterated to ASCII, non-alphanumerics to hyphens,
 * collapsed, trimmed, cut at 72 characters on a word boundary. Several titles
 * in the archive being migrated run past 140 characters, so cutting mid word
 * is not hypothetical.
 *
 * Collisions are resolved in the database, where the uniqueness lives.
 */
export function slugify(title: string): string {
  const ascii = title
    .normalize('NFKD')
    /* Strip the accents NFKD just separated, rather than dropping the letters
       they were attached to. */
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u00d8\u00f8]/g, 'o')
    .replace(/[\u00c6\u00e6]/g, 'ae')
    .replace(/[\u0110\u0111]/g, 'd')
    .replace(/[\u00d0\u00f0\u00de\u00fe]/g, 'th');

  const hyphenated = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (hyphenated.length <= 72) return hyphenated;

  const cut = hyphenated.slice(0, 73);
  const lastBreak = cut.lastIndexOf('-');
  return (lastBreak > 20 ? cut.slice(0, lastBreak) : cut.slice(0, 72)).replace(/-+$/, '');
}

export interface RecordAuthor {
  display_name: string;
  school?: string | null;
  grad_year?: number | null;
  affiliation_verified?: boolean;
  byline_only?: boolean;
  author_slug?: string | null;
}

export interface RecordForExport {
  id: string;
  record_kind: string;
  slug: string;
  year: number;
  title: string;
  abstract: string | null;
  keywords: string[];
  discipline: string;
  contributions: string | null;
  published_on: string;
  date_precision: string;
  source: string;
  reviewed: boolean;
  body_format: string;
  external_url: string | null;
  pdf_path: string | null;
  license: string;
  prior_venue?: string | null;
  doi?: string | null;
  pdf_text?: string | null;
  methods?: string[];
  data_sources?: string[];
  outputs?: string[];
  question?: string | null;
}

export interface ExportInput {
  record: RecordForExport;
  authors: RecordAuthor[];
  sections: { key: string; label: string; body: string }[];
  figures: { number: number; caption: string; alt: string; ext: string }[];
  references: string[];
  entries: {
    program: string;
    season: string | number | null;
    category: string | null;
    entry_code: string | null;
    placement: string | null;
    awards: string[];
    advanced_to: string | null;
  }[];
}

/** YAML needs quoting far less often than it needs it correctly. */
function yamlString(value: string): string {
  if (value === '') return "''";
  const needsQuotes = /^[\s>|@`%&*!#{}[\],?:\-]|[:#]\s|["']|\n|\s$/.test(value);
  if (!needsQuotes) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** A block scalar, for anything with line breaks or great length. */
function yamlBlock(value: string, indent = 2): string {
  const pad = ' '.repeat(indent);
  const body = value
    .trim()
    .split(/\n/)
    .map((line) => `${pad}${line}`)
    .join('\n');
  return `>-\n${body}`;
}

/**
 * The file. Frontmatter must validate against the content collection schema,
 * because a mismatch here fails the archive build rather than the working
 * surface, and it fails after somebody has already committed.
 */
export function toMarkdown(input: ExportInput): string {
  const { record: r, authors, sections, figures, references, entries } = input;
  const lines: string[] = ['---'];

  lines.push(`recordKind: ${r.record_kind}`);
  lines.push(`recordId: ${r.id}`);
  lines.push(`slug: ${r.slug}`);
  lines.push(`title: ${yamlString(r.title)}`);

  lines.push('authors:');
  for (const a of authors) {
    lines.push(`  - displayName: ${yamlString(a.display_name)}`);
    lines.push(`    authorSlug: ${a.byline_only ? 'null' : (a.author_slug ?? 'null')}`);
    if (a.school) lines.push(`    school: ${yamlString(a.school)}`);
    if (a.grad_year) lines.push(`    gradYear: ${a.grad_year}`);
    lines.push(`    affiliationVerified: ${a.affiliation_verified ? 'true' : 'false'}`);
  }

  if (r.abstract) {
    lines.push(`abstract: ${yamlBlock(r.abstract)}`);
  } else {
    /* Two of the twenty eight migrated articles have none, and inventing one
       is worse than saying so. */
    lines.push("abstract: ''");
  }

  if (r.keywords.length) {
    lines.push(`keywords: [${r.keywords.map(yamlString).join(', ')}]`);
  }

  lines.push(`discipline: ${r.discipline}`);
  lines.push(`publishedOn: ${r.published_on}`);
  lines.push(`datePrecision: ${r.date_precision}`);
  lines.push(`source: ${r.source}`);
  lines.push(`reviewed: ${r.reviewed ? 'true' : 'false'}`);
  lines.push(`bodyFormat: ${r.body_format}`);

  if (r.external_url) lines.push(`externalUrl: ${yamlString(r.external_url)}`);
  if (r.prior_venue) lines.push(`priorVenue: ${yamlString(r.prior_venue)}`);

  if (r.pdf_path) {
    lines.push(`pdf: /articles/${r.year}/${r.slug}/${r.slug}.pdf`);
  }

  if (r.contributions) lines.push(`contributions: ${yamlBlock(r.contributions)}`);
  if (r.question) lines.push(`question: ${yamlString(r.question)}`);

  for (const [key, values] of [
    ['methods', r.methods],
    ['dataSources', r.data_sources],
    ['outputs', r.outputs],
  ] as const) {
    if (values?.length) lines.push(`${key}: [${values.map(yamlString).join(', ')}]`);
  }

  if (entries.length) {
    lines.push('entries:');
    for (const e of entries) {
      lines.push(`  - program: ${yamlString(e.program)}`);
      if (e.season) lines.push(`    season: ${yamlString(String(e.season))}`);
      if (e.category) lines.push(`    category: ${yamlString(e.category)}`);
      if (e.entry_code) lines.push(`    entryCode: ${yamlString(e.entry_code)}`);
      if (e.placement) lines.push(`    placement: ${yamlString(e.placement)}`);
      if (e.awards?.length) {
        lines.push(`    awards: [${e.awards.map(yamlString).join(', ')}]`);
      }
      if (e.advanced_to) lines.push(`    advancedTo: ${yamlString(e.advanced_to)}`);
    }
  }

  if (figures.length) {
    lines.push('figures:');
    for (const f of figures) {
      lines.push(`  - src: /articles/${r.year}/${r.slug}/fig-${f.number}.${f.ext}`);
      lines.push(`    caption: ${yamlString(f.caption)}`);
      lines.push(`    alt: ${yamlString(f.alt)}`);
    }
  }

  if (references.length) {
    lines.push('references:');
    for (const citation of references) lines.push(`  - ${yamlString(citation)}`);
  }

  if (r.doi) lines.push(`doi: ${yamlString(r.doi)}`);

  /* Indexed, never rendered. Kept out of the body so nothing reads it as the
     paper. */
  if (r.pdf_text) lines.push(`pdfText: ${yamlBlock(r.pdf_text)}`);

  lines.push(`license: ${yamlString(r.license)}`);
  lines.push('status: published');
  lines.push('---');

  /* A PDF-only or link-only record has no body, and an empty one is correct
     rather than a placeholder. */
  if (r.body_format === 'full-text') {
    for (const section of sections) {
      if (!section.body?.trim()) continue;
      lines.push('');
      lines.push(`## ${section.label}`);
      lines.push('');
      lines.push(section.body.trim());
    }
  }

  return lines.join('\n') + '\n';
}

/** Where each file goes in the repository. */
export function repoPaths(r: { record_kind: string; year: number; slug: string }) {
  const space = r.record_kind === 'project' ? 'projects' : 'articles';
  return {
    markdown: `src/content/${space}/${r.year}/${r.slug}.md`,
    assetDir: `public/${space}/${r.year}/${r.slug}`,
    pdf: `public/${space}/${r.year}/${r.slug}/${r.slug}.pdf`,
    figure: (n: number, ext: string) =>
      `public/${space}/${r.year}/${r.slug}/fig-${n}.${ext}`,
  };
}
