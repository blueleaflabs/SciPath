export const prerender = false;

import type { APIRoute } from 'astro';
import { serverClient } from '../../../lib/supabase';
import { adminClient } from '../../../lib/supabase-admin';
import { readManifest, writeManifest, withdraw, objectsFor } from '../../../lib/records-store';

/**
 * PERFORMING A DELETION.
 *
 * `delete_account` removes the rows. Three things live outside SQL and are
 * this route's whole reason for existing:
 *
 *   1. **The files.** The function hands back every storage path left with
 *      nothing pointing at it. They are removed here, from the binding.
 *   2. **The auth row.** `auth.users` belongs to Supabase and is reachable
 *      only through the admin API. Left behind, the person can sign in again
 *      and be walked through signup as a stranger — which looks like the
 *      deletion silently failed.
 *   3. **The search index.** Rebuilt rather than edited; a published record
 *      that has gone from the database is still findable until then.
 *
 * **Why the secret key is used by somebody who is signed in.** Every other
 * use of `adminClient` is for a person who is not signed in at all, and its
 * header says that finding it in ordinary request handling means the policies
 * are wrong. This is the exception and it is deliberate: the operation
 * requires privileges the person must never hold — deleting rows on other
 * people's projects, and deleting an authentication record — and the identity
 * it acts on is taken from *their own session*, never from the request body.
 * There is no parameter here naming whose account to delete.
 *
 * The typed confirmation is checked again on the server. The screen asks for
 * it, and a screen is not a guard.
 */
export const POST: APIRoute = async ({ request, cookies, locals, redirect }) => {
  const runtime = (locals as Record<string, any>).runtime?.env;
  const { session, account } = locals as any;

  if (!session || !account) return redirect('/app/');

  const form = await request.formData();
  const typed = String(form.get('confirm') ?? '').trim().toLowerCase();

  /* Their own address, as GitHub asks for a repository's name: specific to
     the thing being destroyed, so muscle memory cannot supply it. */
  const expected = String(session.email ?? '').trim().toLowerCase();

  if (!expected || typed !== expected) {
    return redirect('/app/account/?e=' + encodeURIComponent('That did not match your email address.'), 303);
  }

  const supabase = serverClient(request, cookies, runtime);

  /* Anything still waiting on somebody else's answer stops this.
  
     Asked of the database. This used to select pending rows straight from
     `account_deletion_approvals` — and the read policy on that table exposes
     rows where the caller is the *approver*, not the person leaving. So it
     counted the approvals somebody was waiting to answer for other people,
     which is almost always none: the guard passed, and meant nothing.
  
     A query whose result is inverted from what its variable is called is the
     hardest kind to see, and no test that ran as one person could catch it. */
  const { data: readiness } = await supabase.rpc('deletion_ready');
  const ready = (readiness as any) ?? { state: 'none', waiting: 0 };

  if (ready.state === 'none') {
    return redirect(
      '/app/account/?e=' +
        encodeURIComponent('Start from the account page, so you can see what will go.'),
      303
    );
  }

  if (ready.state !== 'ready' || Number(ready.waiting) > 0) {
    return redirect(
      '/app/account/?e=' +
        encodeURIComponent('Somebody has still to answer. Nothing has been deleted.'),
      303
    );
  }

  const admin = adminClient(runtime);

  const { data: removed, error } = await admin.rpc('delete_account', {
    p_user_id: account.id,
  });

  if (error) {
    return redirect('/app/account/?e=' + encodeURIComponent(error.message), 303);
  }

  /* The files. After the rows, not before: a failure here leaves orphaned
     objects, which is a cost. A failure the other way round leaves rows
     pointing at files that are gone, which is a broken page for everybody
     else on a shared project. */
  const bucket = (runtime as any)?.NOTEBOOK;
  const files: string[] = (removed as any)?.files ?? [];
  const stranded: string[] = [];

  if (bucket) {
    for (const key of files) {
      try {
        await bucket.delete(key);
      } catch (e: any) {
        /* Counted and logged rather than swallowed. There is no session left
           to tell, and an orphaned object is a cleanup job rather than a
           reason to fail a deletion that has otherwise succeeded — but a
           failure nobody records is a failure nobody fixes, and the privacy
           page promises these are gone. */
        stranded.push(key);
        console.error('account deletion: object not removed', String(e?.message ?? e));
      }
    }

    if (stranded.length > 0) {
      console.error(`account deletion: ${stranded.length} objects left in storage`);
    }
  }

  /* THE PUBLIC ARCHIVE.
  
     Rows in `records` are gone by now, and that changes nothing a reader can
     see: the archive is static, so a withdrawn record stays at its address,
     stays in the search index, and merely stops being listed. Which is the
     worst of the three states — still readable, and no longer reachable by
     anybody who could ask for it to come down.
  
     So the files go, and the manifest entry with them. The manifest is read
     once and written once however many records there are, because a
     read-modify-write per record is a race with itself. */
  const published: any[] = (removed as any)?.published ?? [];

  if (bucket && published.length > 0) {
    const org = published[0].org;

    try {
      let manifest = await readManifest(bucket, org);

      for (const record of published) {
        for (const key of await objectsFor(bucket, org, record)) {
          try {
            await bucket.delete(key);
          } catch (e: any) {
            stranded.push(key);
            console.error('account deletion: record file not removed', String(e?.message ?? e));
          }
        }

        manifest = withdraw(manifest, record.id);
      }

      await writeManifest(bucket, manifest);
    } catch (e: any) {
      /* Loudly. A record still listed after its author has been deleted is
         the failure the privacy page is most specific about. */
      console.error('account deletion: the archive still lists a deleted record',
        String(e?.message ?? e));
    }
  }

  /* The search index is rebuilt rather than edited — Pagefind writes a set of
     files from the whole corpus, and there is no way to remove one entry from
     it in place. `npm run index:records` does that, and CI runs it nightly,
     so a withdrawn record can remain findable until then.
  
     Said here rather than left as a silence: it is a real gap with a known
     fix, and the person deleting their account should not be the last to
     learn of it. */
  if (published.length > 0) {
    console.warn(
      `account deletion: ${published.length} record(s) withdrawn; ` +
        'the search index is rebuilt by index-records and may still list them'
    );
  }

  /* The authentication record. Last, because it is the one thing that cannot
     be retried afterwards: with the row in `public.users` gone there is
     nothing left to find the auth id from. */
  /* `public.users.id` *is* `auth.users.id` — the schema's first stated
     invariant, and the reason every policy is a comparison against
     `auth.uid()`. A fallback chain here would have implied there was some
     other id to fall back to.
  
     **The result is read.** This client returns `{ error }` rather than
     throwing, so the `try`/`catch` around it caught nothing and a failure to
     remove the authentication record was reported as success. Somebody would
     then sign in again tomorrow and be walked through signup as a stranger,
     having been told their account was permanently deleted.
  
     It cannot be undone from here — the row in `public.users` is already
     gone, so there is nothing left to find them by — so it is logged loudly
     and without naming them. That is a cleanup job, not something to hide. */
  try {
    const { error: authError } = await admin.auth.admin.deleteUser(account.id);
    if (authError) console.error('account deletion: auth record remains', authError.message);
  } catch (e: any) {
    console.error('account deletion: auth removal raised', String(e?.message ?? e));
  }

  await supabase.auth.signOut();

  return redirect('/?gone=1', 303);
};
