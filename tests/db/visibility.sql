-- ===========================================================================
-- WHAT THE VISIBILITY RULE ACTUALLY DOES
--
-- Section 6.6 makes several claims. Everything up to now has checked that the
-- policies *call* the right function; nothing has checked that the function
-- answers correctly, because that needs a database.
--
-- Run with tests/run-db-tests.sh, which stands up a Postgres, applies the
-- migration, and executes this.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset footer off

-- ── A small world ──────────────────────────────────────────────────────────
--
-- One school running two editions of a fair and a course, plus a second
-- school that should see none of it.

insert into public.organizations (id, slug, hostname, lockup_name, mark, theme, status) values
 ('11111111-1111-1111-1111-111111111111','mv','mv.test','Monta Vista','MV','entry','active'),
 ('22222222-2222-2222-2222-222222222222','lb','lb.test','Lynbrook','LB','entry','active');

insert into auth.users (id) values
 ('a0000000-0000-0000-0000-000000000001'),
 ('a0000000-0000-0000-0000-000000000002'),
 ('a0000000-0000-0000-0000-000000000003'),
 ('a0000000-0000-0000-0000-000000000004'),
 ('a0000000-0000-0000-0000-000000000005'),
 ('a0000000-0000-0000-0000-000000000006'),
 ('a0000000-0000-0000-0000-000000000007'),
 ('a0000000-0000-0000-0000-000000000008'),
 ('a0000000-0000-0000-0000-000000000009');

insert into public.users (id, org_id, display_name) values
 ('a0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Author one'),
 ('a0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Fair officer'),
 ('a0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Elder'),
 ('a0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Advisor'),
 ('a0000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','Graduated officer'),
 ('a0000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','Another student'),
 ('a0000000-0000-0000-0000-000000000007','22222222-2222-2222-2222-222222222222','Lynbrook student'),
 ('a0000000-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111','Author two'),
 ('a0000000-0000-0000-0000-000000000009','11111111-1111-1111-1111-111111111111','Author three');

-- Two editions of one family, and a course in another.
insert into public.programs (id, org_id, slug, name, season_year, family, kind, template_id, current, source, status) values
 ('b0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','fair-2026','Fair 2026',2026,'scvsefa','competition','t',false,'external','closed'),
 ('b0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','fair-2027','Fair 2027',2027,'scvsefa','competition','t',true, 'external','open'),
 ('b0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','irpd-2027','IRPD 2027',2027,'irpd','course','t',true,'external','open');

insert into public.user_roles (org_id, user_id, role, scope_id) values
 ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000002','officer','b0000000-0000-0000-0000-000000000002'),
 ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000003','officer','b0000000-0000-0000-0000-000000000003'),
 ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000004','advisor',null),
 -- Last year's officer. Their edition has ended and nothing has re-granted.
 ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000005','officer','b0000000-0000-0000-0000-000000000001'),
 ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-000000000006','student',null);

-- One project per case, each with its own author, because a student may only
-- be entered once in a program.
insert into public.projects (id, org_id, title, created_by, is_private) values
 ('c0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','Last year''s fair project','a0000000-0000-0000-0000-000000000001',false),
 ('c0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','Course project','a0000000-0000-0000-0000-000000000008',false),
 ('c0000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111','Private, this year','a0000000-0000-0000-0000-000000000009',true),
 ('c0000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111','Private, last year','a0000000-0000-0000-0000-000000000006',true),
 ('c0000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111','In the fair and the course','a0000000-0000-0000-0000-000000000005',false),
 -- Created and not yet given an author row, which is the state a project is
 -- in between the two statements that make it.
 ('c0000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111','In no program at all','a0000000-0000-0000-0000-000000000006',false);

insert into public.project_authors (org_id, project_id, user_id, role, accepted_at) values
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','author',now()),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000008','author',now()),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000009','author',now()),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000006','author',now()),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000005','author',now());

