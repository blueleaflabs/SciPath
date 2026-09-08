-- ===========================================================================
-- 0002 · THE PAGES' READS, FOLDED (2.9, the pilot's first week)
--
-- `0001` froze on the pilot's first day (decision 72, 11.7). This is the
-- first additive migration: three new functions and nothing else — no
-- column, no table, no policy changes — so the previous build runs
-- unchanged against it and the next build reads through them.
--
-- What they are for: every route's cost on the hosted instance is round
-- trips rather than any one query (design brief 137). Each of these
-- answers, as the definer scoped by `app.my_project_ids()` — the policy
-- asked once per project — what a page used to ask in six to nine reads
-- through per-row policies, in the shapes the page already reads.
-- ===========================================================================

-- The places of a program with their projects and authors, in one read
-- (2.9). `places_in` gave the rows through the rule once per project, but
-- the three program pages then embedded `projects`, `project_authors` and
-- `users` on them, and an embed is read as the caller: every author row
-- of every place offered to its policy, each one a `can_see_project`
-- call. On the hosted instance that made `places_in` the slowest call on
-- the tracker (74–85 ms idle) after everything else had been cut. This
-- answers the same rows in the same shape the embed did, as the definer,
-- scoped by `app.my_project_ids()` — the policy, asked once per project.
-- Only entered and competed places, which is all three pages asked for.
create or replace function public.places_of(p_program_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (select app.my_project_ids() as project_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', e.id,
           'project_id', e.project_id,
           'status', e.status,
           'projects', jsonb_build_object(
             'id', p.id,
             'title', p.title,
             'project_authors', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'role', a.role,
                        'participation_id', a.participation_id,
                        'self_managed_at', a.self_managed_at,
                        'users', jsonb_build_object('id', u.id, 'display_name', u.display_name)))
                 from public.project_authors a
                 join public.users u on u.id = a.user_id
                where a.project_id = p.id), '[]'::jsonb)))
           order by p.title, e.id), '[]'::jsonb)
    from public.participations e
    join public.projects p on p.id = e.project_id
   where e.program_id = p_program_id
     and e.status in ('entered', 'competed')
     and e.project_id in (select project_id from mine);
$$;
revoke all on function public.places_of(uuid) from public, anon;
grant execute on function public.places_of(uuid) to authenticated;

