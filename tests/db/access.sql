-- ===========================================================================
-- ACCESS, FROM THE OUTSIDE.
--
-- The visibility tests call the function directly. These go through the
-- policies as PostgREST would: role `authenticated`, a JWT subject, and RLS
-- on. A function that answers correctly behind a policy that never calls it
-- is still a leak.
--
-- `set local` needs a transaction. Outside one it warns and does nothing,
-- which silently leaves the session as a superuser — and a superuser passes
-- every one of these.
-- ===========================================================================

\set ON_ERROR_STOP on
\pset footer off

\set QUIET on
select id as officer  from public.users where display_name = 'Fair officer' \gset
select id as elder    from public.users where display_name = 'Elder' \gset
select id as grad     from public.users where display_name = 'Graduated officer' \gset
select id as student  from public.users where display_name = 'Another student' \gset
select id as outsider from public.users where display_name = 'Lynbrook student' \gset
select id as advisor_user from public.users where display_name = 'Advisor' \gset
select id as fair     from public.programs where slug = 'fair-2027' \gset
\set QUIET off

create or replace function pg_temp.reads(p_user uuid) returns bigint
language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.projects;
  perform set_config('role', 'postgres', true);
  return n;
end $$;

create or replace function pg_temp.expect_count(
  p_what text, p_user uuid, p_expected bigint
) returns text language plpgsql as $$
declare n bigint;
begin
  n := pg_temp.reads(p_user);
  if n <> p_expected then
    raise exception 'FAIL %: read % projects, expected %', p_what, n, p_expected;
  end if;
  return format('  ok   %s (%s)', p_what, n);
end $$;

select pg_temp.expect_count('an officer reads their family and their own', :'officer', 3);
select pg_temp.expect_count('an elder reads the course', :'elder', 2);
select pg_temp.expect_count('a graduated officer reads only what they authored', :'grad', 1);
select pg_temp.expect_count('a student reads their own', :'student', 2);
select pg_temp.expect_count('another school reads nothing', :'outsider', 0);

-- ── Things that must not work ──────────────────────────────────────────────

\echo ''
begin;
  set local role authenticated;
  set local request.jwt.claim.sub = :'student';

  savepoint attempt;
  do $$
  begin
    insert into public.user_roles (org_id, user_id, role, scope_id)
    select org_id, id, 'officer', null from public.users where id = auth.uid();
    raise exception 'FAIL: a student granted themselves a role';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
  end $$;
  rollback to attempt;
  \echo '  ok   a student cannot grant themselves a role'

  do $$
  begin
    if (select count(*) from public.organizations) <> 1 then
      raise exception 'FAIL: more than one organization is visible';
    end if;
    if (select count(*) from public.field_notes) <> 0 then
      raise exception 'FAIL: another student''''s notes are readable';
    end if;
  end $$;
  \echo '  ok   only their own organization is visible'
  \echo '  ok   another student''s notes are not'
commit;

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = :'student';
  update public.projects set title = 'hijacked' where title like 'Last year%';
  \echo '  ok   an update against another project touches nothing'
rollback;

-- ── The teacher's role is granted by a teacher ─────────────────────────────
--
-- `app.guard_role_grant` gated this on the role `mentor`, which the check
-- constraint on `user_roles.role` has not permitted since the rename. The
-- guard therefore fired on nothing, and the insert policy admits any officer
-- -- who is usually a student. `advisor` with a null scope satisfies
-- `app.is_advisor()`, which `can_see_project` reads as a duty of care over
-- every project at the school, so the club president could grant a classmate
-- the widest role in the schema.
--
-- Asserted from outside, as PostgREST would arrive, because a guard that runs
-- as the superuser is a guard that has not been tested.

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = :'officer';
  savepoint attempt;
  do $$
  begin
    insert into public.user_roles (org_id, user_id, role)
    select u.org_id, u.id, 'advisor'
      from public.users u where u.display_name = 'Another student';
    raise exception 'FAIL: an officer granted the advisor role';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
  end $$;
  rollback to attempt;
  \echo '  ok   an officer cannot make somebody an advisor'

  savepoint officer_role;
  do $$
  begin
    insert into public.user_roles (org_id, user_id, role)
    select u.org_id, u.id, 'officer'
      from public.users u where u.display_name = 'Another student';
  exception
    when others then
      raise exception 'FAIL: an officer could not grant the officer role: %', sqlerrm;
  end $$;
  rollback to officer_role;
  \echo '  ok   and can still grant the roles an officer runs'
commit;

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = :'advisor_user';
  savepoint attempt;
  do $$
  begin
    insert into public.user_roles (org_id, user_id, role)
    select u.org_id, u.id, 'advisor'
      from public.users u where u.display_name = 'Another student';
  exception
    when others then
      raise exception 'FAIL: the advisor could not grant the advisor role: %', sqlerrm;
  end $$;
  rollback to attempt;
  \echo '  ok   the advisor can'
commit;

\echo ''
\echo '  All access assertions passed.'
