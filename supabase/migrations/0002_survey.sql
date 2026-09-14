-- ===========================================================================
-- 0002 · THE SURVEY: ONE QUESTION, RARELY; AND THE DAYS ANYBODY WROTE (dev-156, dev-157)
--
-- The first migration after the pilot began, and so the first that only
-- adds (decision 72; tests/additive.mjs holds it to that). Nothing here is
-- read by the build that came before it, and nothing that build reads is
-- changed. It replaces the dev-155 draft of this file, which no database
-- ever ran.
--
-- The questions themselves live in the code (src/config/survey.ts), and so
-- do the rules for when one may be put up (src/lib/survey.ts): the warm-up,
-- the cooldown, the cap, the sampling. The database keeps the trail those
-- rules read. One row per event: a question was *shown* to a person, and
-- then either *answered* — a number, or a short line, or both — or
-- *dismissed* with one button and nothing said. A dismissal is data: it
-- starts the same cooldown an answer does, and enough of them retire a
-- question, or slow the whole thing down, for that person.
--
-- Nothing here is ever shown on a page anybody else reads. The advisor may
-- read the school's rows; the report counts them and prints the numbers and
-- never a line; the lines stay in the database for the person who runs the
-- pilot.
-- ===========================================================================

create table public.survey_events (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations on delete restrict,
  user_id      uuid not null references public.users on delete restrict,
  -- Which question, by its id in the bank. The bank is code; the database
  -- checks the shape of the id and nothing more, so a question retired
  -- from the bank keeps its rows.
  question_id  text not null check (question_id ~ '^[a-z0-9_]{1,40}$'),
  -- Where it was asked: after the author submitted, after the Elder gave
  -- feedback, or on the Workbench.
  moment       text not null check (moment in ('after_submit', 'after_feedback', 'workbench')),
  event        text not null check (event in ('shown', 'answered', 'dismissed')),
  -- 3 yes, 2 mostly, 1 no (or keep / maybe / no) on a scale; a count on a
  -- number question (the teacher's minutes, dev-157). Null for the open
  -- line and for anything but an answer.
  answer       smallint check (answer is null or answer between 0 and 9999),
  comment      text check (comment is null or length(comment) <= 240),
  -- The document the moment was about, when there was one.
  document_id  uuid references public.documents on delete restrict,
  version_no   int,
  created_at   timestamptz not null default now(),
  -- An answer says something; a dismissal and a showing say nothing.
  constraint survey_events_answer_shape check (
    (event = 'answered' and (answer is not null or comment is not null))
    or (event <> 'answered' and answer is null and comment is null)
  )
);

create index survey_events_org_id_idx on public.survey_events (org_id, created_at desc);
create index survey_events_user_id_idx on public.survey_events (user_id, created_at desc);
create index survey_events_document_id_idx on public.survey_events (document_id);

alter table public.survey_events enable row level security;

-- The person reads their own; the advisor reads the school's. Nobody
-- writes the table from a session: the function below does.
create policy survey_events_read on public.survey_events
  for select to authenticated
  using (user_id = auth.uid() or (org_id = app.org_id() and app.is_advisor()));

grant select on public.survey_events to authenticated, service_role;
grant insert on public.survey_events to service_role;

-- The warm-up asks whether the person has ever saved a line, which the
-- history table answers by author; it had no index by author.
create index if not exists document_field_history_saved_by_idx on public.document_field_history (saved_by);

-- What the rules need to know about the person asking: when the account
-- was made (the warm-up counts from there), whether they have ever saved a
-- line of work (nobody is asked about a tool they have not used), and every
-- survey event of theirs so far, oldest first. One call per page that might
-- ask; the page decides.
create or replace function public.survey_history()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'since', (select u.created_at from public.users u where u.id = auth.uid()),
    'saved', exists (select 1 from public.document_field_history h where h.saved_by = auth.uid()),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('question_id', e.question_id, 'event', e.event, 'created_at', e.created_at) order by e.created_at)
      from public.survey_events e where e.user_id = auth.uid()
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

revoke all on function public.survey_history() from public, anon;
grant execute on function public.survey_history() to authenticated;