-- THE DEADLINES PAGE'S FACTS IN ONE READ (2.9). The page asked the
-- database thirteen questions in a row, nine of them about this one place
-- and its project, each answered through a row policy that resolves to the
-- same `can_see_project` on the same project: the place with its program
-- and project, the cohort it came through, the feedback, the recorded
-- deliverables, the sponsors of every place of the project, the links and
-- the manuscript, the last notebook entry, the people on the project, the
-- class's warnings and the documents written in SciPath. From a Worker
-- each is a network hop and they add serially. This asks the rule once and
-- answers the nine as one jsonb in the shapes the page already reads,
-- keyed by the same names PostgREST gave the embeds. Null when the place
-- does not exist or the caller may not see the project — the page then
-- does what it did for an empty read. The grades stay a session read: their
-- policy is per person and per release, not per project, and the page must
-- not have to restate it.
create or replace function public.place_page(p_project_id uuid, p_program_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_entry_id uuid;
  v_org      uuid;
begin
  if auth.uid() is null then return null; end if;
  if not app.can_see_project(p_project_id) then return null; end if;
  select e.id, e.org_id into v_entry_id, v_org
    from public.participations e
   where e.project_id = p_project_id and e.program_id = p_program_id;
  if v_entry_id is null then return null; end if;

  return jsonb_build_object(
    'entry', (
      select to_jsonb(e) - 'org_id'
             || jsonb_build_object(
                  'projects', (select jsonb_build_object(
                                 'id', p.id, 'title', p.title, 'started_on', p.started_on, 'facts', p.facts,
                                 'video_url', p.video_url, 'process_id', p.process_id,
                                 'project_authors', coalesce((
                                   select jsonb_agg(jsonb_build_object('role', a.role, 'users', jsonb_build_object('id', a.user_id)))
                                     from public.project_authors a where a.project_id = p.id), '[]'::jsonb))
                                 from public.projects p where p.id = e.project_id),
                  'programs', (select jsonb_build_object(
                                 'id', g.id, 'name', g.name, 'season_year', g.season_year, 'kind', g.kind,
                                 'program_role', g.program_role, 'process_id', g.process_id, 'phases', g.phases,
                                 'roles', g.roles, 'template_id', g.template_id, 'fair_date', g.fair_date,
                                 'advances_to_fairs', g.advances_to_fairs, 'showcase', g.showcase)
                                 from public.programs g where g.id = e.program_id))
        from public.participations e where e.id = v_entry_id),
    'via_process_id', (
      select g.process_id
        from public.participations e
        join public.participations v on v.id = e.via_id
        join public.programs g on g.id = v.program_id
       where e.id = v_entry_id),
    'feedback', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'deliverable_id', f.deliverable_id, 'milestone_id', f.milestone_id, 'body_md', f.body_md,
               'needs_revision', f.needs_revision, 'created_at', f.created_at, 'resolved_at', f.resolved_at,
               'author', jsonb_build_object('display_name', u.display_name))
             order by f.created_at desc)
        from public.deliverable_feedback f
        join public.users u on u.id = f.author_id
       where f.participation_id = v_entry_id), '[]'::jsonb),
    'deliverables', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'milestone_id', d.milestone_id, 'label', d.label, 'type', d.type, 'signed_on', d.signed_on,
               'external_url', d.external_url, 'verified_at', d.verified_at, 'verified_by', d.verified_by,
               'document_version_id', d.document_version_id))
        from public.deliverables d
       where d.participation_id = v_entry_id and d.superseded_at is null), '[]'::jsonb),
    'sponsor_places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'project_id', e.project_id, 'program_id', e.program_id,
               'programs', jsonb_build_object('name', g.name),
               'project_sponsors', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'teacher_name', sp.teacher_name, 'confirmed_at', sp.confirmed_at, 'signed_on', sp.signed_on,
                          'recorded_at', sp.recorded_at, 'superseded_at', sp.superseded_at))
                   from public.project_sponsors sp where sp.participation_id = e.id), '[]'::jsonb)))
        from public.participations e
        join public.programs g on g.id = e.program_id
       where e.project_id = p_project_id), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'label', l.label, 'url', l.url, 'visibility', l.visibility, 'created_at', l.created_at)
             order by l.created_at)
        from public.project_links l where l.project_id = p_project_id), '[]'::jsonb),
    'manuscript', (
      select jsonb_build_object('id', m.id, 'title', m.title)
        from public.manuscripts m where m.project_id = p_project_id limit 1),
    'last_note', (
      select jsonb_build_object('occurred_on', n.occurred_on, 'created_at', n.created_at)
        from public.field_notes n where n.project_id = p_project_id
       order by n.created_at desc limit 1),
    'overseers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', a.user_id, 'role', a.role, 'participation_id', a.participation_id,
               'self_managed_at', a.self_managed_at, 'accepted_at', a.accepted_at,
               'users', jsonb_build_object('id', u.id, 'display_name', u.display_name)))
        from public.project_authors a
        join public.users u on u.id = a.user_id
       where a.project_id = p_project_id), '[]'::jsonb),
    'warnings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'step_id', w.step_id, 'body', w.body, 'created_at', w.created_at, 'confirmed_at', w.confirmed_at,
               'users', jsonb_build_object('display_name', u.display_name))
             order by w.created_at desc)
        from public.step_warnings w
        join public.users u on u.id = w.written_by
       where w.program_id = p_program_id and w.retired_at is null and w.org_id = app.org_id()), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'deliverable', d.deliverable, 'status', d.status, 'version_no', d.version_no,
               'opened_at', d.opened_at, 'updated_at', d.updated_at, 'submitted_at', d.submitted_at,
               'document_fields', coalesce((
                 select jsonb_agg(jsonb_build_object('field_id', f.field_id, 'value', f.value))
                   from public.document_fields f where f.document_id = d.id), '[]'::jsonb)))
        from public.documents d where d.project_id = p_project_id), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.place_page(uuid, uuid) from public, anon;
grant execute on function public.place_page(uuid, uuid) to authenticated;

