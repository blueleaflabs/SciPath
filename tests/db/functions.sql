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
select id as outsider from public.users where display_name = 'Lynbrook student' \gset
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

\set QUIET on
select id as author_officer from public.users where display_name = 'Fair officer' \gset
select id as their_project  from public.projects where title = 'Private, this year' \gset
\set QUIET off

/* Make the officer an author of a project, which is the ordinary case: a
   student who runs the club also does research. */
insert into public.project_authors (org_id, project_id, user_id, role, accepted_at)
select org_id, :'their_project', :'author_officer', 'author', now()
  from public.projects where id = :'their_project'
on conflict do nothing;

select pg_temp.refuses(
  'an author does not assign the officer for their own project', :'author_officer',
  format('select public.assign_officer(%L, %L)', :'their_project', :'author_officer'));

select pg_temp.refuses(
  'nor can an author of a project be named its officer', :'advisor',
  format('select public.assign_officer(%L, %L)', :'their_project', :'author_officer'));

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

\echo ''
\echo '  All function assertions passed.'