-- Record one event for the person signed in. A showing is recorded by the
-- page that put the card up; an answer or a dismissal by the button. A
-- document, when named, must be one the person may see.
create or replace function public.record_survey_event(
  p_question_id text,
  p_moment text,
  p_event text,
  p_answer int default null,
  p_comment text default null,
  p_document_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_doc public.documents%rowtype;
  v_comment text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  v_org := app.org_id();
  if v_org is null then
    raise exception 'no school';
  end if;
  if p_question_id is null or p_question_id !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'not a question';
  end if;
  if p_moment not in ('after_submit', 'after_feedback', 'workbench') then
    raise exception 'a question is asked after submitting, after reviewing, or on the Workbench';
  end if;
  if p_event not in ('shown', 'answered', 'dismissed') then
    raise exception 'an event is shown, answered or dismissed';
  end if;
  if p_answer is not null and (p_answer < 0 or p_answer > 9999) then
    raise exception 'an answer is a small number';
  end if;
  v_comment := nullif(left(btrim(coalesce(p_comment, '')), 240), '');
  if p_event = 'answered' and p_answer is null and v_comment is null then
    raise exception 'an answer says something';
  end if;
  if p_event <> 'answered' then
    p_answer := null;
    v_comment := null;
  end if;
  if p_document_id is not null then
    select * into v_doc from public.documents d where d.id = p_document_id;
    if v_doc.id is null or v_doc.org_id is distinct from v_org then
      raise exception 'no such document at this school';
    end if;
    if not app.can_see_project(v_doc.project_id) then
      raise exception 'not a document you may see';
    end if;
  end if;
  insert into public.survey_events (org_id, user_id, question_id, moment, event, answer, comment, document_id, version_no)
  values (v_org, auth.uid(), p_question_id, p_moment, p_event, p_answer, v_comment, p_document_id, case when p_document_id is null then null else coalesce(v_doc.version_no, 0) end);
end;
$$;

revoke all on function public.record_survey_event(text, text, text, int, text, uuid) from public, anon;
grant execute on function public.record_survey_event(text, text, text, int, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- THE DAYS ANYBODY WROTE (dev-157).
--
-- Every save lands in `document_field_history` with the whole field, and
-- from dev-158 nothing prunes it: the drafts are the record of how each
-- piece of work was written. Reading a semester's worth of them to answer
-- "who wrote on which day" is the wrong shape for that question, so every
-- save also lands here, as one row per person per project per day: the
-- cheap read for weekly actives and quiet projects, the same answer
-- whatever the history's size. Feedback lines, notebook entries and
-- scores keep their own rows; this is only the saves.
-- ---------------------------------------------------------------------------

create table public.activity_days (
  org_id      uuid not null references public.organizations on delete restrict,
  user_id     uuid not null references public.users on delete restrict,
  project_id  uuid not null references public.projects on delete restrict,
  -- The day in the school's time (the database keeps it; see 0001).
  day         date not null,
  saves       int  not null default 0,
  first_at    timestamptz not null,
  last_at     timestamptz not null,
  primary key (user_id, project_id, day)
);

create index activity_days_org_id_idx on public.activity_days (org_id, day desc);
create index activity_days_project_id_idx on public.activity_days (project_id, day desc);
create index activity_days_user_id_idx on public.activity_days (user_id, day desc);

alter table public.activity_days enable row level security;

-- Read like the history it summarises: whoever may see the project. No
-- session writes it; the trigger below does, as the table's owner.
create policy activity_days_read on public.activity_days
  for select to authenticated
  using ((select app.can_see_project(activity_days.project_id)));

grant select on public.activity_days to authenticated, service_role;

create or replace function app.roll_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select d.project_id into v_project from public.documents d where d.id = new.document_id;
  if v_project is null then return new; end if;
  insert into public.activity_days (org_id, user_id, project_id, day, saves, first_at, last_at)
  values (new.org_id, new.saved_by, v_project, (new.saved_at)::date, 1, new.saved_at, new.saved_at)
  on conflict (user_id, project_id, day) do update
    set saves = public.activity_days.saves + 1,
        first_at = least(public.activity_days.first_at, excluded.first_at),
        last_at = greatest(public.activity_days.last_at, excluded.last_at);
  return new;
end;
$$;

revoke all on function app.roll_activity() from public, anon, authenticated;

create trigger document_field_history_roll_activity
  after insert on public.document_field_history
  for each row execute function app.roll_activity();

-- The days already in the history, once.
insert into public.activity_days (org_id, user_id, project_id, day, saves, first_at, last_at)
select h.org_id, h.saved_by, d.project_id, (h.saved_at)::date, count(*), min(h.saved_at), max(h.saved_at)
from public.document_field_history h
join public.documents d on d.id = h.document_id
group by h.org_id, h.saved_by, d.project_id, (h.saved_at)::date
on conflict (user_id, project_id, day) do nothing;