-- THE CARE LIST IN ONE READ (2.9). The Workbench built an Elder's or a
-- teacher's cards from six reads in a row — the projects they may see
-- with their authors, the places of those projects with their programs,
-- the sponsors, the notebook dates, the documents under way and the
-- students' obligations — each through the rule, and each a hop from the
-- Worker: the Elder's `/app/` was 28 calls and three-quarters of a second
-- on the school's network once the list was real. This answers the six
-- as one jsonb, scoped by `app.my_project_ids()` (the policy, asked once
-- per project), in the shapes the page already reads. Unarchived projects,
-- newest first; entered and competed places; current sponsors; the
-- students' obligations by date.
create or replace function public.care_list()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with mine as (select app.my_project_ids() as project_id),
       pr as (select p.* from public.projects p where p.id in (select project_id from mine) and p.archived_at is null),
       en as (select e.* from public.participations e where e.project_id in (select id from pr) and e.status in ('entered', 'competed'))
  select jsonb_build_object(
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'title', p.title, 'started_on', p.started_on, 'created_at', p.created_at,
               'project_authors', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'role', a.role, 'participation_id', a.participation_id, 'self_managed_at', a.self_managed_at,
                          'users', jsonb_build_object('id', u.id, 'display_name', u.display_name, 'grad_year', u.grad_year)))
                   from public.project_authors a join public.users u on u.id = a.user_id
                  where a.project_id = p.id), '[]'::jsonb))
             order by p.created_at desc)
        from pr p), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'project_id', e.project_id, 'status', e.status,
               'selection_state', e.selection_state, 'selection_decided_at', e.selection_decided_at,
               'programs', jsonb_build_object(
                 'id', g.id, 'name', g.name, 'season_year', g.season_year, 'fair_date', g.fair_date, 'kind', g.kind,
                 'roles', g.roles, 'selection_cap', g.selection_cap, 'program_role', g.program_role)))
        from en e join public.programs g on g.id = e.program_id), '[]'::jsonb),
    'sponsor_places', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'project_id', e.project_id, 'program_id', e.program_id,
               'programs', jsonb_build_object('name', g.name),
               'project_sponsors', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'teacher_name', sp.teacher_name, 'confirmed_at', sp.confirmed_at, 'signed_on', sp.signed_on,
                          'recorded_at', sp.recorded_at, 'superseded_at', sp.superseded_at))
                   from public.project_sponsors sp where sp.participation_id = e.id), '[]'::jsonb)))
        from public.participations e join public.programs g on g.id = e.program_id
       where e.project_id in (select id from pr)), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', n.project_id, 'count', n.count, 'last', n.last))
        from (select f.project_id, count(*) as count, max(f.occurred_on) as last
                from public.field_notes f where f.project_id in (select id from pr) group by f.project_id) n), '[]'::jsonb),
    'documents_open', coalesce((
      select jsonb_agg(jsonb_build_object('project_id', d.project_id, 'count', d.count))
        from (select x.project_id, count(*) as count
                from public.documents x where x.project_id in (select id from pr) and x.status <> 'submitted' group by x.project_id) d), '[]'::jsonb),
    'milestones', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'participation_id', m.participation_id, 'name', m.name, 'kind', m.kind, 'due_on', m.due_on,
               'required', m.required, 'blocks_experimentation', m.blocks_experimentation, 'completed_on', m.completed_on,
               'owner', m.owner, 'sort_order', m.sort_order)
             order by m.due_on asc nulls last, m.sort_order asc, m.id)
        from public.entry_milestones m
       where m.participation_id in (select id from en) and m.owner = 'student'), '[]'::jsonb),
    -- The documents of these projects and the last fortnight's lines on
    -- them, for the questions on the plate and the answers under it.
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'project_id', d.project_id, 'deliverable', d.deliverable))
        from public.documents d where d.project_id in (select id from pr)), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'document_id', f.document_id, 'field_id', f.field_id, 'author_id', f.author_id,
               'body_md', f.body_md, 'created_at', f.created_at, 'seen_at', f.seen_at,
               'author', jsonb_build_object('display_name', u.display_name))
             order by f.created_at asc)
        from public.deliverable_feedback f
        join public.users u on u.id = f.author_id
       where f.document_id in (select d.id from public.documents d where d.project_id in (select id from pr))
         and f.created_at >= now() - interval '14 days'), '[]'::jsonb)
  );
$$;
revoke all on function public.care_list() from public, anon;
grant execute on function public.care_list() to authenticated;