insert into public.entries (org_id, project_id, program_id) values
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000001','b0000000-0000-0000-0000-000000000001'),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000002','b0000000-0000-0000-0000-000000000003'),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000003','b0000000-0000-0000-0000-000000000002'),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000004','b0000000-0000-0000-0000-000000000001'),
 -- One piece of work governed by the course and entered at the fair. 5.2.
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-000000000002'),
 ('11111111-1111-1111-1111-111111111111','c0000000-0000-0000-0000-000000000005','b0000000-0000-0000-0000-000000000003');

-- ── The assertions ─────────────────────────────────────────────────────────

create or replace function pg_temp.sees(p_user uuid, p_project uuid) returns boolean
language plpgsql as $$
declare answer boolean;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  select app.can_see_project(p_project) into answer;
  return answer;
end $$;

create or replace function pg_temp.expect(
  p_what text, p_user text, p_project text, p_expected boolean
) returns text language plpgsql as $$
declare
  v_user uuid;
  v_project uuid;
  v_actual boolean;
begin
  select id into v_user from public.users where display_name = p_user;
  select id into v_project from public.projects where title = p_project;
  v_actual := pg_temp.sees(v_user, v_project);

  if v_actual is distinct from p_expected then
    raise exception 'FAIL %: % should %see "%"',
      p_what, p_user, case when p_expected then '' else 'not ' end, p_project;
  end if;

  return format('  ok   %s', p_what);
end $$;

select pg_temp.expect('an author sees their own work',
  'Author one', 'Last year''s fair project', true);

select pg_temp.expect('a student sees nothing of another''s',
  'Another student', 'Last year''s fair project', false);

select pg_temp.expect('the advisor sees everything',
  'Advisor', 'Course project', true);

select pg_temp.expect('this year''s officer sees the family''s history',
  'Fair officer', 'Last year''s fair project', true);

select pg_temp.expect('and nothing from another family',
  'Fair officer', 'Course project', false);

select pg_temp.expect('an elder sees the course',
  'Elder', 'Course project', true);

select pg_temp.expect('and not the fair''s archive',
  'Elder', 'Last year''s fair project', false);

select pg_temp.expect('a graduated officer sees nothing',
  'Graduated officer', 'Last year''s fair project', false);

select pg_temp.expect('another school sees nothing at all',
  'Lynbrook student', 'Last year''s fair project', false);

-- 6.6: the privacy switch keeps a project out of the browsable history, and
-- cannot hide a running project from the people responsible for it.
select pg_temp.expect('privacy does not hide a running project from its officers',
  'Fair officer', 'Private, this year', true);

select pg_temp.expect('privacy does remove it from the history',
  'Fair officer', 'Private, last year', false);

select pg_temp.expect('and never from the advisor',
  'Advisor', 'Private, last year', true);

select pg_temp.expect('nor from its author',
  'Another student', 'Private, last year', true);

-- 5.2: one project, two programs, both sets of staff.
select pg_temp.expect('a project in two programs is visible to both',
  'Fair officer', 'In the fair and the course', true);

select pg_temp.expect('including the other one',
  'Elder', 'In the fair and the course', true);

-- 7.1: a project in nothing still exists, and only its author sees it.
--
-- The creator case matters more than it looks. A project is created and its
-- first author row written in the next statement, and between those two there
-- is no author at all. Without the creator clause, `can_edit_project` counts
-- them and `can_see_project` does not, so somebody can edit a project they
-- cannot read: an update that returns nothing, on a project they just made,
-- with no route back to it.
select pg_temp.expect('the creator sees a project with no author row yet',
  'Another student', 'In no program at all', true);

select pg_temp.expect('and can edit it, which is the half that always worked',
  'Another student', 'In no program at all', true);

select pg_temp.expect('the advisor sees it too',
  'Advisor', 'In no program at all', true);

select pg_temp.expect('an officer does not, because it is in no program',
  'Fair officer', 'In no program at all', false);

select pg_temp.expect('and another school never does',
  'Lynbrook student', 'In no program at all', false);

\echo ''
\echo '  All visibility assertions passed.'
