/**
 * WHAT A RECORD BECOMES IN THE STORE.
 *
 * One markdown file with its frontmatter, its assets beside it, and an entry
 * in the organization's manifest. The markdown is the same format the article
 * format document specifies and the migration will write by hand, so a
 * migrated paper and a published one are indistinguishable once stored.
 *
 * Assembled in one place because it is used in three: publishing writes it,
 * the indexer reads it, and the bundle download emits it for a deployment
 * with no store configured.
 */

import { toMarkdown } from './publish.ts';
import { parseVideo, posterFor } from './video.ts';
import { sectionsFor } from '../config/structure.ts';
import { keysFor, type RecordEntry } from './records-store.ts';

export interface StoredFile {
  key: string;
  body: Uint8Array | string;
  contentType: string;
}

export interface Assembled {
  files: StoredFile[];
  entry: RecordEntry;
  /** Assets that should exist and do not. Never publish over one of these. */
  missing: string[];
  url: string;
}

/**
 * A one-way digest of the project id, so two records can recognize each other
 * as companions without the manifest carrying an internal identifier around
 * in public.
 */
async function projectRef(projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const bytes = new TextEncoder().encode(`scipath:project:${projectId}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const extOf = (path: string) => (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png').toLowerCase();

/**
 * The type a published file is served as.
 *
 * A missing entry falls through to `application/octet-stream`, and a browser
 * given that for an image renders the broken icon and the alt text. `svg`
 * was missing, so every seeded showcase image failed on every published
 * page: the file was written correctly and served as something nobody can
 * display.
 *
 * Uploads are checked against this on the way in, so the list is the
 * allowlist as well as the lookup.
 */
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

export async function assembleRecord(
  supabase: any,
  blob: { available(): boolean; get(path: string): Promise<any> },
  org: string,
  record: any,
  documentShape?: { parts?: { id: string; name: string; min_words?: number; guidance?: string }[] } | null
): Promise<Assembled> {
  /* A project entry has no sections, references, or figures: it is the
     abstract, the authors, and what happened at the fair. Asking for them
     would be six queries returning nothing. */
  const isEntry = record.record_kind === 'project';

  const [{ data: authors }, { data: sections }, { data: figures }, { data: references }, { data: entries }, { data: links }, { data: project }, { data: shots }] =
    await Promise.all([
      supabase
        .from('record_authors')
        .select('display_name, school, grad_year, affiliation_verified, byline_only, user_id')
        .eq('record_id', record.id)
        .order('display_order'),
      isEntry
        ? Promise.resolve({ data: [] })
        : supabase
            .from('manuscript_sections')
            .select('section_key, body')
            .eq('manuscript_id', record.manuscript_id),
      isEntry
        ? Promise.resolve({ data: [] })
        : supabase
            .from('manuscript_figures')
            .select('number, storage_path, caption, alt')
            .eq('manuscript_id', record.manuscript_id)
            .is('withdrawn_at', null)
            .order('number'),
      isEntry
        ? Promise.resolve({ data: [] })
        : supabase
            .from('manuscript_references')
            .select('citation')
            .eq('manuscript_id', record.manuscript_id)
            .order('sort_order'),
      supabase
        .from('opportunity_participations')
        .select('placement, category, entry_code, awards, advanced_to, programs:program_id(name, season_year)')
        .eq('project_id', record.project_id),
      supabase
        .from('project_links')
        .select('label, url')
        .eq('project_id', record.project_id),
      supabase
        .from('projects')
        .select('question, video_url')
        .eq('id', record.project_id)
        .maybeSingle(),
      supabase
        .from('project_images')
        .select('position, storage_path, alt, caption')
        .eq('project_id', record.project_id)
        .is('withdrawn_at', null)
        .order('position'),
    ]);

  const keys = keysFor(org, record);
  /* The shape is passed in rather than imported, for the same reason the
     structural check takes one: this module is used by the seed as well as
     the application, and the registry is bundled by Vite. */
  const rules = sectionsFor(record.record_kind, documentShape);
  const bodyByKey = new Map((sections ?? []).map((s: any) => [s.section_key, s.body]));

  const figureList = (figures ?? []).map((f: any) => ({
    number: f.number,
    caption: f.caption,
    alt: f.alt,
    ext: extOf(f.storage_path),
    storage_path: f.storage_path,
  }));

  const entryList = (entries ?? []).map((e: any) => ({
    program: e.programs?.name ?? '',
    season: e.programs?.season_year ? String(e.programs.season_year) : null,
    category: e.category,
    entry_code: e.entry_code,
    placement: e.placement,
    awards: e.awards ?? [],
    advanced_to: e.advanced_to,
  }));

  const markdown = toMarkdown({
    record: { ...record, question: project?.question ?? null },
    authors: (authors ?? []) as any,
    sections: rules.map((r) => ({ key: r.key, label: r.label, body: bodyByKey.get(r.key) ?? '' })),
    figures: figureList,
    references: (references ?? []).map((r: any) => r.citation),
    entries: entryList,
  });

  const files: StoredFile[] = [
    { key: keys.body, body: markdown, contentType: 'text/markdown; charset=utf-8' },
  ];

  const shotList = (shots ?? []).map((i: any) => ({
    position: i.position,
    ext: extOf(i.storage_path),
    storage_path: i.storage_path,
    alt: i.alt,
    caption: i.caption,
  }));
  const missing: string[] = [];

  /**
   * The video's still, fetched once, here.
   *
   * YouTube's has a predictable address and is used directly. Vimeo's needs
   * a call, and this is the moment to make it: by us, once, on behalf of the
   * person publishing. Afterwards it is our file, served from our store, and
   * a reader's browser asks nobody anything until they press play.
   */
  let videoPosterKey: string | null = null;

  const bytesOf = async (path: string) => {
    const file = await blob.get(path);
    if (!file) return null;
    return new Uint8Array(await new Response(file.body).arrayBuffer());
  };

  /* Assets are copied into the record's own prefix rather than referenced
     where they were uploaded, so a school taking its archive takes whole
     records and not pointers into a working bucket. */
  if (blob.available()) {
    if (record.pdf_path) {
      const bytes = await bytesOf(record.pdf_path);
      if (bytes) files.push({ key: keys.pdf, body: bytes, contentType: 'application/pdf' });
      else missing.push('the PDF');
    }

    const video = parseVideo(project?.video_url ?? null);

    if (video) {
      const url = await posterFor(video);

      if (url) {
        try {
          const answer = await fetch(url);

          if (answer.ok) {
            const ext = extOf(new URL(url).pathname);
            videoPosterKey = `${keys.dir}/poster.${MIME[ext] ? ext : 'jpg'}`;

            files.push({
              key: videoPosterKey,
              body: new Uint8Array(await answer.arrayBuffer()),
              contentType: MIME[ext] ?? 'image/jpeg',
            });
          }
        } catch {
          /* No still. The page draws its own panel, which is a cosmetic
             loss and not a reason to refuse a publication. */
          videoPosterKey = null;
        }
      }
    }

    for (const shot of shotList) {
      const bytes = await bytesOf(shot.storage_path);
      if (bytes) {
        files.push({
          key: `${keys.dir}/shot-${shot.position}.${shot.ext}`,
          body: bytes,
          contentType: MIME[shot.ext] ?? 'application/octet-stream',
        });
      } else missing.push(`showcase image ${shot.position}`);
    }

    for (const figure of figureList) {
      const bytes = await bytesOf(figure.storage_path);
      if (bytes) {
        files.push({
          key: keys.figure(figure.number, figure.ext),
          body: bytes,
          contentType: MIME[figure.ext] ?? 'application/octet-stream',
        });
      } else missing.push(`figure ${figure.number}`);
    }
  } else if (record.pdf_path || figureList.length > 0) {
    missing.push('every attached file, because storage is not configured here');
  }

  const assetUrl = (key: string) => `/records/${key.replace('records/', '')}`;

  const entry: RecordEntry = {
    recordId: record.id,
    recordKind: record.record_kind,
    slug: record.slug,
    year: record.year,
    title: record.title,
    authors: (authors ?? []).map((a: any) => ({
      displayName: a.display_name,
      /* No author page for anybody outside the organization: they never
         agreed to a permanent indexed page and cannot control one. */
      authorSlug: a.byline_only || !a.user_id ? null : slugName(a.display_name),
      school: a.school,
      gradYear: a.grad_year,
      affiliationVerified: a.affiliation_verified,
    })),
    abstract: record.abstract ?? '',
    keywords: record.keywords ?? [],
    discipline: record.discipline,
    publishedOn: record.published_on,
    datePrecision: record.date_precision,
    source: record.source,
    reviewed: record.reviewed,
    bodyFormat: record.body_format,
    externalUrl: record.external_url,
    doi: record.doi,
    pdf: record.pdf_path ? assetUrl(keys.pdf) : null,
    contributions: record.contributions,
    question: project?.question ?? null,
    methods: record.methods ?? [],
    dataSources: record.data_sources ?? [],
    outputs: record.outputs ?? [],
    entries: entryList.map((e) => ({
      program: e.program,
      season: e.season,
      category: e.category,
      entryCode: e.entry_code,
      placement: e.placement,
      awards: e.awards,
      advancedTo: e.advanced_to,
    })),
    figures: figureList.map((f) => ({
      src: assetUrl(keys.figure(f.number, f.ext)),
      caption: f.caption,
      alt: f.alt,
    })),
    shots: shotList.map((i) => ({
      src: assetUrl(`${keys.dir}/shot-${i.position}.${i.ext}`),
      caption: i.caption,
      alt: i.alt,
    })),
    video: project?.video_url ?? null,
    /* Stored with the record rather than pointed at. Even a still fetched
       from Vimeo's own host would be a request a reader's browser makes to
       Vimeo, which is the thing the facade exists to avoid. */
    videoPoster: videoPosterKey ? assetUrl(videoPosterKey) : null,
    references: (references ?? []).map((r: any) => r.citation),
    dataLinks: (links ?? []).map((l: any) => ({ label: l.label, url: l.url })),
    license: record.license,
    status: record.status ?? 'published',
    priorVenue: record.prior_venue,
    supersedes: record.supersedes,
    supersededBy: record.superseded_by,
    projectRef: await projectRef(record.project_id ?? null),
  };

  return { files, entry, missing, url: keys.url };
}

/** firstname-lastname, the shape author pages have always used. */
export function slugName(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
