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
select id as outsider from public.users where display_name = 'Other school student' \gset
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

  -- Hardening (2.9): the session writes no role row at all, whatever the
  -- role; grant_club_role and revoke_club_role, the advisor's, are the way.
  savepoint officer_role;
  do $$
  begin
    insert into public.user_roles (org_id, user_id, role)
    select u.org_id, u.id, 'officer'
      from public.users u where u.display_name = 'Another student';
    raise exception 'FAIL: an officer wrote a role row directly';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
  end $$;
  rollback to officer_role;
  \echo '  ok   and writes no role row directly, whatever the role'

  -- Nor turns their own row into the advisor's.
  savepoint self_promote;
  do $$
  begin
    update public.user_roles set role = 'advisor' where user_id = auth.uid();
    if exists (select 1 from public.user_roles where user_id = auth.uid() and role = 'advisor') then
      raise exception 'FAIL: an officer rewrote their own role to advisor';
    end if;
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
  end $$;
  rollback to self_promote;
  \echo '  ok   and cannot rewrite their own role to advisor'
commit;

begin;
  set local role authenticated;
  set local request.jwt.claim.sub = :'advisor_user';
  savepoint attempt;
  do $$
  begin
    perform public.grant_club_role((select u.id from public.users u where u.display_name = 'Another student'), 'officer');
    if not exists (select 1 from public.user_roles r join public.users u on u.id = r.user_id
                    where u.display_name = 'Another student' and r.role = 'officer' and r.revoked_at is null) then
      raise exception 'FAIL: the advisor''s grant did not land';
    end if;
  exception
    when others then
      raise exception 'FAIL: the advisor could not grant the officer role: %', sqlerrm;
  end $$;
  rollback to attempt;
  \echo '  ok   the advisor grants through grant_club_role'

  -- And not by writing the table: the advisor role itself is claimed from a
  -- reservation the advisor made, never inserted from a session.
  savepoint raw;
  do $$
  begin
    insert into public.user_roles (org_id, user_id, role)
    select u.org_id, u.id, 'advisor'
      from public.users u where u.display_name = 'Another student';
    raise exception 'FAIL: the advisor wrote a role row directly';
  exception
    when others then
      if sqlerrm like 'FAIL:%' then raise; end if;
  end $$;
  rollback to raw;
  \echo '  ok   and writes no role row directly either'
commit;

-- The password reset asks may_reset_password with the secret key (2.9):
-- service_role may, and nobody else, since the answer is who has an
-- account. Found on the hosted site's first morning as a 403.
do $$
begin
  if not has_function_privilege('service_role', 'public.may_reset_password(text)', 'execute') then
    raise exception 'FAIL: service_role may not ask may_reset_password, so the reset route is answered 403';
  end if;
  if has_function_privilege('anon', 'public.may_reset_password(text)', 'execute')
     or has_function_privilege('authenticated', 'public.may_reset_password(text)', 'execute') then
    raise exception 'FAIL: may_reset_password answers the anonymous or signed-in key, which is a list of who has an account';
  end if;
end $$;
\echo '  ok   the reset route may ask may_reset_password with the secret key, and only it may'

-- Guesses counted (2.9): open until the eighth failure in the window,
-- closed after it, open again once a success is newer than the failures;
-- only the secret key's role may ask or record.
do $$
declare v_i int;
begin
  if not public.password_gate('Guess@Example.org') then raise exception 'FAIL: a fresh account is not open'; end if;
  for v_i in 1..7 loop perform public.password_attempt('guess@example.org', false); end loop;
  if not public.password_gate('guess@example.org') then raise exception 'FAIL: locked before the eighth failure'; end if;
  perform public.password_attempt('guess@example.org', false);
  if public.password_gate('guess@example.org') then raise exception 'FAIL: not locked after the eighth failure'; end if;
  if not public.password_gate('other@example.org') then raise exception 'FAIL: one account''s failures locked another'; end if;
  perform public.password_attempt('guess@example.org', true);
  if not public.password_gate('guess@example.org') then raise exception 'FAIL: a success newer than the failures did not reopen the account'; end if;
  if has_function_privilege('anon', 'public.password_gate(text, int, interval)', 'execute')
     or has_function_privilege('authenticated', 'public.password_attempt(text, boolean)', 'execute') then
    raise exception 'FAIL: a session may ask or record password attempts';
  end if;
  if not has_function_privilege('service_role', 'public.password_gate(text, int, interval)', 'execute') then
    raise exception 'FAIL: the secret key may not ask the gate';
  end if;
  delete from public.password_attempts where email like '%@example.org';
end $$;
\echo '  ok   guesses at a password are counted per account, the eighth in a quarter hour closes it, a success reopens it, and only the secret key asks'

\echo ''
\echo '  All access assertions passed.'
