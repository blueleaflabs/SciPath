-- ===========================================================================
-- 0003 · AN ELDER SCORES NO ELDER; THE TEACHER SCORES THE ELDERS' OWN WORK (dev-166)
--
-- Only adds and replaces functions (decision 72; tests/additive.mjs): no
-- table, column or row is touched, and nothing the build before it reads
-- changes shape. Applied by hand: npx supabase db push --linked.
--
-- The Elders are students of the class with projects of their own, and
-- the class tracker had an Elder scoring their own assignments, since
-- looks_after() said the place was theirs. From here: an Elder's family
-- score on any Elder's work is refused, the teacher gives that score
-- through score_as_family (an `elder`-kind row, released at once, so the
-- tracker reads the same for every project), the write itself is one
-- internal function both paths share, and "Give the feedback" no longer
-- scores an Elder author.
-- ===========================================================================

-- Whether a person is an Elder of a program: holds the officer role at
-- the school, unrevoked, for that program or for every program (dev-166).
-- Of a named person, unlike app.has_role, which is of the caller.
create or replace function app.is_elder_of(p_user_id uuid, p_program_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
     where r.user_id = p_user_id
       and r.role = 'officer'
       and r.revoked_at is null
       and (r.scope_id is null or r.scope_id = p_program_id)
  );
$$;

revoke all on function app.is_elder_of(uuid, uuid) from public, anon;
grant execute on function app.is_elder_of(uuid, uuid) to authenticated;

