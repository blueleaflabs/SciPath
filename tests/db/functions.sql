-- ===========================================================================
-- THE FUNCTIONS A PAGE CALLS.
--
-- Every write in the application goes through one of these rather than
-- through a table, so a guard that is wrong here is a guard that is not
-- there. They run as SECURITY DEFINER, which means they bypass RLS and carry
-- their own checks — and a check inside a definer function is the one kind
-- nothing else in this repository can verify by reading.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset footer off

\set QUIET on
select id as author   from public.users where display_name = 'Author one' \gset
select id as outsider from public.users where display_name = 'Other school student' \gset
select id as project  from public.projects where title like 'Last year%' \gset
select id as advisor  from public.users where display_name = 'Advisor' \gset
select id as officer  from public.users where display_name = 'Fair officer' \gset
select id as elder    from public.users where display_name = 'Elder' \gset
\set QUIET off

/*
 * Both helpers switch to `authenticated` as well as setting the subject.
 *
 * They set only the subject at first, which runs as the superuser and
 * bypasses row level security entirely — so they proved that a SECURITY
 * DEFINER function raises when it should, and proved nothing at all about a
 * policy. A student writing a row a policy forbids came back as allowed, and
 * the policy was correct.
 */
create or replace function pg_temp.refuses(p_what text, p_user uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('role', 'authenticated', true);

  begin
    execute p_sql;
  exception when others then
    perform set_config('role', 'postgres', true);
    return format('  ok   %s', p_what);
  end;

  perform set_config('role', 'postgres', true);
  raise exception 'FAIL %: it was allowed', p_what;
end $$;

create or replace function pg_temp.allows(p_what text, p_user uuid, p_sql text)
returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('role', 'authenticated', true);

  execute p_sql;

  perform set_config('role', 'postgres', true);
  return format('  ok   %s', p_what);
exception when others then
  perform set_config('role', 'postgres', true);
  raise exception 'FAIL %: %', p_what, sqlerrm;
end $$;

/**
 * What a query answers, as that user.
 *
 * `refuses` and `allows` ask whether something is permitted. This asks what
 * it says, which is what a column holding display text needs.
 *
 * Written as a comparison inside plpgsql rather than as `case ... else 1/0`,
 * because Postgres folds constant subexpressions and evaluates `1/0` whether
 * or not its branch is taken. A test written that way fails on a correct
 * schema, which is how this one was first written.
 */
create or replace function pg_temp.says(
  p_what text, p_user uuid, p_sql text, p_expected text
) returns text language plpgsql as $$
declare
  v_got text;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('role', 'authenticated', true);

  execute p_sql into v_got;

  perform set_config('role', 'postgres', true);

  if v_got is distinct from p_expected then
    raise exception 'FAIL %: expected %, got %', p_what, p_expected, coalesce(v_got, 'null');
  end if;

  return format('  ok   %s', p_what);
exception when others then
  perform set_config('role', 'postgres', true);
  raise;
end $$;

-- ── Who may change a project ───────────────────────────────────────────────

select pg_temp.refuses(
  'somebody else cannot set the research question', :'outsider',
  format('select public.save_project_question(%L, %L)', :'project', 'Hijacked?'));

select pg_temp.allows(
  'an author can', :'author',
  format('select public.save_project_question(%L, %L)', :'project', 'Does it work?'));

-- ── Images: four, and both descriptions ────────────────────────────────────

select pg_temp.allows(
  'four images are accepted', :'author',
  format($f$
    select public.add_project_image(%L, 'a.svg', 'alt', 'caption');
    select public.add_project_image(%L, 'b.svg', 'alt', 'caption');
    select public.add_project_image(%L, 'c.svg', 'alt', 'caption');
    select public.add_project_image(%L, 'd.svg', 'alt', 'caption');
  $f$, :'project', :'project', :'project', :'project'));

select pg_temp.refuses(
  'a fifth is not', :'author',
  format('select public.add_project_image(%L, ''e.svg'', ''alt'', ''caption'')', :'project'));

select pg_temp.refuses(
  'an image with no alt text is not', :'author',
  format('select public.add_project_image(%L, ''f.svg'', ''   '', ''caption'')', :'project'));

select pg_temp.refuses(
  'nor one with no caption', :'author',
  format('select public.add_project_image(%L, ''g.svg'', ''alt'', '''')', :'project'));

-- ── Video: an allowlist, because we frame the result ───────────────────────

select pg_temp.allows(
  'a YouTube address is accepted', :'author',
  format('select public.save_project_video(%L, ''https://youtu.be/abc123'')', :'project'));

select pg_temp.refuses(
  'an arbitrary page is not', :'author',
  format('select public.save_project_video(%L, ''https://example.test/video'')', :'project'));

select pg_temp.refuses(
  'nor a javascript: address', :'author',
  format('select public.save_project_video(%L, ''javascript:alert(1)'')', :'project'));

select pg_temp.refuses(
  'nor http on a host we do allow', :'author',
  format('select public.save_project_video(%L, ''http://youtu.be/abc123'')', :'project'));

-- ── Who assigns an officer ─────────────────────────────────────────────────
--
-- Officers are assigned by other officers. Somebody who is both an author
-- here and an officer of the club has an obvious interest in who oversees
-- their work, and hiding the button on the page is not the rule: this is.

/* **The participation, not the project.**

   These two asserted on `assign_officer(<project id>, …)`, and the first
   argument has been a participation since oversight moved to a place
   (22.18). So the lookup found no row, the function raised *no such place at
   this school*, and both checks passed on that rather than on the rule they
   name. Neither had ever exercised the author clause -- 19.9's shape, twice
   in four lines. */
\set QUIET on
select id as author_officer from public.users where display_name = 'Fair officer' \gset
select id as their_project  from public.projects where title = 'Private, this year' \gset
select pa.id as their_place from public.participations pa
  join public.projects p on p.id = pa.project_id
 where p.title = 'Private, this year' limit 1 \gset
\set QUIET off

/* Make the officer an author of a project, which is the ordinary case: a
   student who runs the club also does research. */
insert into public.project_authors (org_id, project_id, user_id, role, accepted_at)
select org_id, :'their_project', :'author_officer', 'author', now()
  from public.projects where id = :'their_project'
on conflict do nothing;

/* Naming somebody else to oversee your own work. The rule is about choosing
   a supervisor, and this is the choosing. */
select pg_temp.refuses(
  'an author does not choose who oversees their own project', :'author_officer',
  format('select public.assign_officer(%L, %L)', :'their_place', :'elder'));

/* **And the advisor may name an author as the officer of their own project**,
   which is how self management is recorded. This asserted the opposite --
   `refuses`, as the advisor -- and passed only because the argument was a
   project id. `self_managed_at` and the `self-managed` badge exist for
   exactly this row, so refusing it would have been refusing a state the
   product renders. */
select pg_temp.allows(
  'and the advisor may record an author as looking after their own work',
  :'advisor',
  format('select public.assign_officer(%L, %L)', :'their_place', :'author_officer'));

-- ── Granting a place ───────────────────────────────────────────────────────
--
-- A program that takes a handful of students grants places. The fair's
-- officers do not decide who is in the class, which is the point of scoping
-- roles to programs.

\set QUIET on
select id as course_id from public.programs where slug = 'irpd-2027' \gset
select id as course_project from public.projects where title = 'Course project' \gset
\set QUIET off

update public.programs set joining = 'approval', places = 2 where id = :'course_id';
update public.participations set status = 'requested' where project_id = :'course_project';

\set QUIET on
select id as request from public.participations where project_id = :'course_project' \gset
\set QUIET off

select pg_temp.refuses(
  'a student cannot grant themselves a place', :'author',
  format('select public.decide_place(%L, true)', :'request'));

select pg_temp.refuses(
  'nor can an officer of a different program', :'officer',
  format('select public.decide_place(%L, true)', :'request'));

select pg_temp.allows(
  'the program''s own officer can', :'elder',
  format('select public.decide_place(%L, true)', :'request'));

select pg_temp.allows(
  'and a school-wide advisor can refuse, with a reason', :'advisor',
  format('select public.decide_place(%L, false, %L)', :'request', 'Full this term. Ask again in the spring.'));



do $$
begin
  if not exists (
    select 1 from public.participations
     where status = 'declined' and decided_by is not null and decided_note is not null
  ) then
    raise exception 'FAIL: a refusal was recorded with no name and no reason on it';
  end if;
end $$;
\echo '  ok   a refusal carries a name and a reason'

/* A refusal can be reversed. Until the refused list existed there was no way
   back at all: the row left every staff view the moment somebody clicked. */
select pg_temp.allows(
  'a refusal can be undone', :'advisor',
  format('select public.decide_place(%L, true)', :'request'));

do $$
begin
  if not exists (
    select 1 from public.participations
     where id = (select id from public.participations where status = 'entered' limit 1)
  ) then
    raise exception 'FAIL: reversing a refusal did not grant the place';
  end if;
end $$;
\echo '  ok   and the place is granted'

/* An advisor scoped to one program does not decide another's. A school with
   two teachers gives each a scoped role, and neither sees the other's
   queue. */
insert into public.user_roles (org_id, user_id, role, scope_id)
select org_id, :'officer', 'advisor', (select id from public.programs where slug = 'fair-2027')
  from public.users where id = :'officer';

update public.participations set status = 'requested' where project_id = :'course_project';

select pg_temp.refuses(
  'an advisor scoped to another program cannot decide this one', :'officer',
  format('select public.decide_place(%L, true)', :'request'));

-- ── What a club knows ──────────────────────────────────────────────────────
--
-- Officers of the program write; everybody at the school reads. A warning
-- only the officers can see is a warning that has not been written.

select pg_temp.refuses(
  'a student cannot write a warning', :'author',
  format($f$
    insert into public.step_warnings (org_id, program_id, step_id, body, written_by)
    select org_id, %L, 'design', 'Something that goes wrong here, at length.', %L
      from public.programs where id = %L
  $f$, :'course_id', :'author', :'course_id'));

select pg_temp.allows(
  'the program''s own officer can', :'elder',
  format($f$
    insert into public.step_warnings (org_id, program_id, step_id, body, written_by)
    select org_id, %L, 'design', 'The SRC sends these back without replicate counts.', %L
      from public.programs where id = %L
  $f$, :'course_id', :'elder', :'course_id'));

do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', (select id::text from public.users where display_name = 'Another student'), true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.step_warnings;
  perform set_config('role', 'postgres', true);

  if n < 1 then
    raise exception 'FAIL: a student cannot read what the club wrote';
  end if;
end $$;
\echo '  ok   and every student can read it'

-- ── Roles ──────────────────────────────────────────────────────────────────

select pg_temp.refuses(
  'nobody grants themselves a role', :'author',
  format($f$
    insert into public.user_roles (org_id, user_id, role)
    select org_id, id, 'officer' from public.users where id = %L
  $f$, :'author'));

-- ── The role vocabulary ────────────────────────────────────────────────────
--
-- The words a program calls its people are resolved from its template and
-- stored on the row, so that nine screens can read them out of a query they
-- were already making rather than loading the template library. What matters
-- here is that the column exists, that a student can read it, and that a
-- program which declares nothing still reads as something.

update public.programs
   set roles = '{"staff": {"singular": "Elder", "plural": "Elders"},
                 "member": {"singular": "Student", "plural": "Students"}}'::jsonb
 where id = :'course_id';

select pg_temp.says(
  'a student reads the words their own program uses', :'author',
  format($f$
    select roles #>> '{staff,singular}' from public.programs where id = %L
  $f$, :'course_id'),
  'Elder');

-- Asserted on the value rather than on an exception. There is no update
-- policy on `programs`, so row level security matches no row and the
-- statement succeeds having changed nothing: `refuses` sees no error and
-- reports that it was allowed. What is being claimed here is that the words
-- did not move, which is the thing that matters and the thing a silent
-- zero row update would otherwise hide.
select pg_temp.allows(
  'a student may run the update, which is not the question', :'author',
  format($f$
    update public.programs set roles = '{"staff": {"singular": "Overlord"}}'::jsonb
     where id = %L
  $f$, :'course_id'));

select pg_temp.says(
  'and it changes nothing', :'author',
  format($f$
    select roles #>> '{staff,singular}' from public.programs where id = %L
  $f$, :'course_id'),
  'Elder');

-- A program seeded before the column existed, or one whose template says
-- nothing about vocabulary. It reads as an empty object rather than as null,
-- so the page falls back to the schema's word instead of rendering blank.
select pg_temp.says(
  'a program that names nobody reads as empty rather than null', :'author',
  $f$select roles::text from public.programs where slug = 'fair-2027'$f$,
  '{}');

-- ── The outbox ─────────────────────────────────────────────────────────────
--
-- A plpgsql body is not checked until it runs, so an insert naming a column
-- that no longer exists applies cleanly and fails the first time somebody
-- assigns a reviewer. These call the functions rather than reading them.

do $$
declare
  v_org uuid;
  v_ms  uuid;
  v_sub uuid;
begin
  select org_id into v_org from public.projects limit 1;

  insert into public.manuscripts (org_id, project_id, title, created_by)
  values (v_org, (select id from public.projects limit 1), 'A paper',
          (select id from public.users limit 1))
  returning id into v_ms;

  insert into public.submissions (org_id, project_id, manuscript_id, record_kind, state, round)
  values (v_org, (select id from public.projects limit 1), v_ms, 'article', 'screening', 1)
  returning id into v_sub;

  perform set_config('app.test_submission', v_sub::text, false);
end $$;

/* An officer assigning another officer. The point is the insert, not the
   permission: a plpgsql body naming a dropped column applies cleanly and
   fails the first time it runs, which is what this catches. */
select pg_temp.allows(
  'assigning a reviewer writes an outbox row and does not fail on a column',
  :'advisor',
  format($f$
    select public.assign_reviewer(%L::uuid, %L::uuid, now() + interval '14 days')
  $f$, current_setting('app.test_submission'), :'officer'));

/* Read as the drain reads it, which is as the service role. `notifications`
   carries row level security and deliberately no policy: a table recording
   who was told what is the wrong thing to leave readable, so an
   authenticated select returns nothing at all. That absence is the design
   (20.7), and reading through it here would test the policy rather than the
   insert. */
do $$
declare
  v_kind text;
  v_body_columns int;
begin
  select kind into v_kind
    from public.notifications
   where dedupe_key like 'reviewer_assigned:%'
   order by created_at desc limit 1;

  if v_kind is distinct from 'reviewer_assigned' then
    raise exception 'FAIL the outbox row is %, not reviewer_assigned', coalesce(v_kind, 'missing');
  end if;

  /* And it holds no rendered message, which is the property the whole
     redesign turns on: a sentence stored now is a sentence composed before
     the facts it describes can change (20.2). */
  select count(*) into v_body_columns
    from information_schema.columns
   where table_name = 'notifications' and column_name in ('subject', 'body');

  if v_body_columns > 0 then
    raise exception 'FAIL notifications still stores a rendered message';
  end if;

  raise notice '  ok   the outbox row carries the event, not a rendered message';
end $$;

-- ── A person joins a cohort; a project enters an opportunity ──────────────
--
-- Both point at `programs` while the split is under way, so a foreign key
-- cannot say this and the old conflation could be recreated one row at a
-- time: a student "enrolled in" a regional fair, or a project "entered into"
-- a class (22.5).

\set QUIET on
select id as a_cohort from public.programs where slug = 'irpd-2027' \gset
select id as a_fair   from public.programs where slug = 'fair-2027' \gset
\set QUIET off

update public.programs set program_role = 'cohort'      where id = :'a_cohort';
update public.programs set program_role = 'opportunity' where id = :'a_fair';

/* psql substitutes `:'name'` before the server sees it, so the ids are
   formatted into the block rather than read back out of a setting. */
select format($fmt$
do $body$
declare
  v_org uuid;
  v_who uuid;
begin
  select org_id into v_org from public.programs limit 1;
  select id into v_who from public.users limit 1;

  insert into public.memberships (org_id, user_id, cohort_id)
  values (v_org, v_who, %L::uuid);

  raise notice '  ok   a person can join a cohort';

  begin
    insert into public.memberships (org_id, user_id, cohort_id)
    values (v_org, v_who, %L::uuid);

    raise exception 'FAIL a person was enrolled in a regional fair';
  exception when others then
    if sqlerrm like 'FAIL%%' then raise; end if;
    raise notice '  ok   and cannot be enrolled in an opportunity';
  end;
end $body$;
$fmt$, :'a_cohort', :'a_fair') \gexec

-- ── Joining is not entering ────────────────────────────────────────────────
--
-- `join_cohort` creates no project, which is the whole of the split:
-- `start_entry` had to invent one in order to have somewhere to hang an
-- enrolment, and that is how a class and a regional fair came to sit at one
-- level (22.1).

select format($fmt$
do $body$
declare
  v_before int;
  v_after  int;
begin
  perform set_config('request.jwt.claim.sub', %L, true);

  select count(*) into v_before from public.projects;
  perform public.join_cohort(%L::uuid);
  select count(*) into v_after from public.projects;

  if v_after <> v_before then
    raise exception 'FAIL joining a cohort invented %% projects', v_after - v_before;
  end if;

  raise notice '  ok   joining a cohort creates no project';

  if not exists (
    select 1 from public.memberships
     where user_id = %L::uuid and cohort_id = %L::uuid
  ) then
    raise exception 'FAIL joining recorded no membership';
  end if;

  raise notice '  ok   and does record a membership';
end $body$;
$fmt$, :'author', :'a_cohort', :'author', :'a_cohort') \gexec

-- And a project can be started with no program in sight, which is the solo
-- path and the reason `independent-research` could be deleted (22.10).
select format($fmt$
do $body$
declare
  v_project uuid;
  v_process text;
begin
  perform set_config('request.jwt.claim.sub', %L, true);

  v_project := public.start_project('A project with no cohort', null, null);

  select process_id into v_process from public.projects where id = v_project;

  if v_process is null then
    raise exception 'FAIL a solo project has no process, so it has no calendar';
  end if;

  if exists (select 1 from public.participations where project_id = v_project) then
    raise exception 'FAIL a project with no cohort was given one';
  end if;

  raise notice '  ok   a project can be started with no cohort, and still has a process';
end $body$;
$fmt$, :'author') \gexec

-- ── One piece of work, several outcomes ────────────────────────────────────
--
-- A project record used to name only the project, and a second was refused
-- outright. One piece of work goes to Synopsys, MTFC and Genius Olympiad in
-- different forms, and advancing from SCVSEFA to CSEF is a second entry with
-- its own judging. Each is its own outcome and its own record (22.8).

select format($fmt$
do $body$
declare
  v_org     uuid;
  v_project uuid;
  v_a       uuid;
  v_b       uuid;
begin
  select org_id into v_org from public.projects limit 1;
  select id into v_project from public.projects limit 1;

  /* Two participations of one project, each with a result. */
  insert into public.participations (org_id, project_id, program_id, status, result_recorded_at)
  values (v_org, v_project, %L::uuid, 'competed', now())
  on conflict do nothing
  returning id into v_a;

  if v_a is null then
    select id into v_a from public.participations
     where project_id = v_project and result_recorded_at is not null limit 1;
  end if;

  if v_a is null then
    raise exception 'FAIL could not make a participation with a result';
  end if;

  /* Direct inserts, deliberately: what is being checked here is that the
     *table* permits a record per participation. Whether the function that
     mints one enforces the same rule is checked below, by calling it. */
  insert into public.records
    (id, org_id, record_kind, project_id, participation_id, slug, year, title,
     discipline, published_on, date_precision, source, reviewed, body_format, license)
  values ('TEST-2027-0001', v_org, 'project', v_project, v_a, 'a', 2027, 'A',
          'other', current_date, 'day', 'workbench', false, 'none', 'cc-by-4.0');

  /* Through the view, not the table. "Any other participation of this
     project" was safe while `entries` held only entries; post-merge it can
     return the IRPD row, and a record does not come out of a class. This is
     the 22.5 cost showing up in the first query that reads the table raw. */
  select id into v_b from public.opportunity_participations
   where project_id = v_project and id <> v_a limit 1;

  if v_b is not null then
    insert into public.records
      (id, org_id, record_kind, project_id, participation_id, slug, year, title,
       discipline, published_on, date_precision, source, reviewed, body_format, license)
    values ('TEST-2027-0002', v_org, 'project', v_project, v_b, 'b', 2027, 'B',
            'other', current_date, 'day', 'workbench', false, 'none', 'cc-by-4.0');

    raise notice '  ok   one project can carry a record per participation';
  else
    raise notice '  ok   a record names the participation it came from';
  end if;
end $body$;
$fmt$, :'a_fair') \gexec

-- And the function that mints an identifier holds the same rule. Inserting
-- rows by hand proves the table allows it; only calling `generate_project_record`
-- twice proves the guard inside it counts entries rather than projects.
select format($fmt$
do $body$
declare
  v_project uuid;
  v_first   text;
begin
  perform set_config('request.jwt.claim.sub', %L, true);

  select r.project_id into v_project
    from public.records r where r.id = 'TEST-2027-0001';

  begin
    v_first := public.generate_project_record(v_project, 'again', 'TEST', null, %L::uuid);
    raise exception 'FAIL a second identifier was minted for one participation';
  exception when others then
    if sqlerrm like 'FAIL%%' then raise; end if;

    /* The refusal has to be the *right* refusal. Without this the check
       passes on `not authenticated`, which is what it did the first time it
       was written: the call never reached the guard, and a broken guard
       would have looked exactly like a working one. */
    if sqlerrm not like '%%already has a record%%' then
      raise exception 'FAIL refused for the wrong reason: %%', sqlerrm;
    end if;

    raise notice '  ok   and the same participation cannot be minted twice';
  end;
end $body$;
$fmt$, :'officer', (select participation_id from public.records where id = 'TEST-2027-0001')) \gexec

-- ── This is my IRPD project ────────────────────────────────────────────────
--
-- The third relationship, and the two rules that make it worth having: a
-- project belongs to a cohort somebody is actually in, and belonging is a
-- fact about the project rather than something read off its authors (22.5).

select format($fmt$
do $body$
declare
  v_project uuid;
begin
  perform set_config('request.jwt.claim.sub', %L, true);

  select p.id into v_project
    from public.projects p
    join public.project_authors a on a.project_id = p.id and a.user_id = %L::uuid
   limit 1;

  if v_project is null then
    raise exception 'FAIL that fixture authors nothing, so this checks nothing';
  end if;

  /* Not a member, so claiming the project for it is refused. Without this a
     student could put work into a class they never joined, and the roster is
     what a teacher reads. */
  delete from public.memberships
   where user_id = %L::uuid and cohort_id = %L::uuid;

  begin
    perform public.set_project_cohort(v_project, %L::uuid, true);
    raise exception 'FAIL a project was put in a cohort nobody had joined';
  exception when others then
    if sqlerrm like 'FAIL%%' then raise; end if;
    if sqlerrm not like '%%join that first%%' then
      raise exception 'FAIL refused for the wrong reason: %%', sqlerrm;
    end if;
    raise notice '  ok   a project cannot be put in a cohort nobody joined';
  end;

  /* Joining a cohort that decides leaves you *requested*, not a member, and
     a project belongs to a cohort you are actually in. Granting the place is
     the teacher's act; this stands in for it. */
  perform public.join_cohort(%L::uuid);

  update public.memberships set state = 'member'
   where user_id = %L::uuid and cohort_id = %L::uuid;

  perform public.set_project_cohort(v_project, %L::uuid, true);

  if not exists (
    select 1 from public.participations
     where project_id = v_project and program_id = %L::uuid
  ) then
    raise exception 'FAIL joining then claiming recorded nothing';
  end if;

  raise notice '  ok   and can once they are in it';

  perform public.set_project_cohort(v_project, %L::uuid, false);

  if exists (
    select 1 from public.participations
     where project_id = v_project and program_id = %L::uuid
  ) then
    raise exception 'FAIL taking it out left it in';
  end if;

  raise notice '  ok   and can take it out again';
end $body$;
$fmt$, :'author', :'author', :'author', :'a_cohort', :'a_cohort', :'a_cohort',
      :'author', :'a_cohort', :'a_cohort', :'a_cohort', :'a_cohort',
      :'a_cohort', :'a_cohort') \gexec

-- ── Leaving a class that publishes dates ───────────────────────────────────
--
-- The assertion above passes on a cohort that publishes nothing, so nothing
-- was ever copied onto the participation and the delete had no children to
-- collide with. In the application every cohort has a calendar, and
-- `entry_milestones.participation_id` is `on delete restrict`, so leaving
-- failed on a constraint name the moment it was tried on real data.
--
-- Same shape as the four in 19.9: the check was real and the state it ran
-- against was thinner than the state it was standing in for. This one gives
-- the cohort dates first.

select format($fmt$
do $body$
declare
  v_org     uuid;
  v_project uuid;
  v_place   uuid;
  v_copied  int;
begin
  select org_id into v_org from public.programs where id = %L::uuid;

  insert into public.program_milestones (program_id, org_id, name, kind, due_on)
  values (%L::uuid, v_org, 'Research plan due', 'submission', '2027-02-01')
  on conflict do nothing;

  /* A derived obligation, to prove the marker survives the copy. It did not:
     `app.copy_milestones` was extracted from `enter_program` before
     `satisfied_by` existed and never learned the column, while
     `start_entry`'s own inline copy did -- so a sponsor could close an
     approval only for an entry made by the one path that creates a project
     and enters in a single act. Every class, and every entry made by adding
     an existing project, carried obligations nothing could ever satisfy. */
  insert into public.program_milestones (program_id, org_id, name, kind, due_on, satisfied_by)
  values (%L::uuid, v_org, 'Teacher approval', 'approval', '2027-01-15', 'sponsor')
  on conflict do nothing;

  perform set_config('request.jwt.claim.sub', %L, true);

  /* Started *in* the class, which is the path the picker now defaults to and
     the one that copied nothing. */
  v_project := public.start_project('Left and rejoined', null, %L::uuid);

  select pa.id into v_place from public.participations pa
   where pa.project_id = v_project and pa.program_id = %L::uuid;

  if v_place is null then
    raise exception 'FAIL starting a project in a cohort recorded no participation';
  end if;

  select count(*) into v_copied from public.entry_milestones
   where participation_id = v_place;

  if v_copied = 0 then
    raise exception 'FAIL a project started in a class got no calendar';
  end if;

  if not exists (
    select 1 from public.entry_milestones
     where participation_id = v_place and satisfied_by = 'sponsor'
  ) then
    raise exception
      'FAIL the copied calendar lost satisfied_by, so nothing can ever close it';
  end if;

  raise notice '  ok   a project started in a class carries the class calendar';
  raise notice '  ok   and the obligations that follow from a fact stay marked';

  perform public.set_project_cohort(v_project, %L::uuid, false);

  if exists (select 1 from public.participations where id = v_place) then
    raise exception 'FAIL leaving left the participation in place';
  end if;

  if exists (select 1 from public.entry_milestones where participation_id = v_place) then
    raise exception 'FAIL leaving left the copied dates behind';
  end if;

  raise notice '  ok   and can leave, taking the copies with it';

  /* Rejoining makes them again, which is what lets the copies be deleted
     without ceremony. */
  perform public.set_project_cohort(v_project, %L::uuid, true);

  select pa.id into v_place from public.participations pa
   where pa.project_id = v_project and pa.program_id = %L::uuid;

  if (select count(*) from public.entry_milestones where participation_id = v_place) = 0 then
    raise exception 'FAIL rejoining did not restore the calendar';
  end if;

  raise notice '  ok   and rejoining makes them afresh';

  /* Evidence is refused rather than destroyed. A sponsor is a teacher's
     signature and leaving must not silently take it with it. */
  perform public.record_sponsor(v_place, 'K. Gupta', 'kgupta@fuhsd.org', '2026-09-01');

  begin
    perform public.set_project_cohort(v_project, %L::uuid, false);
    raise exception 'FAIL leaving deleted a recorded sponsor';
  exception when others then
    if sqlerrm like 'FAIL%%' then raise; end if;
    if sqlerrm not like '%%sponsoring this project here%%' then
      raise exception 'FAIL refused for the wrong reason: %%', sqlerrm;
    end if;
    raise notice '  ok   and refuses while a sponsor is recorded, in words';
  end;
end $body$;
$fmt$, :'a_cohort', :'a_cohort', :'a_cohort', :'author', :'a_cohort',
      :'a_cohort', :'a_cohort', :'a_cohort', :'a_cohort', :'a_cohort') \gexec

-- ── An entry records the cohort it went through ────────────────────────────
--
-- A second cohort, so that "exactly one prepares for it" has something to be
-- exactly one of. The fixture school runs one class and one fair; a school
-- running two clubs for the same fair is the case the rule declines to guess
-- in, and it cannot be tested without the second club existing.

insert into public.programs
  (org_id, slug, name, season_year, family, kind, current, source, status, program_role)
values
  ('11111111-1111-1111-1111-111111111111', 'club-2027', 'Club 2027', 2027,
   'scvsefa', 'competition', true, 'external', 'open', 'cohort')
on conflict do nothing;

\set QUIET on
select id as second_cohort from public.programs where slug = 'club-2027' \gset
\set QUIET off
--
-- 22.16 gave `participations` a `via_id` and nothing but the seed had ever
-- written one, so the officer word, the selection cap and the school's own
-- layer of dates could not resolve for anything a real person made.
--
-- The question `enter_program` asks is narrow on purpose: not which cohorts
-- this student is in, but which of *this project's* cohorts prepares for
-- *this* opportunity. A student in the class and the club, entering the fair
-- the club prepares for, has one answer while being in two cohorts.

select format($fmt$
do $body$
declare
  v_project uuid;
  v_place   uuid;
  v_via     uuid;
  v_entry   uuid;
begin
  perform set_config('request.jwt.claim.sub', %L, true);

  /* The class prepares for nothing; it is the other cohort that does. */
  update public.programs set prepares_for = %L::uuid where id = %L::uuid;

  v_project := public.start_project('Entered through the club', null, %L::uuid);

  select pa.id into v_place from public.participations pa
   where pa.project_id = v_project and pa.program_id = %L::uuid;

  v_entry := public.enter_program(v_project, %L::uuid);

  select via_id into v_via from public.participations where id = v_entry;

  if v_via is null then
    raise exception 'FAIL the entry did not record the cohort it went through';
  end if;

  if v_via is distinct from v_place then
    raise exception 'FAIL the entry named the wrong cohort';
  end if;

  raise notice '  ok   an entry records the cohort it was made through';

  /* And declines to guess. A second cohort preparing for the same fair is a
     school running two clubs for it, and either answer would put a project on
     a roster somebody has to answer for. */
  update public.participations set via_id = null where id = v_entry;
  update public.programs set prepares_for = %L::uuid where id = %L::uuid;
  insert into public.participations (org_id, project_id, program_id)
  select org_id, v_project, %L::uuid from public.projects where id = v_project
  on conflict do nothing;

  perform public.enter_program(v_project, %L::uuid);
  select via_id into v_via from public.participations where id = v_entry;

  if v_via is not null then
    raise exception 'FAIL two cohorts prepare for it and one was chosen anyway';
  end if;

  raise notice '  ok   and leaves it unanswered where two cohorts prepare for it';
end $body$;
$fmt$, :'author', :'a_fair', :'a_cohort', :'a_cohort', :'a_cohort', :'a_fair',
      :'a_fair', :'second_cohort', :'second_cohort', :'a_fair') \gexec

-- ── A deliverable recorded twice replaces the first ────────────────────────
--
-- `record_deliverable` inserted unconditionally, and the only thing stopping
-- two live rows for one obligation was the page hiding the form once anything
-- existed. A protection that lives in the markup ends the moment the markup
-- moves — which is what putting the form on the deadline row does.
--
-- Correcting a record is ordinary: a link recorded, then the finished
-- document; a form signed again after the first was refused. So the earlier
-- row is kept and marked, as a sponsor is (22.18), and the date it carried
-- stays readable because `checkDateOrder` reads dates against signatures.

select format($fmt$
do $body$
declare
  v_place uuid;
  v_first uuid;
  v_second uuid;
  v_live  int;
begin
  /* A place on a project this person actually authors, since only an author
     may record against it. */
  perform set_config('request.jwt.claim.sub', %L, true);

  select pa.id into v_place
    from public.participations pa
    join public.project_authors a
      on a.project_id = pa.project_id and a.user_id = %L::uuid and a.role = 'author'
   where pa.program_id = %L::uuid
   limit 1;

  if v_place is null then
    raise exception 'FAIL the fixture has no place for this author';
  end if;

  delete from public.deliverables where participation_id = v_place and type = 'research_plan';

  v_first := public.record_deliverable(
    v_place, null, 'research_plan', 'Project plan', '2026-10-01',
    'https://example.invalid/draft');

  v_second := public.record_deliverable(
    v_place, null, 'research_plan', 'Project plan', '2026-10-06',
    'https://example.invalid/final');

  select count(*) into v_live from public.deliverables
   where participation_id = v_place and type = 'research_plan'
     and superseded_at is null;

  if v_live <> 1 then
    raise exception 'FAIL %% live rows for one obligation', v_live;
  end if;

  raise notice '  ok   recording the same thing twice leaves one current row';

  if not exists (
    select 1 from public.deliverables
     where id = v_first and superseded_at is not null and superseded_by = v_second
  ) then
    raise exception 'FAIL the replaced row does not point at what replaced it';
  end if;

  raise notice '  ok   and the one it replaced says so, with its own date kept';
end $body$;
$fmt$, :'author', :'author', :'a_cohort') \gexec

-- ── The class's Elder is not the club's officer ────────────────────────────
--
-- Oversight was project level, so one assignment covered every program the
-- project was in: the participation page named the same person in both, and
-- the queue counted the project as looked after the moment anybody took it,
-- leaving the other program with nobody while reporting it handled.
--
-- Same argument as 22.18 for sponsors, and now the same shape.

select format($fmt$
do $body$
declare
  v_project uuid;
  v_class   uuid;
  v_club    uuid;
begin
  perform set_config('request.jwt.claim.sub', %L, true);
  v_project := public.start_project('Looked after in two places', null, %L::uuid);

  select pa.id into v_class from public.participations pa
   where pa.project_id = v_project and pa.program_id = %L::uuid;

  insert into public.participations (org_id, project_id, program_id)
  select org_id, v_project, %L::uuid from public.projects where id = v_project
  returning id into v_club;

  /* The advisor assigns, because an author does not appoint the officer for
     their own project. */
  perform set_config('request.jwt.claim.sub', %L, true);

  perform public.assign_officer(v_class, %L::uuid);

  if not exists (
    select 1 from public.project_authors
     where participation_id = v_class and role = 'officer'
  ) then
    raise exception 'FAIL the class got no officer';
  end if;

  if exists (
    select 1 from public.project_authors
     where participation_id = v_club and role = 'officer'
  ) then
    raise exception 'FAIL assigning in the class also staffed the club';
  end if;

  raise notice '  ok   an officer is assigned to one place, not to the project';

  /* The same person may look after the same project in both, which is a
     different fact from one assignment covering both. */
  perform public.assign_officer(v_club, %L::uuid);

  if (select count(*) from public.project_authors
       where project_id = v_project and role = 'officer') <> 2 then
    raise exception 'FAIL one person could not hold two places on one project';
  end if;

  raise notice '  ok   and the same person may hold two places, as two rows';

  /* Taking them off one leaves the other. */
  perform public.detach_from_project(v_club, %L::uuid);

  if not exists (
    select 1 from public.project_authors
     where participation_id = v_class and role = 'officer'
  ) then
    raise exception 'FAIL detaching from the club also detached from the class';
  end if;

  raise notice '  ok   and detaching from one leaves the other';
end $body$;
$fmt$, :'author', :'a_cohort', :'a_cohort', :'second_cohort',
      :'advisor', :'officer', :'officer', :'officer') \gexec

-- ── A class's showcase is for the class ────────────────────────────────────

select format($fmt$
do $body$
declare
  v_org  uuid;
  v_show uuid;
begin
  select org_id into v_org from public.programs limit 1;

  /* An opportunity open only to one cohort's members. */
  insert into public.programs (org_id, slug, name, season_year, kind, status, program_role, open_to_cohort)
  values (v_org, 'showcase-test', 'A showcase', 2027, 'showcase', 'open', 'opportunity', %L::uuid)
  returning id into v_show;

  perform set_config('request.jwt.claim.sub', %L, true);

  delete from public.memberships
   where user_id = %L::uuid and cohort_id = %L::uuid;

  begin
    perform public.start_entry(v_show, 'Something', null);
    raise exception 'FAIL somebody outside the class entered its showcase';
  exception when others then
    if sqlerrm like 'FAIL%%' then raise; end if;
    /* Matched on the part that tells the student what to do, not on the
       whole sentence: the gates moved into `app.entry_gate` and now name
       the class rather than saying "that class". */
    if sqlerrm not like '%%can enter its showcase%%' then
      raise exception 'FAIL refused for the wrong reason: %%', sqlerrm;
    end if;
    raise notice '  ok   only the class can enter its own showcase';
  end;
end $body$;
$fmt$, :'a_cohort', :'author', :'author', :'a_cohort') \gexec

-- ── A sponsor is named at one place, not at every place ────────────────────
--
-- 22.18: a student in the class, the club and a fair has three sponsors and
-- they are three different people. `sync_derived` once resolved the sponsor
-- as any current sponsor on any of the project's participations and wrote it
-- onto every obligation, so naming the teacher who runs the class closed the
-- fair's approval too -- and stamped it with a signature date the fair had
-- never been given. Nothing failed: `satisfied_by` appeared in no test and
-- `sponsor` in no assertion, so four green suites sat on top of it.
--
-- Asserted on the value rather than on an exception, because the wrong answer
-- here is a row quietly closing, which raises nothing.

\set QUIET on
select id as both_project from public.projects
 where title = 'In the fair and the course' \gset
select id as both_author  from public.users
 where display_name = 'Graduated officer' \gset
\set QUIET off

select format($fmt$
do $body$
declare
  v_org      uuid;
  v_course   uuid;
  v_fair     uuid;
  v_here     date;
  v_there    date;
begin
  select org_id into v_org from public.projects where id = %L::uuid;

  select pa.id into v_course from public.participations pa
    join public.programs p on p.id = pa.program_id
   where pa.project_id = %L::uuid and p.slug = 'irpd-2027';

  select pa.id into v_fair from public.participations pa
    join public.programs p on p.id = pa.program_id
   where pa.project_id = %L::uuid and p.slug = 'fair-2027';

  if v_course is null or v_fair is null then
    raise exception 'FAIL the fixture project is not in both places';
  end if;

  /* From nothing, so an earlier assertion's sponsor cannot decide this one. */
  delete from public.project_sponsors where participation_id in (v_course, v_fair);
  delete from public.entry_milestones
   where participation_id in (v_course, v_fair) and satisfied_by = 'sponsor';

  insert into public.entry_milestones
    (org_id, participation_id, name, kind, due_on, satisfied_by)
  values
    (v_org, v_course, 'Teacher approval',   'approval', '2027-01-15', 'sponsor'),
    (v_org, v_fair,   'Adult sponsor form', 'approval', '2027-02-01', 'sponsor');

  perform set_config('request.jwt.claim.sub', %L, true);
  perform public.record_sponsor(v_course, 'K. Gupta', 'kgupta@fuhsd.org', '2026-09-01');

  select completed_on into v_here  from public.entry_milestones
   where participation_id = v_course and satisfied_by = 'sponsor';
  select completed_on into v_there from public.entry_milestones
   where participation_id = v_fair   and satisfied_by = 'sponsor';

  if v_here is distinct from date '2026-09-01' then
    raise exception 'FAIL the sponsor did not close the obligation where it was named: %%',
      coalesce(v_here::text, 'null');
  end if;
  raise notice '  ok   a sponsor closes the approval at the place it was named';

  if v_there is not null then
    raise exception
      'FAIL naming the class sponsor closed the fair approval too, as of %%', v_there;
  end if;
  raise notice '  ok   and leaves the other place waiting on its own teacher';

  /* The consequence that matters. `checkDateOrder` reads signed_on or
     completed_on per obligation, so a borrowed date reads as a sponsor found
     before work began and suppresses the disqualifying finding. */
  if exists (
    select 1 from public.project_sponsors s where s.participation_id = v_fair
  ) then
    raise exception 'FAIL a sponsor row appeared at a place nobody signed for';
  end if;
  raise notice '  ok   and records no sponsor there';
end $body$;
$fmt$, :'both_project', :'both_project', :'both_project', :'both_author') \gexec


-- ---------------------------------------------------------------------------
-- A reservation can be claimed by the person it names.
--
-- `user_roles_no_self_grant` refuses a row whose `user_id` is `auth.uid()`,
-- and a claimed reservation is exactly that: the person signing in receives
-- the role somebody reserved for them. The guard names two legitimate
-- exceptions in its own comment; this was the third and was missed, so **no
-- reservation could ever be claimed**. It surfaced on the finish signing up
-- screen as `a role may not be granted to yourself`, which reads as though
-- the person had done something wrong.
--
-- Asserted as the claiming user rather than as the owner, because that is the
-- whole of the bug: as `postgres` the guard returns early and the broken
-- version passes. Three attempts at this proof went green against the
-- unfixed function before the impersonation was right — `set local` outside a
-- transaction is a no-op, and `request.jwt.claims` is not the setting
-- `auth.uid()` reads.
-- ---------------------------------------------------------------------------

\echo ''
\echo '── Claiming a reservation'

do $body$
declare
  v_org  uuid;
  v_user uuid := '9f000000-0000-4000-8000-00000000c1a1';
  v_n    int;
begin
  select id into v_org from public.organizations limit 1;

  insert into auth.users (id, email) values (v_user, 'reserved@demo.invalid');

  insert into public.users (id, org_id, display_name, population, status,
    affiliation_state, consent_state, age_band)
  values (v_user, v_org, 'Reserved Person', 'staff', 'active',
    'domain_verified', 'not_required', '18_plus');

  insert into public.role_reservations (org_id, email, display_name, role)
  values (v_org, 'reserved@demo.invalid', 'Reserved Person', 'advisor');

  /* As the person themselves. The guard compares against `auth.uid()`, so
     running this as the owner would prove nothing. */
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('role', 'authenticated', true);

  v_n := app.claim_reservations(v_user, 'reserved@demo.invalid');

  perform set_config('role', 'postgres', true);

  if v_n <> 1 then
    raise exception 'FAIL the reservation was not claimed (%)', v_n;
  end if;
  raise notice '  ok   the person it names may claim it';

  if not exists (
    select 1 from public.user_roles
     where user_id = v_user and role = 'advisor' and revoked_at is null
  ) then
    raise exception 'FAIL claimed, but no role was granted';
  end if;
  raise notice '  ok   and the role is granted';

  if exists (
    select 1 from public.role_reservations
     where lower(email) = 'reserved@demo.invalid' and claimed_at is null
  ) then
    raise exception 'FAIL the reservation still reads as unclaimed';
  end if;
  raise notice '  ok   and the reservation is marked claimed';
exception when others then
  perform set_config('role', 'postgres', true);
  raise;
end $body$;


\echo ''
\echo '── Deleting an account'

do $body$
declare
  v_org    uuid;
  v_solo   uuid := '9f000000-0000-4000-8000-0000000d0001';
  v_a      uuid := '9f000000-0000-4000-8000-0000000d0002';
  v_b      uuid := '9f000000-0000-4000-8000-0000000d0003';
  v_alone  uuid;
  v_shared uuid;
  v_note   uuid;
  v_out    jsonb;
begin
  select id into v_org from public.organizations limit 1;

  insert into auth.users (id, email) values
    (v_solo, 'leaver@demo.invalid'), (v_a, 'stays@demo.invalid'), (v_b, 'partner@demo.invalid');

  insert into public.users (id, org_id, display_name, population, status,
    affiliation_state, consent_state, age_band)
  values
    (v_solo, v_org, 'Leaver', 'student', 'active', 'domain_verified', 'not_required', '18_plus'),
    (v_a,    v_org, 'Stays',  'student', 'active', 'domain_verified', 'not_required', '18_plus'),
    (v_b,    v_org, 'Partner','student', 'active', 'domain_verified', 'not_required', '18_plus');

  /* One project of their own, and one shared with somebody who is staying. */
  insert into public.projects (id, org_id, title, created_by)
  values (gen_random_uuid(), v_org, 'Alone', v_solo) returning id into v_alone;

  insert into public.projects (id, org_id, title, created_by)
  values (gen_random_uuid(), v_org, 'Shared', v_solo) returning id into v_shared;

  insert into public.project_authors (org_id, project_id, user_id, role, accepted_at)
  values (v_org, v_alone,  v_solo, 'author', now()),
         (v_org, v_shared, v_solo, 'author', now()),
         (v_org, v_shared, v_b,    'author', now() + interval '1 day');

  /* A note of their own on each, and one left on somebody else's project. */
  insert into public.field_notes (org_id, project_id, author_id, seq, occurred_on, body_md)
  values (v_org, v_alone,  v_solo, 1, current_date, 'mine'),
         (v_org, v_shared, v_solo, 2, current_date, 'ours');

  insert into public.project_links (org_id, project_id, added_by, url, label)
  values (v_org, v_shared, v_solo, 'https://example.org/x', 'A link');

  /* A photograph on a note. `note_media` points at `field_notes` with
     `restrict`, so this is what proves the notes can actually be deleted —
     the first version of the function omitted the table and the test passed
     because there were no photographs in it. */
  select id into v_note from public.field_notes
   where author_id = v_solo and project_id = v_alone;

  insert into public.note_media (org_id, note_id, storage_path, caption)
  values (v_org, v_note, 'notes/one.jpg', 'A gel');

  v_out := public.delete_account(v_solo);

  -- ── The person is gone ──────────────────────────────────────────────────
  if exists (select 1 from public.users where id = v_solo) then
    raise exception 'FAIL the account still exists';
  end if;
  raise notice '  ok   the account is gone';

  if exists (select 1 from public.field_notes where author_id = v_solo) then
    raise exception 'FAIL their notebook entries survived';
  end if;
  raise notice '  ok   and every entry they wrote, on any project';

  -- ── A project only theirs goes entirely ─────────────────────────────────
  if exists (select 1 from public.projects where id = v_alone) then
    raise exception 'FAIL a project with no other author survived';
  end if;
  raise notice '  ok   a project that was only theirs is deleted';

  -- ── A shared project survives, and belongs to whoever is left ───────────
  if not exists (select 1 from public.projects where id = v_shared) then
    raise exception 'FAIL a co-authored project was deleted with one author';
  end if;
  raise notice '  ok   a co-authored project survives';

  if (select created_by from public.projects where id = v_shared) <> v_b then
    raise exception 'FAIL the surviving project is still attributed to the leaver';
  end if;
  raise notice '  ok   and is attributed to the author who remains';

  if (select added_by from public.project_links where project_id = v_shared) <> v_b then
    raise exception 'FAIL a not-null attribution still points at a deleted user';
  end if;
  raise notice '  ok   as is everything not-null they left on it';

  if exists (
    select 1 from public.project_authors
     where project_id = v_shared and user_id = v_solo
  ) then
    raise exception 'FAIL they are still listed as an author';
  end if;
  raise notice '  ok   and their name is off it';

  if (v_out->>'projects')::int <> 1 or (v_out->>'left')::int <> 1 then
    raise exception 'FAIL the receipt is wrong: %', v_out;
  end if;
  raise notice '  ok   the receipt counts the work';

  /* The bucket is not reachable from SQL. If these paths are not handed back
     the files stay in R2 with nothing pointing at them, which is the failure
     the legal review names and which no amount of passing SQL would show. */
  if not (v_out->'files' @> '["notes/one.jpg"]'::jsonb) then
    raise exception 'FAIL the orphaned files were not handed back: %', v_out->'files';
  end if;
  raise notice '  ok   and hands back every file left with nothing pointing at it';
exception when others then
  perform set_config('role', 'postgres', true);
  raise;
end $body$;


\echo ''
\echo '── Draining the outbox'

do $body$
declare
  v_org   uuid;
  v_user  uuid := '9f000000-0000-4000-8000-0000000e0001';
  v_fresh uuid;
  v_old   uuid;
  v_n     int;
  v_addr  text;
  v_token uuid;
  v_row   record;
begin
  select id into v_org from public.organizations limit 1;

  insert into auth.users (id, email) values (v_user, 'hears@demo.invalid');
  insert into public.users (id, org_id, display_name, population, status,
    affiliation_state, consent_state, age_band)
  values (v_user, v_org, 'Hears Things', 'student', 'active',
    'domain_verified', 'not_required', '18_plus');

  insert into public.identities (org_id, user_id, auth_identity_id, provider,
    subject, email, is_primary)
  values (v_org, v_user, gen_random_uuid(), 'email', 'sub-e1',
    'hears@demo.invalid', true);

  insert into public.notifications (org_id, kind, recipient_id, payload, dedupe_key)
  values (v_org, 'record_published', v_user, '{"title":"A paper"}', 'k:fresh')
  returning id into v_fresh;

  insert into public.notifications (org_id, kind, recipient_id, payload, dedupe_key, created_at)
  values (v_org, 'record_published', v_user, '{}', 'k:old', now() - interval '3 days')
  returning id into v_old;

  /* Scoped to this recipient. Earlier assertions in this file enqueue their
     own messages, and counting every pending row here would make this test
     depend on how many of those there happen to be. */
  select count(*) into v_n from public.claim_notifications(50, 60, false) c
   where c.to_email = 'hears@demo.invalid';
  if v_n <> 2 then raise exception 'FAIL claimed % of theirs, expected 2', v_n; end if;
  raise notice '  ok   both of theirs are claimed in one pass';


  -- ── The window ───────────────────────────────────────────────────────────
  if (select state from public.notifications where id = v_old) <> 'skipped' then
    raise exception 'FAIL a message from three days ago was not skipped';
  end if;
  raise notice '  ok   anything older than the window is skipped, not sent';

  if (select state from public.notifications where id = v_fresh) <> 'processing' then
    raise exception 'FAIL a claimed message was left pending: %',
      (select state from public.notifications where id = v_fresh);
  end if;
  raise notice '  ok   and a fresh one is held as processing, not left pending';

  /* The whole point. `for update skip locked` ends with the claiming
     transaction, so a row handed back still `pending` is a row the next
     drain will take and send again. */
  if exists (
    select 1 from public.claim_notifications(50, 60, false) c
     where c.to_email = 'hears@demo.invalid'
  ) then
    raise exception 'FAIL a second drain claimed a message the first is still sending';
  end if;
  raise notice '  ok   and a second drain cannot claim it';

  -- ── A lease that has run out is recovered ────────────────────────────────
  update public.notifications
     set claimed_until = now() - interval '1 minute'
   where id = v_fresh;

  if not exists (
    select 1 from public.claim_notifications(50, 60, false) c
     where c.to_email = 'hears@demo.invalid'
  ) then
    raise exception 'FAIL an expired lease was never recovered';
  end if;
  raise notice '  ok   an expired lease is recovered rather than stranded';

  -- ── Claiming does not hand the same row out twice ────────────────────────
  /* Settling requires the token the claim handed out. A stale drain coming
     back after its lease was recovered must not be able to mark as sent a
     message somebody else is sending. */
  if public.settle_notification(v_fresh, gen_random_uuid(), 'sent', null) then
    raise exception 'FAIL a message was settled with the wrong claim token';
  end if;
  raise notice '  ok   settling with the wrong token changes nothing';

  select claim_token into v_token from public.notifications where id = v_fresh;
  if not public.settle_notification(v_fresh, v_token, 'sent', null) then
    raise exception 'FAIL settling with the right token did nothing';
  end if;

  select count(*) into v_n from public.claim_notifications(50, 60, false) c
   where c.to_email = 'hears@demo.invalid';
  if v_n <> 0 then
    raise exception 'FAIL a settled message was claimed again (%)', v_n;
  end if;
  raise notice '  ok   a settled message is never claimed again';

  -- ── The address comes from the identity, not from the row ────────────────
  insert into public.notifications (org_id, kind, recipient_id, payload, dedupe_key)
  values (v_org, 'place_granted', v_user, '{}', 'k:addr');

  /* Filtered by recipient as well as kind. The first version matched only
     on kind and picked up another assertion's message, which has no identity
     and therefore no address — and reported that as this test failing. */
  select c.to_email into v_addr from public.claim_notifications(50, 60, true) c
   where c.kind = 'place_granted' and c.to_email = 'hears@demo.invalid' limit 1;
  if v_addr is distinct from 'hears@demo.invalid' then
    raise exception 'FAIL the address was % rather than the identity', coalesce(v_addr, 'nothing');
  end if;
  raise notice '  ok   the address is read from the identity at send time';

  /* And a recipient with no identity at all comes back with none, which the
     sender has to treat as a reason not to send rather than as an address.
     There are such rows in this database already. */
  if not exists (
    select 1 from public.claim_notifications(50, 60, true) c where c.to_email is null
  ) then
    raise notice '  ok   (no addressless recipients to check)';
  else
    raise notice '  ok   a recipient with no identity comes back with no address';
  end if;
exception when others then
  perform set_config('role', 'postgres', true);
  raise;
end $body$;


\echo ''
\echo '── Consent on every publication path'

do $body$
declare
  v_org     uuid := '11111111-1111-1111-1111-111111111111';
  v_minor   uuid := '9f000000-0000-4000-8000-0000000c0001';
  v_project uuid;
  v_record  text;
  v_ok      boolean := false;
begin
  /* An author on an existing project whose guardian has not confirmed.
     Added to a project that already publishes, so the only thing that
     changes between passing and failing is the consent. */
  /* As the advisor, who is an editor. `generate_project_record` calls
     `require_editor` before anything else, so running this as nobody would
     refuse with "not authenticated" and prove nothing about consent — which
     is exactly what the first version of this test did. */
  perform set_config('request.jwt.claim.sub',
    'a0000000-0000-0000-0000-000000000004', true);

  select r.project_id into v_project from public.records r where r.id = 'TEST-2027-0001';

  insert into auth.users (id, email) values (v_minor, 'minor@demo.invalid');
  insert into public.users (id, org_id, display_name, consent_state, age_band)
  values (v_minor, v_org, 'A minor', 'pending', '13_17');

  insert into public.project_authors (org_id, project_id, user_id, role, accepted_at)
  values (v_org, v_project, v_minor, 'author', now());

  -- ── Minting an identifier ────────────────────────────────────────────────
  begin
    perform public.generate_project_record(v_project, 'x', 'TEST', null, null);
    raise exception 'FAIL a record was minted for a project with an unconfirmed author';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%Guardian permission%' then
      raise exception 'FAIL refused for the wrong reason: %', sqlerrm;
    end if;
    v_ok := true;
  end;

  if not v_ok then raise exception 'FAIL no refusal at all'; end if;
  raise notice '  ok   an identifier is refused while a guardian has not confirmed';

  -- ── And again at the moment it goes public ───────────────────────────────
  --
  -- The record already exists, minted before the minor was added. Generation
  -- and going live are separate acts and a consent can be withdrawn between
  -- them, so a check only at the start is a check on the wrong moment.
  v_ok := false;
  begin
    perform public.mark_record_live('TEST-2027-0001');
    raise exception 'FAIL an existing record was made public with an unconfirmed author';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    if sqlerrm not like '%Guardian permission%' then
      raise exception 'FAIL live refused for the wrong reason: %', sqlerrm;
    end if;
    v_ok := true;
  end;

  if not v_ok then raise exception 'FAIL going live was not refused'; end if;
  raise notice '  ok   and going live is refused separately, not only generation';

  -- ── An invited author who has not accepted does not block anybody ────────
  update public.project_authors set accepted_at = null
   where project_id = v_project and user_id = v_minor;

  perform public.mark_record_live('TEST-2027-0001');
  raise notice '  ok   somebody invited and not yet accepted holds nothing up';

exception when others then
  perform set_config('role', 'postgres', true);
  raise;
end $body$;


\echo ''
\echo '── Asking co-authors before taking shared work'

do $body$
declare
  v_org  uuid := '11111111-1111-1111-1111-111111111111';
  v_a    uuid := '9f000000-0000-4000-8000-0000000e1001';
  v_b    uuid := '9f000000-0000-4000-8000-0000000e1002';
  v_proj uuid;
  v_del  uuid;
  v_ap   uuid;
  v_r    jsonb;
begin
  insert into auth.users (id, email) values
    (v_a, 'leaves@demo.invalid'), (v_b, 'stays2@demo.invalid');
  insert into public.users (id, org_id, display_name, consent_state) values
    (v_a, v_org, 'Leaves', 'not_required'),
    (v_b, v_org, 'Stays',  'not_required');

  insert into public.projects (org_id, title, created_by)
  values (v_org, 'Ours', v_a) returning id into v_proj;

  insert into public.project_authors (org_id, project_id, user_id, role, accepted_at)
  values (v_org, v_proj, v_a, 'author', now()),
         (v_org, v_proj, v_b, 'author', now());

  perform set_config('request.jwt.claim.sub', v_a::text, true);
  v_del := public.request_account_deletion('ask');

  select id into v_ap from public.account_deletion_approvals
   where deletion_id = v_del and approver_id = v_b;

  if v_ap is null then raise exception 'FAIL the co-author was never asked'; end if;
  raise notice '  ok   every co-author of shared work is asked';

  v_r := public.deletion_ready();
  if (v_r->>'state') <> 'pending' or (v_r->>'waiting')::int <> 1 then
    raise exception 'FAIL readiness said % while somebody had not answered', v_r;
  end if;
  raise notice '  ok   and the request is not ready while one is outstanding';

  -- ── Not yours to answer ─────────────────────────────────────────────────
  begin
    perform public.answer_deletion_approval(v_ap, true);
    raise exception 'FAIL the person leaving approved their own request';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice '  ok   the person leaving cannot answer on the co-author''s behalf';

  -- ── A decline does not trap them ────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', v_b::text, true);
  perform public.answer_deletion_approval(v_ap, false);

  perform set_config('request.jwt.claim.sub', v_a::text, true);
  v_r := public.deletion_ready();

  if (v_r->>'state') <> 'refused' then
    raise exception 'FAIL a decline left the request at %', v_r->>'state';
  end if;
  if (v_r->>'intent') <> 'leave' then
    raise exception 'FAIL a decline did not fall back to leaving';
  end if;
  raise notice '  ok   a decline means they leave and the work stays, not that they are stuck';

  -- ── Nobody to ask ───────────────────────────────────────────────────────
  delete from public.project_authors where project_id = v_proj and user_id = v_b;
  delete from public.account_deletions where user_id = v_a;

  v_del := public.request_account_deletion('ask');
  v_r := public.deletion_ready();

  if (v_r->>'state') <> 'ready' then
    raise exception 'FAIL somebody with nothing shared was made to wait: %', v_r;
  end if;
  raise notice '  ok   somebody with nothing shared waits for nobody';
exception when others then
  perform set_config('role', 'postgres', true);
  raise;
end $body$;

-- ── An officer may take their own project, and may not hand it to a friend ──
--
-- 22.x: the rule is about choosing a supervisor, and there is no choosing
-- when the answer is you. Read against a real database because it is one
-- SECURITY DEFINER function reading `auth.uid()` three different ways.
do $body$
declare
  v_org   uuid;
  v_prog  uuid;
  v_p1    uuid := gen_random_uuid();
  v_part  uuid := gen_random_uuid();
  v_off   uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_n     int;
begin
  select o.id into v_org from public.organizations o where o.slug = 'mv';
  select p.id into v_prog from public.programs p
   where p.org_id = v_org and p.program_role = 'opportunity' limit 1;

  insert into auth.users (id) values (v_off), (v_other);
  insert into public.users (id, org_id, display_name, consent_state)
  values (v_off, v_org, 'Officer Author', 'not_required'),
         (v_other, v_org, 'Another Officer', 'not_required');

  insert into public.user_roles (org_id, user_id, role, scope_id)
  values (v_org, v_off, 'officer', v_prog), (v_org, v_other, 'officer', v_prog);

  insert into public.projects (id, org_id, title, created_by)
  values (v_p1, v_org, 'A project its officer wrote', v_off);

  insert into public.project_authors (org_id, project_id, user_id, role)
  values (v_org, v_p1, v_off, 'author');

  insert into public.participations (id, org_id, project_id, program_id)
  values (v_part, v_org, v_p1, v_prog);

  perform set_config('request.jwt.claim.sub', v_off::text, true);

  -- Handing it to a colleague is still refused.
  begin
    perform public.assign_officer(v_part, v_other);
    raise exception 'FAIL an author chose somebody else to oversee their own project';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice '  ok   an author cannot choose somebody else to oversee their own work';

  -- Taking it themselves is allowed, and is recorded as self managed.
  perform public.assign_officer(v_part, v_off);

  select count(*) into v_n from public.project_authors a
   where a.participation_id = v_part and a.user_id = v_off and a.role = 'officer';
  if v_n <> 1 then raise exception 'FAIL an officer could not take their own project'; end if;
  raise notice '  ok   and may take it themselves, which is the ordinary club case';

  select count(*) into v_n from public.project_authors a
   where a.participation_id = v_part and a.user_id = v_off
     and a.role = 'officer' and a.self_managed_at is not null;
  if v_n <> 1 then raise exception 'FAIL taking your own project was not marked self managed'; end if;
  raise notice '  ok   and the row says self managed, so nothing is concealed';

  perform set_config('request.jwt.claim.sub', '', true);
end
$body$;


-- ===========================================================================
-- THE BACK CATALOGUE
--
-- `generate_migrated_record` is the third publishing path and the only one
-- whose bylines belong to people the system has never met. What has to hold
-- is that it allocates like the other two, that re-running the loader is not
-- re-publishing, and that it never quietly invents an account for somebody
-- who graduated in 2021.
--
-- Read against a real database because the whole of it is a SECURITY DEFINER
-- function, a sequence taken under a row lock, and a foreign key.
-- ===========================================================================

do $body$
declare
  v_org  uuid;
  v1     text;
  v2     text;
  v3     text;
  v_n    int;
begin
  select o.id into v_org from public.organizations o where o.slug = 'mv';

  v1 := public.generate_migrated_record(
    'mv', 'MVRJ', 'looping-and-divergence-in-the-collatz-conjecture',
    'Looping and Divergence in the Collatz Conjecture',
    '[{"name":"Jai Sharma","school":"Monta Vista High School"},
      {"name":"Akshat Jha","school":"Monta Vista High School"},
      {"name":"Sambhabi Bose","school":"Monta Vista High School"},
      {"name":"Garrett Heller","school":"Monta Vista High School"}]'::jsonb,
    date '2020-10-01', 'month', null,
    array['Collatz conjecture', 'number theory', 'iteration'], 'mathematics');

  if v1 <> 'MVRJ-2020-0001' then
    raise exception 'FAIL the first 2020 identifier is %', v1;
  end if;
  raise notice '  ok   the sequence runs per organization per year';

  -- The year is the paper's own, never the year the loader ran.
  if (select r.year from public.records r where r.id = v1) <> 2020 then
    raise exception 'FAIL a 2020 paper was filed under another year';
  end if;
  raise notice '  ok   a 2020 paper is filed under 2020';

  select count(*) into v_n from public.record_authors where record_id = v1;
  if v_n <> 4 then
    raise exception 'FAIL % authors on the byline, expected 4', v_n;
  end if;

  if exists (select 1 from public.record_authors
              where record_id = v1 and user_id is not null) then
    raise exception 'FAIL an author was given an account they do not have';
  end if;
  raise notice '  ok   the byline is frozen with no accounts behind it';

  /* **Re-running the loader is not re-publishing.**
  
     `generate_record` appends `-2` to a colliding slug, which is right for
     two different papers with one title and wrong for a seed that runs on
     every reset: it would mint a second permanent identifier for the same
     article and leave the first stranded in the manifest. */
  v2 := public.generate_migrated_record(
    'mv', 'MVRJ', 'looping-and-divergence-in-the-collatz-conjecture',
    'Looping and Divergence in the Collatz Conjecture',
    '[{"name":"Jai Sharma"}]'::jsonb, date '2020-10-01', 'month', null,
    '{}', 'mathematics');

  if v2 <> v1 then
    raise exception 'FAIL a second run allocated %', v2;
  end if;

  select count(*) into v_n from public.records r
   where r.org_id = v_org and r.slug = 'looping-and-divergence-in-the-collatz-conjecture';
  if v_n <> 1 then
    raise exception 'FAIL % rows at one address', v_n;
  end if;
  raise notice '  ok   running it twice returns the identifier already allocated';

  v3 := public.generate_migrated_record(
    'mv', 'MVRJ', 'a-second-paper-that-year', 'A Second Paper That Year',
    '[{"name":"Somebody Else"}]'::jsonb, date '2020-12-01', 'month',
    'An abstract long enough to be one.', array['a', 'b', 'c'], 'physics');

  if v3 <> 'MVRJ-2020-0002' then
    raise exception 'FAIL the next paper took %', v3;
  end if;
  raise notice '  ok   and a different paper still takes the next number';

  -- Two steps, and the first one does not make anything live (8.6b).
  if (select r.confirmed_at from public.records r where r.id = v1) is not null then
    raise exception 'FAIL allocation marked the record live';
  end if;

  perform public.confirm_migrated_record(v1);

  if (select r.confirmed_at from public.records r where r.id = v1) is null then
    raise exception 'FAIL confirming changed nothing';
  end if;
  raise notice '  ok   allocation and going live are separate acts';

  -- The page must not claim a process the record never went through.
  if (select r.source from public.records r where r.id = v1) <> 'migrated'
     or (select r.reviewed from public.records r where r.id = v1) then
    raise exception 'FAIL a migrated record claims a review it never had';
  end if;
  raise notice '  ok   a migrated record claims no review';

  -- The wrong door for a migrated record, said plainly.
  begin
    perform public.mark_record_live(v3);
    raise exception 'FAIL mark_record_live accepted a migrated record with no editor';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice '  ok   the editor path still refuses a caller with no session';

  begin
    perform public.confirm_migrated_record('MVRJ-2020-9999');
    raise exception 'FAIL an unknown record was confirmed';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice '  ok   an unknown record is refused';

  -- A record with nobody on it is not a record.
  begin
    perform public.generate_migrated_record(
      'mv', 'MVRJ', 'nobody-wrote-this', 'Nobody Wrote This',
      '[]'::jsonb, date '2021-01-01', 'month', null, '{}', 'physics');
    raise exception 'FAIL a record with no byline was accepted';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice '  ok   a record with no byline is refused';

  begin
    perform public.generate_migrated_record(
      'no-such-school', 'XX', 'somewhere-else', 'Somewhere Else',
      '[{"name":"A Person"}]'::jsonb, date '2021-01-01', 'month', null, '{}', 'physics');
    raise exception 'FAIL a record was filed against no school';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice '  ok   and a record for a school that does not exist is refused';

  /* 8.10: a co-author from outside the school gets a plain-text byline and no
     author page, and `byline_only` is the flag that says so. It has to survive
     the trip through jsonb or every migrated author looks like a local one. */
  perform public.generate_migrated_record(
    'mv', 'MVRJ', 'an-outside-collaboration', 'An Outside Collaboration',
    '[{"name":"Inside Person","school":"Monta Vista High School"},
      {"name":"Outside Person","byline_only":true}]'::jsonb,
    date '2021-02-01', 'month', 'An abstract long enough to be one.',
    array['a', 'b', 'c'], 'physics');

  select count(*) into v_n
    from public.record_authors ra
    join public.records r on r.id = ra.record_id
   where r.slug = 'an-outside-collaboration' and ra.byline_only;

  if v_n <> 1 then
    raise exception 'FAIL % byline-only authors, expected 1', v_n;
  end if;
  raise notice '  ok   a co-author from outside stays byline-only';
end
$body$;


-- ===========================================================================
-- GUARDIAN CONSENT
--
-- The one exchange with somebody who has no account, and the one credential
-- that arrives by email and authorises an action with no password behind it.
-- Read-only checks cannot reach any of it: the token is hashed, the answer
-- is a state machine, and the whole thing is SECURITY DEFINER.
--
-- These run against a real database because the alternative is finding out
-- from a parent.
-- ===========================================================================

do $body$
declare
  v_org     uuid;
  v_student uuid;
  v_consent uuid;
  v_hash    text;
  v_token   text;
  v_answer  text;
  v_n       int;
begin
  select org_id into v_org from public.users limit 1;

  /* The account row first. `public.users.id` references `auth.users`,
     so a person minted with `gen_random_uuid()` and no credential
     behind them is refused by the foreign key -- which is what
     stopped this whole section from ever running. Every other
     fixture in this file already does it in this order. */
  v_student := gen_random_uuid();
  insert into auth.users (id) values (v_student);

  insert into public.users (id, org_id, display_name, population, age_band,
                            consent_state, consent_requested_at)
  values (v_student, v_org, 'Consent fixture', 'student', '13_17',
          'pending', now());

  insert into public.guardian_consents (org_id, user_id, guardian_name, guardian_email)
  values (v_org, v_student, 'A Guardian', 'guardian@demo.invalid')
  returning id into v_consent;

  perform app.request_guardian_consent(v_consent);

  -- ── The outbox can address somebody with no account ────────────────────
  --
  -- This is the assertion the whole schema change exists for.
  -- `recipient_id` was `not null references users`, so this row could not be
  -- written at all and the consent email had a template and no way to be sent.
  select count(*) into v_n
    from public.notifications
   where subject_id = v_consent
     and kind = 'guardian_consent'
     and recipient_id is null
     and recipient_email = 'guardian@demo.invalid';

  if v_n <> 1 then
    raise exception 'FAIL the guardian message was not enqueued (% rows)', v_n;
  end if;
  raise notice '  ok   a message can be addressed to an address rather than an account';

  -- ── The link goes somewhere a guardian can use ─────────────────────────
  select payload->>'path' into v_token
    from public.notifications where subject_id = v_consent and kind = 'guardian_consent';

  if v_token is null or v_token not like '/consent/%' then
    raise exception 'FAIL the guardian was sent to % rather than a consent page', v_token;
  end if;
  raise notice '  ok   the link is the consent page, not the sign-in screen';

  v_token := replace(replace(v_token, '/consent/', ''), '/', '');

  -- ── Only the hash is stored ────────────────────────────────────────────
  select token_hash into v_hash
    from public.confirmation_tokens where subject_id = v_consent;

  if v_hash = v_token then
    raise exception 'FAIL the token itself is in the table';
  end if;
  if v_hash <> app.consent_token_hash(v_token) then
    raise exception 'FAIL the stored hash does not match the token that was sent';
  end if;
  raise notice '  ok   the table holds a hash and the plaintext exists only in the email';

  -- ── A wrong token says nothing ─────────────────────────────────────────
  select count(*) into v_n from public.guardian_consent_request('not-a-real-token');
  if v_n <> 0 then
    raise exception 'FAIL an unknown token returned a request';
  end if;

  if public.answer_guardian_consent('not-a-real-token', true) <> 'unavailable' then
    raise exception 'FAIL an unknown token was accepted';
  end if;
  raise notice '  ok   an unknown token is refused, and says only that';

  -- ── Approving ──────────────────────────────────────────────────────────
  v_answer := public.answer_guardian_consent(v_token, true);
  if v_answer <> 'approved' then
    raise exception 'FAIL approving returned %', v_answer;
  end if;

  select consent_state into v_answer from public.users where id = v_student;
  if v_answer <> 'active' then
    raise exception 'FAIL an approved account is at % rather than active', v_answer;
  end if;
  raise notice '  ok   approving opens the account';

  -- ── The token is spent ─────────────────────────────────────────────────
  --
  -- A link that still works after it has been answered is a link that can be
  -- replayed to reverse a decision.
  if (select consumed_at from public.confirmation_tokens where subject_id = v_consent) is null then
    raise exception 'FAIL the token was not consumed';
  end if;

  v_answer := public.answer_guardian_consent(v_token, false);
  if v_answer <> 'approved' then
    raise exception 'FAIL a spent token reversed the answer to %', v_answer;
  end if;
  raise notice '  ok   a spent link cannot reverse an answer, and reports what was decided';

  -- ── The student is told ────────────────────────────────────────────────
  select count(*) into v_n
    from public.notifications
   where recipient_id = v_student and kind = 'guardian_approved';
  if v_n <> 1 then
    raise exception 'FAIL the student was not told (% rows)', v_n;
  end if;
  raise notice '  ok   the student hears the answer from the outbox';

  -- ── Declining pauses, and does not close ───────────────────────────────
  --
  -- `closed` is the irreversible state and it does not belong behind a link
  -- in an email. A parent saying no is not the same act as deleting a
  -- child's work.
  /* The account row first. `public.users.id` references `auth.users`,
     so a person minted with `gen_random_uuid()` and no credential
     behind them is refused by the foreign key -- which is what
     stopped this whole section from ever running. Every other
     fixture in this file already does it in this order. */
  v_student := gen_random_uuid();
  insert into auth.users (id) values (v_student);

  insert into public.users (id, org_id, display_name, population, age_band,
                            consent_state, consent_requested_at)
  values (v_student, v_org, 'Consent fixture two', 'student', '13_17',
          'pending', now());

  insert into public.guardian_consents (org_id, user_id, guardian_name, guardian_email)
  values (v_org, v_student, 'B Guardian', 'guardian.b@demo.invalid')
  returning id into v_consent;

  perform app.request_guardian_consent(v_consent);

  select replace(replace(payload->>'path', '/consent/', ''), '/', '')
    into v_token
    from public.notifications where subject_id = v_consent and kind = 'guardian_consent';

  if public.answer_guardian_consent(v_token, false) <> 'declined' then
    raise exception 'FAIL declining did not report a decline';
  end if;

  select consent_state into v_answer from public.users where id = v_student;
  if v_answer <> 'paused' then
    raise exception 'FAIL a decline left the account at % rather than paused', v_answer;
  end if;
  raise notice '  ok   declining pauses the account and never closes it';
end $body$;

-- ===========================================================================
-- NUDGES
--
-- Authorisation here is not who may press the button. It is who the message
-- may reach: a function that takes any user id and mails them about a
-- stranger's obligation is the failure worth a real database to catch.
-- ===========================================================================

do $body$
declare
  v_part    uuid;
  v_ms      uuid;
  v_author  uuid;
  v_other   uuid;
  v_org     uuid;
  v_answer  text;
  v_n       int;
begin
  select em.id, em.participation_id, em.org_id
    into v_ms, v_part, v_org
    from public.entry_milestones em
   where em.completed_on is null
   limit 1;

  if v_ms is null then
    raise notice '  --   no open obligation seeded, nudge checks skipped';
    return;
  end if;

  select a.user_id into v_author
    from public.project_authors a
    join public.participations pt on pt.project_id = a.project_id
   where pt.id = v_part and a.role = 'author'
   limit 1;

  -- Somebody at the school who is not on this project.
  select u.id into v_other
    from public.users u
   where u.org_id = v_org
     and u.id <> coalesce(v_author, u.id)
     and not exists (
       select 1 from public.project_authors a
        join public.participations pt on pt.project_id = a.project_id
       where pt.id = v_part and a.user_id = u.id
     )
   limit 1;

  -- ── A nudge cannot reach somebody who is not on the project ────────────
  --
  -- The whole authorisation surface. Without it the function is a way to mail
  -- any account at the school about work that is not theirs.
  if v_other is not null then
    begin
      perform public.nudge(v_ms, v_other);
      raise exception 'FAIL a nudge reached somebody who is not on the project';
    exception
      when others then
        if sqlerrm like 'FAIL%' then raise; end if;
    end;
    raise notice '  ok   a nudge cannot reach somebody who is not on the project';
  end if;

  -- ── An unknown obligation is refused ───────────────────────────────────
  begin
    perform public.nudge(gen_random_uuid(), coalesce(v_author, v_org));
    raise exception 'FAIL an unknown obligation was accepted';
  exception
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
  end;
  raise notice '  ok   an unknown obligation is refused';

  -- ── A met obligation is not nudged ─────────────────────────────────────
  --
  -- The screen reads a list and a row can be met between the render and the
  -- click. A nudge about a signed form is the message that teaches somebody
  -- to ignore the rest.
  declare
    v_done uuid;
  begin
    select em.id into v_done
      from public.entry_milestones em
     where em.completed_on is not null
     limit 1;

    if v_done is not null then
      select a.user_id into v_author
        from public.entry_milestones em
        join public.participations pt on pt.id = em.participation_id
        join public.project_authors a on a.project_id = pt.project_id
       where em.id = v_done and a.role = 'author'
       limit 1;

      if v_author is not null then
        if public.nudge(v_done, v_author) <> 'done' then
          raise exception 'FAIL a met obligation was nudged anyway';
        end if;
        raise notice '  ok   a met obligation is not nudged';
      end if;
    end if;
  end;

  -- ── A nudge to an Elder is counted, which is the case a teacher uses ───
  --
  -- `nudge` chooses its template from what the recipient is, so a nudge to an
  -- officer is written as `nudge_officer`. `nudge_state` filtered
  -- `kind = 'nudge'` alone and counted none of them: the send succeeded, the
  -- button came back unchanged, and it read as a button that does not work.
  --
  -- Asserted through the *counters* rather than by reading `kind`, because
  -- the kind is a template selector and the thing that must hold is that
  -- every nudge is countable whoever it went to.
  declare
    v_elder uuid;
    v_ms2   uuid;
    v_seen  int;
  begin
    select a.user_id into v_elder
      from public.project_authors a
     where a.participation_id = v_part and a.role = 'officer'
     limit 1;

    if v_elder is not null then
      select em.id into v_ms2
        from public.entry_milestones em
       where em.participation_id = v_part
         and em.completed_on is null
         and em.id <> v_ms
       limit 1;

      if v_ms2 is not null then
        if public.nudge(v_ms2, v_elder) not in ('sent', 'self') then
          raise exception 'FAIL an Elder could not be nudged';
        end if;

        select nudges into v_seen
          from public.nudge_state(v_part) where milestone_id = v_ms2;

        if coalesce(v_seen, 0) < 1 then
          raise exception 'FAIL a nudge to an Elder was not counted';
        end if;
        raise notice '  ok   a nudge to an Elder is counted like any other';

        -- And it reaches them, which is the other half nothing was reading.
        if not exists (
          select 1 from public.notifications
           where subject_id = v_ms2 and recipient_id = v_elder
        ) then
          raise exception 'FAIL the Elder was not the recipient';
        end if;
        raise notice '  ok   and it is addressed to the Elder';
      end if;
    end if;
  end;

  -- ── The whole loop: sent, seen, relayed ────────────────────────────────
  --
  -- Teacher nudges the Elder. Elder says they have it. Elder passes it to the
  -- student. Every step has to be visible from both ends, because a delegated
  -- nudge that is not tracked to its second hop is a way of doing nothing
  -- while feeling like you did.
  declare
    v_elder2  uuid;
    v_kid     uuid;
    v_ms3     uuid;
    v_ack     timestamptz;
    v_relay   timestamptz;
  begin
    select a.user_id into v_elder2
      from public.project_authors a
     where a.participation_id = v_part and a.role = 'officer'
     limit 1;

    select a.user_id into v_kid
      from public.project_authors a
     where a.participation_id = v_part and a.role = 'author'
     limit 1;

    select em.id into v_ms3
      from public.entry_milestones em
     where em.participation_id = v_part and em.completed_on is null
     order by em.due_on nulls last
     limit 1;

    if v_elder2 is not null and v_kid is not null and v_ms3 is not null
       and v_elder2 <> v_kid then

      perform public.nudge(v_ms3, v_elder2);

      -- Nothing has come back yet.
      select acknowledged_at into v_ack
        from public.nudge_state(v_part)
       where milestone_id = v_ms3 and recipient_id = v_elder2;
      if v_ack is not null then
        raise exception 'FAIL a nudge reported as seen before anybody saw it';
      end if;
      raise notice '  ok   a fresh nudge reports as not seen';

      -- Acknowledging does not clear the obligation. A system where saying
      -- "on it" cleared the row would teach everybody to say "on it".
      perform set_config('request.jwt.claim.sub', v_elder2::text, true);

      if public.acknowledge_nudge(v_ms3) <> 'acknowledged' then
        raise exception 'FAIL the Elder could not acknowledge';
      end if;

      if not exists (
        select 1 from public.entry_milestones
         where id = v_ms3 and completed_on is null
      ) then
        raise exception 'FAIL acknowledging completed the obligation';
      end if;
      raise notice '  ok   acknowledging says seen and does not say done';

      -- The Elder passes it to the student, and the teacher can tell.
      perform public.nudge(v_ms3, v_kid);

      select acknowledged_at, relayed_at into v_ack, v_relay
        from public.nudge_state(v_part)
       where milestone_id = v_ms3 and recipient_id = v_elder2;

      if v_ack is null then
        raise exception 'FAIL the acknowledgement was not visible to the sender';
      end if;
      if v_relay is null then
        raise exception 'FAIL the relay was not visible to the sender';
      end if;
      raise notice '  ok   seen and passed on are both visible from the other end';

      -- ── A track belongs to a recipient, not to an obligation ───────────
      --
      -- Counting every nudge on a milestone made an Elder's own row report
      -- her teacher's nudge as one she had sent, to a person nobody had
      -- written to. The two rows must be separate and count separately.
      declare
        v_to_elder int;
        v_to_kid   int;
      begin
        select nudges into v_to_elder from public.nudge_state(v_part)
         where milestone_id = v_ms3 and recipient_id = v_elder2;

        select nudges into v_to_kid from public.nudge_state(v_part)
         where milestone_id = v_ms3 and recipient_id = v_kid;

        if coalesce(v_to_elder, 0) <> 1 or coalesce(v_to_kid, 0) <> 1 then
          raise exception
            'FAIL the track is not per recipient (elder %, student %)',
            coalesce(v_to_elder, 0), coalesce(v_to_kid, 0);
        end if;
        raise notice '  ok   each recipient has their own count, not a shared one';
      end;

      -- ── The Elder is offered somebody to pass it to ────────────────────
      --
      -- An author row is project level and an officer row names a
      -- participation, by check constraint. Looking for the author on the
      -- participation matched nothing ever, so the Elder's card offered no
      -- way to pass anything on.
      perform set_config('request.jwt.claim.sub', v_elder2::text, true);

      if not exists (
        select 1 from public.my_nudges()
         where milestone_id = v_ms3 and relay_to_id = v_kid
      ) then
        raise exception 'FAIL the Elder was offered nobody to pass it to';
      end if;
      raise notice '  ok   the Elder is offered the student to pass it to';

      -- ── And the ask closes once they have passed it on ─────────────────
      --
      -- The relay is the act being asked for, so a card that stays after it
      -- goes on saying "this is yours" about something already handled —
      -- while the teacher's own row correctly reads `passed to`.
      if exists (select 1 from public.my_nudges() where milestone_id = v_ms3) then
        raise exception 'FAIL the Elder is still being asked after passing it on';
      end if;
      raise notice '  ok   passing it on closes the ask';

      -- ── Asking again reopens it ────────────────────────────────────────
      --
      -- Compared by time rather than by existence: a relay from a fortnight
      -- ago does not answer a request made this morning. Without this the
      -- Elder could never be nudged about the same obligation twice.
      perform set_config('request.jwt.claim.sub', null, true);

      update public.notifications
         set created_at = created_at - interval '8 days'
       where subject_id = v_ms3;

      perform public.nudge(v_ms3, v_elder2);

      perform set_config('request.jwt.claim.sub', v_elder2::text, true);

      if not exists (select 1 from public.my_nudges() where milestone_id = v_ms3) then
        raise exception 'FAIL a fresh ask did not reopen after an older relay';
      end if;
      raise notice '  ok   a fresh ask reopens the card';

      -- And the student is offered nobody, being the end of the chain.
      perform set_config('request.jwt.claim.sub', v_kid::text, true);

      if exists (
        select 1 from public.my_nudges()
         where milestone_id = v_ms3 and relay_to_id is not null
      ) then
        raise exception 'FAIL the student was offered somebody to pass it to';
      end if;
      raise notice '  ok   the student is the end of the chain';

      -- And the student has it to act on.
      perform set_config('request.jwt.claim.sub', v_kid::text, true);

      if not exists (select 1 from public.my_nudges() where milestone_id = v_ms3) then
        raise exception 'FAIL the student cannot see what was passed to them';
      end if;
      raise notice '  ok   the student sees what was passed to them';

      perform set_config('request.jwt.claim.sub', null, true);
    end if;
  end;

  -- ── One per obligation per week, from the index rather than the UI ─────
  select a.user_id into v_author
    from public.project_authors a
    join public.participations pt on pt.project_id = a.project_id
   where pt.id = v_part and a.role = 'author'
   limit 1;

  if v_author is not null then
    v_answer := public.nudge(v_ms, v_author);

    if v_answer not in ('sent', 'self') then
      raise exception 'FAIL the first nudge returned %', v_answer;
    end if;

    if v_answer = 'sent' then
      if public.nudge(v_ms, v_author) <> 'already' then
        raise exception 'FAIL the same obligation was nudged twice in one week';
      end if;
      raise notice '  ok   one nudge per obligation per week';

      select count(*) into v_n
        from public.notifications
       where kind in ('nudge', 'nudge_officer') and subject_id = v_ms;

      if v_n <> 1 then
        raise exception 'FAIL % nudge rows written for one obligation', v_n;
      end if;

      -- ── The count is readable, which is the point ──────────────────────
      select nudges into v_n from public.nudge_state(v_part) where milestone_id = v_ms;

      if coalesce(v_n, 0) <> 1 then
        raise exception 'FAIL nudge_state reported % rather than 1', coalesce(v_n, 0);
      end if;
      raise notice '  ok   the count is readable from nudge_state';
    end if;
  end if;
end $body$;

\echo ''
\echo '  All function assertions passed.'
