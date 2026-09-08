-- ===========================================================================
-- 0002 · THE PASSWORD RESET, FOR THE CLASS (2.9, the pilot's first morning)
--
-- `0001` froze at the pilot's go-live (decision 72, 11.7). This is the first
-- additive migration: it redefines one function and adds one grant, and
-- removes nothing.
--
-- Two things stopped "Forgotten your password?" on the hosted site, found
-- in the project's logs the morning of the pilot:
--
-- 1. `may_reset_password` is asked by the reset route with the secret key
--    (2.9), whose role is `service_role`. `0001` revoked execute on every
--    function from `public`, which is where `service_role` used to get it,
--    and granted the function back to `anon` and `authenticated` only —
--    then revoked those two as well, since the answer is a list of who has
--    an account. Nobody was left who could ask: PostgREST answered 403,
--    the route read that as "may not", and the page said its usual
--    sentence while nothing was sent.
--
-- 2. The function's second clause — the one that answers for a person
--    whose identity has not been mirrored yet, which is everyone who has
--    never signed in — accepted staff only. It was written when only
--    teachers had passwords. The whole class has one now (`pilot:password
--    --roster`), so a student who loses theirs before their first sign-in
--    would have been refused a link. The clause still requires an `email`
--    identity in `auth.identities`: an account that only ever signed in
--    with Google has none, and is refused as before, so a reset cannot
--    turn one way in into two.
-- ===========================================================================

create or replace function public.may_reset_password(p_email text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1
      from public.identities i
     where lower(i.email) = lower(btrim(p_email))
       and i.revoked_at is null
       and i.provider = 'email'
  )
  or exists (
    select 1
      from auth.identities ai
      join public.users u on u.id = ai.user_id
     where lower(coalesce(ai.identity_data ->> 'email', '')) = lower(btrim(p_email))
       and ai.provider = 'email'
       and u.status <> 'suspended'
  );
end;
$$;

-- The reset route asks with the secret key and nobody else may.
revoke execute on function public.may_reset_password(text) from public, anon, authenticated;
grant execute on function public.may_reset_password(text) to service_role;