-- The write itself, shared (dev-166): the author check, the bounds, the
-- row, the supersession and the audit line, with the kind decided by the
-- caller. Internal: nothing but the two public functions below may call
-- it, and it is granted to nobody.
create or replace function app.record_score(
  p_milestone_id uuid,
  p_student_id   uuid,
  p_kind         text,
  p_score        numeric,
  p_out_of       numeric,
  p_feedback_md  text,
  p_rubric       jsonb,
  p_release      boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_part uuid;
  v_prev uuid;
  v_id   uuid;
begin
  select e.org_id, e.id into v_org, v_part
    from public.entry_milestones m
    join public.participations e on e.id = m.participation_id
   where m.id = p_milestone_id;
  if v_org is null then
    raise exception 'no such obligation';
  end if;

  if not exists (
    select 1 from public.project_authors a
      join public.participations e on e.project_id = a.project_id
     where e.id = v_part and a.user_id = p_student_id and a.role = 'author'
  ) then
    raise exception 'that student is not an author of this project';
  end if;

  if p_score is not null and p_out_of is not null and p_score > p_out_of then
    raise exception 'a score cannot exceed what it is out of';
  end if;
  if p_score is not null and p_score < 0 then
    raise exception 'a score is not negative';
  end if;

  select a.id into v_prev
    from public.assessments a
   where a.milestone_id = p_milestone_id and a.student_id = p_student_id
     and a.kind = p_kind and a.superseded_by is null;

  insert into public.assessments
    (org_id, participation_id, milestone_id, student_id, grader_id,
     score, out_of, rubric, feedback_md, released_at, kind)
  values
    (v_org, v_part, p_milestone_id, p_student_id, auth.uid(),
     p_score, p_out_of, p_rubric, nullif(trim(coalesce(p_feedback_md, '')), ''),
     case when p_release or p_kind = 'elder' then now() end, p_kind)
  returning id into v_id;

  if v_prev is not null then
    update public.assessments set superseded_by = v_id where id = v_prev;
  end if;

  perform app.audit(v_org, 'assessment.written', 'assessments', v_id,
    null, jsonb_build_object('milestone_id', p_milestone_id, 'student_id', p_student_id,
                             'score', p_score, 'out_of', p_out_of, 'released', p_release, 'kind', p_kind));
  return v_id;
end;
$$;

revoke all on function app.record_score(uuid, uuid, text, numeric, numeric, text, jsonb, boolean) from public, anon, authenticated;

-- The teacher's grade, or the Elder's family score, as before — with one
-- refusal added (dev-166): an Elder scores no Elder. The Elders are
-- students of the class with projects of their own, and the family score
-- on that work is the teacher's to give (score_as_family, below), never
-- an Elder's, their own least of all.
create or replace function public.grade_milestone(
  p_milestone_id uuid,
  p_student_id   uuid,
  p_score        numeric,
  p_out_of       numeric,
  p_feedback_md  text,
  p_rubric       jsonb default null,
  p_release      boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_part uuid;
  v_prog uuid;
  v_kind text;
  v_done date;
begin
  select e.org_id, e.id, e.program_id, m.completed_on into v_org, v_part, v_prog, v_done
    from public.entry_milestones m
    join public.participations e on e.id = m.participation_id
   where m.id = p_milestone_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such obligation at this school';
  end if;

  /* Whose judgment this is follows who is calling, never a parameter: an
     advisor writes the grade; an Elder on the place writes the family's
     score, released the moment it is written, since the tracker it
     replaces was shared. Nobody else grades. */
  if app.is_advisor() then
    v_kind := 'teacher';
  elsif app.looks_after(v_part) then
    v_kind := 'elder';
  else
    raise exception 'the advisor grades; the Elder on the place scores';
  end if;

  if v_kind = 'elder' and app.is_elder_of(p_student_id, v_prog) then
    raise exception 'an Elder''s own work is scored by the teacher';
  end if;

  /* A family score is a score on work handed in (2.8). The teacher may
     grade an obligation that was never met; the Elder waits for it. */
  if v_kind = 'elder' and v_done is null then
    raise exception 'not handed in yet: the family score waits for the work';
  end if;

  return app.record_score(p_milestone_id, p_student_id, v_kind, p_score, p_out_of, p_feedback_md, p_rubric, p_release);
end;
$$;

revoke all on function public.grade_milestone(uuid, uuid, numeric, numeric, text, jsonb, boolean) from public, anon;
grant execute on function public.grade_milestone(uuid, uuid, numeric, numeric, text, jsonb, boolean) to authenticated;

-- The family score on an Elder's own work, given by the teacher (dev-166).
-- It is the same kind of row the Elders write — `elder`, released at once,
-- on the class tracker beside everyone else's — so the Elder's project
-- reads on the tracker like any other; only the hand that wrote it
-- differs. The teacher's grade (grade_milestone, kind `teacher`) is a
-- different thing and stays available on the same work. Refused for a
-- student who is not an Elder: the family scores its own students.
create or replace function public.score_as_family(
  p_milestone_id uuid,
  p_student_id   uuid,
  p_score        numeric,
  p_feedback_md  text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_prog uuid;
  v_done date;
begin
  select e.org_id, e.program_id, m.completed_on into v_org, v_prog, v_done
    from public.entry_milestones m
    join public.participations e on e.id = m.participation_id
   where m.id = p_milestone_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such obligation at this school';
  end if;
  if not app.is_advisor() then
    raise exception 'the teacher scores an Elder''s own work';
  end if;
  if not app.is_elder_of(p_student_id, v_prog) then
    raise exception 'the family scores its own students; this one is not an Elder';
  end if;
  if v_done is null then
    raise exception 'not handed in yet: the family score waits for the work';
  end if;

  return app.record_score(p_milestone_id, p_student_id, 'elder', p_score, 4, p_feedback_md, null, true);
end;
$$;

revoke all on function public.score_as_family(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.score_as_family(uuid, uuid, numeric, text) to authenticated;

-- The Elder's "Give the feedback", as 0001 wrote it, with the loop that
-- writes the family score per author skipping the authors who are Elders
-- (dev-166).
create or replace function public.give_document_feedback(
  p_document_id uuid,
  p_score       numeric,
  p_body_md     text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc   public.documents%rowtype;
  v_part  uuid;
  v_task  public.entry_milestones%rowtype;
  v_step  uuid;
  v_id    uuid;
  v_who   uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select * into v_doc from public.documents d where d.id = p_document_id;
  if v_doc.id is null or v_doc.org_id is distinct from app.org_id() then
    raise exception 'no such document at this school';
  end if;
  if app.authors_project(v_doc.project_id) then
    raise exception 'the Elder gives the feedback, not the author';
  end if;
  if coalesce(btrim(p_body_md), '') = '' then
    raise exception 'write the rationale first';
  end if;

  /* The task waiting on this document, on whichever of the project's
     places carries it; the place must be one the caller looks after. */
  select m.* into v_task
    from public.entry_milestones m
    join public.participations e on e.id = m.participation_id
   where e.project_id = v_doc.project_id
     and m.owner = 'staff'
     and m.feedback_on = v_doc.deliverable
     and m.completed_on is null
     and app.staff_task_ready(m.id)
   order by m.due_on nulls last
   limit 1;
  if v_task.id is null then
    if exists (select 1 from public.entry_milestones m
                join public.participations e on e.id = m.participation_id
                where e.project_id = v_doc.project_id and m.owner = 'staff'
                  and m.feedback_on = v_doc.deliverable and m.completed_on is not null) then
      raise exception 'the feedback on this one has been given';
    end if;
    raise exception 'not handed in yet: the feedback waits for the work';
  end if;
  v_part := v_task.participation_id;
  if not app.looks_after(v_part) then
    raise exception 'the Elder on this project gives feedback; the advisor only where there is none';
  end if;

  /* The line on the whole document: completes the task, tells the authors. */
  v_id := public.comment_on_document(p_document_id, null, p_body_md, false, null);

  /* The family's score, on the student step the task answers, per author. */
  if p_score is not null and v_task.requires_step is not null then
    select m.id into v_step from public.entry_milestones m
     where m.participation_id = v_part and m.step_id = v_task.requires_step
     limit 1;
    if v_step is not null then
      /* Not for an author who is an Elder (dev-166): that family score is
         the teacher's, and grade_milestone would refuse it. The feedback
         itself still reaches every author through the line above. */
      for v_who in
        select a.user_id from public.project_authors a
         where a.project_id = v_doc.project_id and a.role = 'author'
           and not app.is_elder_of(a.user_id, (select e.program_id from public.participations e where e.id = v_part))
      loop
        perform public.grade_milestone(v_step, v_who, p_score, 4, p_body_md, null, false);
      end loop;
    end if;
  end if;

  return v_id;
end;
$$;


revoke all on function public.give_document_feedback(uuid, numeric, text) from public, anon;
grant execute on function public.give_document_feedback(uuid, numeric, text) to authenticated;
