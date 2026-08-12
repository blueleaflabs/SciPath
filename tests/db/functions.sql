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
update public.entries set status = 'requested' where project_id = :'course_project';

\set QUIET on
select id as request from public.entries where project_id = :'course_project' \gset
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
    select 1 from public.entries
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
    select 1 from public.entries
     where id = (select id from public.entries where status = 'entered' limit 1)
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

update public.entries set status = 'requested' where project_id = :'course_project';

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

\echo ''
\echo '  All function assertions passed.'
