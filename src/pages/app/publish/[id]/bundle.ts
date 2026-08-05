import type { APIRoute } from 'astro';
import { serverClient } from '../../../../lib/supabase';
import { blobStore } from '../../../../lib/blob';
import { zip } from '../../../../lib/zip';
import { toMarkdown, repoPaths } from '../../../../lib/publish';
import { sectionsFor } from '../../../../config/structure';

/**
 * THE BUNDLE.
 *
 * Everything the repository needs for one record, as one download: the
 * markdown file at its path, the PDF, the figures, and a README saying what
 * to do with them. Unzip at the repository root and every file lands where it
 * belongs, which is the point of shipping paths rather than loose files.
 *
 * Regenerating is safe and produces the same thing. Allocating a second
 * identifier is not, and `generate_record` refuses it.
 */
export const prerender = false;

export const GET: APIRoute = async (context) => {
  const { session } = context.locals as any;
  if (!session) return new Response('Not found', { status: 404 });

  const supabase = serverClient(
    context.request,
    context.cookies,
    (context.locals as any).runtime?.env
  );

  const submissionId = context.params.id;

  const { data: record } = await supabase
    .from('records')
    .select('*')
    .eq('submission_id', submissionId)
    .maybeSingle();

  if (!record) return new Response('No record has been generated for this', { status: 404 });

  const [{ data: authors }, { data: sections }, { data: figures }, { data: references }, { data: entries }] =
    await Promise.all([
      supabase
        .from('record_authors')
        .select('display_name, school, grad_year, affiliation_verified, byline_only')
        .eq('record_id', record.id)
        .order('display_order'),
      supabase
        .from('manuscript_sections')
        .select('section_key, body')
        .eq('manuscript_id', record.manuscript_id),
      supabase
        .from('manuscript_figures')
        .select('number, storage_path, caption, alt')
        .eq('manuscript_id', record.manuscript_id)
        .is('withdrawn_at', null)
        .order('number'),
      supabase
        .from('manuscript_references')
        .select('citation')
        .eq('manuscript_id', record.manuscript_id)
        .order('sort_order'),
      supabase
        .from('entries')
        .select('placement, category, entry_code, awards, advanced_to, programs(name, season_year)')
        .eq('project_id', record.project_id),
    ]);

  const rules = sectionsFor(record.record_kind as any);
  const bodyByKey = new Map((sections ?? []).map((s: any) => [s.section_key, s.body]));

  const extOf = (path: string) => {
    const match = path.match(/\.([a-z0-9]+)$/i);
    return (match?.[1] ?? 'png').toLowerCase();
  };

  const markdown = toMarkdown({
    record: record as any,
    authors: (authors ?? []) as any,
    sections: rules.map((r) => ({
      key: r.key,
      label: r.label,
      body: bodyByKey.get(r.key) ?? '',
    })),
    figures: (figures ?? []).map((f: any) => ({
      number: f.number,
      caption: f.caption,
      alt: f.alt,
      ext: extOf(f.storage_path),
    })),
    references: (references ?? []).map((r: any) => r.citation),
    entries: (entries ?? []).map((e: any) => ({
      program: e.programs?.name ?? '',
      season: e.programs?.season_year ?? null,
      category: e.category,
      entry_code: e.entry_code,
      placement: e.placement,
      awards: e.awards ?? [],
      advanced_to: e.advanced_to,
    })),
  });

  const paths = repoPaths(record as any);
  const files: { path: string; body: Uint8Array | string }[] = [
    { path: paths.markdown, body: markdown },
  ];

  /* Assets come out of R2 and go into the repository, because a published
     record must not depend on storage that can be emptied. */
  const blob = blobStore(context.locals);
  const missing: string[] = [];

  if (blob.available()) {
    if (record.pdf_path) {
      const file = await blob.get(record.pdf_path);
      if (file) {
        files.push({ path: paths.pdf, body: new Uint8Array(await new Response(file.body).arrayBuffer()) });
      } else missing.push('the PDF');
    }

    for (const figure of figures ?? []) {
      const file = await blob.get(figure.storage_path);
      if (file) {
        files.push({
          path: paths.figure(figure.number, extOf(figure.storage_path)),
          body: new Uint8Array(await new Response(file.body).arrayBuffer()),
        });
      } else missing.push(`figure ${figure.number}`);
    }
  } else if (record.pdf_path || (figures ?? []).length > 0) {
    missing.push('every file, because storage is not configured here');
  }

  const url = `/${record.record_kind === 'project' ? 'projects' : 'articles'}/${record.year}/${record.slug}/`;

  files.push({
    path: `PUBLISH-${record.id}.txt`,
    body:
      `${record.id}\n${record.title}\n\n` +
      `Unzip this at the root of the repository. Every file is already at the\n` +
      `path it belongs at, so nothing needs moving.\n\n` +
      `  ${paths.markdown}\n` +
      files
        .slice(1)
        .map((f) => `  ${f.path}`)
        .join('\n') +
      `\n\nThen commit, push, and wait for the deploy. When ${url} loads,\n` +
      `go back to the publish screen and press Confirm it is live. That is\n` +
      `what tells the authors, so it comes after the page exists.\n` +
      (missing.length
        ? `\nMISSING FROM THIS BUNDLE: ${missing.join(', ')}.\nDo not commit until this is resolved, or the record will point at files\nthat are not there.\n`
        : ''),
  });

  const archive = zip(files);

  return new Response(archive, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${record.id}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
};
