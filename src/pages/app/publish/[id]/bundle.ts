import type { APIRoute } from 'astro';
import { serverClient } from '../../../../lib/supabase';
import { blobStore } from '../../../../lib/blob';
import { zip } from '../../../../lib/zip';
import { shape } from '../../../../lib/templates';
import { assembleRecord } from '../../../../lib/record-files';
import { activeOrg } from '../../../../lib/tenant';

/**
 * THE BUNDLE, as a fallback.
 *
 * Publishing writes to the record store. This exists for a deployment with no
 * store bound, and emits exactly what would have been written rather than an
 * approximation of it.
 */
export const prerender = false;

export const GET: APIRoute = async (context) => {
  const { session } = context.locals as any;
  if (!session) return new Response('Not found', { status: 404 });

  const org = activeOrg(context as any);
  const supabase = serverClient(
    context.request,
    context.cookies,
    (context.locals as any).runtime?.env
  );

  const { data: record } = await supabase
    .from('records')
    .select('*')
    .eq('submission_id', context.params.id)
    .maybeSingle();

  if (!record) return new Response('No record has been generated for this', { status: 404 });

  const { files, entry, missing, url } = await assembleRecord(
    supabase,
    blobStore(context.locals),
    org.slug,
    record,
    shape('imrad')
  );

  const zipped = zip([
    ...files.map((f) => ({ path: f.key, body: f.body })),
    { path: `${record.id}.manifest.json`, body: JSON.stringify(entry, null, 2) },
    {
      path: `PUBLISH-${record.id}.txt`,
      body:
        `${record.id}\n${record.title}\n\n` +
        `These are the objects that would have been written to the record\n` +
        `store, at the keys shown. The public address is ${url}\n\n` +
        files.map((f) => `  ${f.key}`).join('\n') +
        (missing.length ? `\n\nMISSING: ${missing.join(', ')}\n` : '\n'),
    },
  ]);

  /* The buffer, not the view. See the note in `src/lib/pdf-text.ts`: since
     TypeScript 5.7 a `Uint8Array` carries its buffer type, and `BodyInit`
     wants an `ArrayBuffer`. */
  return new Response(zipped.buffer as ArrayBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${record.id}.zip"`,
      'Cache-Control': 'no-store',
    },
  });
};
