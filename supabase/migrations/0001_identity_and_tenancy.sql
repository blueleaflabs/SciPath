-- ============================================================================
-- 0001  IDENTITY AND TENANCY
--
-- Brief sections 11.1 (tables), 11.6 (policies), 11.7 (migration order),
-- 11.8 (granting a role before a login exists).
--
-- Rules this file exists to satisfy, all of which are cheap now and brutal
-- to retrofit:
--
--   * org_id on every table. organizations is the tenant root and is the
--     single exception; its own id is the tenant key.
--   * Row level security enabled on every table, in the same migration that
--     creates it. Never retrofitted.
--   * users.id IS auth.users.id, so every policy is a comparison against
--     auth.uid() rather than a join through an identity table.
--   * State columns are TEXT with CHECK, never Postgres enums. An enum value
--     cannot be removed and these state machines are still moving.
--   * Nothing is hard deleted. Foreign keys restrict; state columns and
--     archived_at handle removal.
--   * audit_log is append only, enforced by revoking the grant rather than by
--     omitting a policy, so a later migration that drops a policy cannot
--     quietly make it writable.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Authorization helpers live in a schema that is NOT exposed to the API.
-- They are SECURITY DEFINER so they can read the roles and consent tables
-- without tripping the policies written on those same tables, which is what
-- would otherwise recurse.
-- ---------------------------------------------------------------------------

create schema if not exists app;

revoke all on schema app from public;
grant usage on schema app to authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- Shared trigger. Every table carries created_at and updated_at.
-- ---------------------------------------------------------------------------

create or replace function app.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ===========================================================================
-- TABLES
-- ===========================================================================

-- --------------------------------------------------------------------------
-- organizations : the tenant root. The one table with no org_id.
-- --------------------------------------------------------------------------
create table public.organizations (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  -- Tenancy is resolved by hostname, not by email domain. Two schools in one
  -- district share student.fuhsd.org, so a domain cannot say which school.
  hostname       text not null unique,
  lockup_name    text not null,
  mark           text not null check (char_length(mark) between 2 and 4),
  theme          text not null check (theme in ('entry', 'proceedings')),
  postal_address text,
  phone          text,
  contact_email  text,
  -- domain  : only an address on a listed domain may sign up
  -- open    : anyone may sign up. No domain, no mentor, no district
  -- invite  : signup requires a pending grant
  signup_mode      text not null default 'domain'
                     check (signup_mode in ('domain', 'open', 'invite')),
  requires_mentor boolean not null default true,
  status         text not null default 'provisioning'
                   check (status in ('provisioning', 'active', 'suspended')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.organizations is
  'One row per tenant. Provisioning is a deliberate act and is never self serve.';

-- --------------------------------------------------------------------------
-- org_domains : the verified hd allowlist.
--
-- A classifier, not a gate. A matching domain establishes population,
-- affiliation, and which organization to attach to. It does NOT establish a
-- privileged role: these are district wide domains covering schools that have
-- agreed to nothing, so "staff domain therefore faculty powers" would hand
-- the mentor's authority to thousands of people. See 6.1.
-- --------------------------------------------------------------------------
create table public.org_domains (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organizations on delete restrict,
  domain             text not null,
  population         text not null check (population in ('student', 'staff')),
  grants_affiliation boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, domain)
);

create index org_domains_domain_idx on public.org_domains (domain);

comment on table public.org_domains is
  'A domain establishes population and affiliation WITHIN an organization. It '
  'never establishes which organization: fuhsd.org is district wide and covers '
  'five high schools. Tenancy comes from the hostname.';

-- --------------------------------------------------------------------------
-- users : one row per person. id IS auth.users.id.
--
-- No school column. School comes from the organization; a school name as a
-- column default is the rule in 12.2 broken inside a migration.
-- No date of birth, ever. The age gate at 13 is an attestation and we store
-- the moment it was made.
-- --------------------------------------------------------------------------
create table public.users (
  id            uuid primary key references auth.users on delete restrict,
  org_id        uuid not null references public.organizations on delete restrict,
  display_name  text not null check (char_length(trim(display_name)) > 0),
  grad_year     int check (grad_year between 2000 and 2100),
  population    text not null default 'external'
                  check (population in ('student', 'staff', 'external')),
  status        text not null default 'unaffiliated'
                  check (status in ('unaffiliated', 'active', 'alumnus', 'suspended')),

  affiliation_state       text not null default 'unverified'
                            check (affiliation_state in
                              ('unverified', 'domain_verified', 'mentor_verified', 'lapsed')),
  affiliation_verified_at timestamptz,

  -- Stored, not computed. 18.3 requires a paused account to restore the
  -- instant a guardian confirms, and elapsed time arithmetic inside a policy
  -- is neither testable nor observable. The daily job moves these.
  -- not_required is an adult. Guardian consent is a legal requirement for a
  -- minor and meaningless for an adult, and an open tenant has plenty of both.
  consent_state        text not null default 'pending'
                         check (consent_state in
                           ('pending', 'active', 'paused', 'closed', 'not_required')),
  consent_requested_at timestamptz,

  -- One field, three bands, no date of birth ever stored. 18.2.
  age_band        text check (age_band in ('under_13', '13_17', '18_plus')),
  age_attested_at timestamptz,

  orcid            text,
  photo_path       text,
  photo_consent    boolean not null default false,
  outbound_url     text,
  author_slug      text unique,
  page_archived_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index users_org_idx on public.users (org_id);

-- --------------------------------------------------------------------------
-- identities : a read only mirror of auth.identities.
--
-- Supabase owns login. This table exists so audit_log.identity_id has
-- something we own to point at, because the audit trail records which login
-- acted and not merely which person. No client ever writes it; the mirror
-- function reads auth.identities for the current session, so nothing about
-- provider, subject, hd, or email is client supplied.
-- --------------------------------------------------------------------------
create table public.identities (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations on delete restrict,
  user_id          uuid not null references public.users on delete restrict,
  auth_identity_id uuid not null unique,
  provider         text not null,
  subject          text not null,
  email            text not null,
  hd               text,
  is_primary       boolean not null default false,
  verified_at      timestamptz not null default now(),
  revoked_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (provider, subject)
);

create index identities_user_idx on public.identities (user_id);

-- --------------------------------------------------------------------------
-- user_roles : 6.4.
--
-- Surrogate key. The composite key in the earlier draft put a nullable
-- scope_id inside a primary key, which Postgres does not permit. Two partial
-- unique indexes do the work that key was meant to do.
-- --------------------------------------------------------------------------
create table public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations on delete restrict,
  user_id    uuid not null references public.users on delete restrict,
  -- student : runs their own projects
  -- officer : runs the club. Usually a student, usually the president
  -- mentor  : the teacher. Sponsors projects and oversees them
  role       text not null check (role in ('student', 'officer', 'mentor')),
  scope_id   uuid,
  granted_by uuid references public.users on delete restrict,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index user_roles_global_uq
  on public.user_roles (user_id, role)
  where scope_id is null and revoked_at is null;

create unique index user_roles_scoped_uq
  on public.user_roles (user_id, role, scope_id)
  where scope_id is not null and revoked_at is null;

create index user_roles_lookup_idx
  on public.user_roles (user_id, role) where revoked_at is null;

-- --------------------------------------------------------------------------
-- guardian_consents : 18.2, 18.3.
--
-- An adult is attached to every account. A guardian confirms permission for
-- a minor; the club mentor, who is the teacher, takes responsibility for the
-- project. Neither needs a district agreement, and together they supply the
-- accountability a school domain otherwise would.
-- --------------------------------------------------------------------------
create table public.guardian_consents (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations on delete restrict,
  user_id          uuid not null references public.users on delete restrict,
  guardian_name    text not null,
  guardian_email   text not null,
  requested_at     timestamptz not null default now(),
  confirmed_at     timestamptz,
  revoked_at       timestamptz,
  reminders_sent   int not null default 0,
  last_reminder_at timestamptz,
  superseded_by    uuid references public.guardian_consents on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index guardian_consents_user_idx on public.guardian_consents (user_id);



-- --------------------------------------------------------------------------
-- confirmation_tokens : every emailed token.
--
-- Its own table because row level security is row level. A token column on a
-- consent row is readable by any policy that lets a student read their own
-- consent. This table carries no policies at all, so no user session can read
-- it under any circumstance.
-- --------------------------------------------------------------------------
create table public.confirmation_tokens (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations on delete restrict,
  purpose      text not null check (purpose in ('guardian_consent')),
  subject_type text not null,
  subject_id   uuid not null,
  token_hash   text not null,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index confirmation_tokens_lookup_idx on public.confirmation_tokens (token_hash);

-- --------------------------------------------------------------------------
-- pending_role_grants : 11.8.
--
-- A migration cannot create an account for a person who has never
-- authenticated, because users.id is auth.users.id. So it records an
-- intention rather than a fact. The classifier matches a pending grant
-- against the verified email at first login, grants the role, and consumes
-- the row.
-- --------------------------------------------------------------------------
create table public.pending_role_grants (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete restrict,
  email       text not null,
  role        text not null check (role in ('student', 'officer', 'mentor')),
  note        text,
  expires_at  timestamptz not null default (now() + interval '180 days'),
  consumed_at timestamptz,
  consumed_by uuid references public.users on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, email, role)
);

-- --------------------------------------------------------------------------
-- audit_log : append only.
-- --------------------------------------------------------------------------
create table public.audit_log (
  id            bigserial primary key,
  org_id        uuid not null references public.organizations on delete restrict,
  identity_id   uuid references public.identities on delete restrict,
  actor_user_id uuid references public.users on delete restrict,
  action        text not null,
  entity_type   text not null,
  entity_id     uuid,
  before        jsonb,
  after         jsonb,
  reason        text,
  occurred_at   timestamptz not null default now()
);

create index audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index audit_log_org_time_idx on public.audit_log (org_id, occurred_at desc);

-- --------------------------------------------------------------------------
-- notifications : 11.5. Needed in 0001 because the consent reminder schedule
-- at days 7, 12, 30, 45, and 53 is part of signup, not a later feature.
-- --------------------------------------------------------------------------
create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,
  user_id       uuid not null references public.users on delete restrict,
  kind          text not null,
  subject       text not null,
  body          text not null,
  entity_type   text,
  entity_id     uuid,

  -- Seven kinds bypass the digest: an authorship invitation, a review
  -- assignment, and each thing a person is expected to act on or would be
  -- embarrassed to learn about late. 11.5.
  immediate     boolean not null default false,

  queued_at     timestamptz not null default now(),
  digest_bucket date,
  sent_at       timestamptz,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index notifications_pending_idx
  on public.notifications (digest_bucket) where sent_at is null;


-- ===========================================================================
-- updated_at triggers
-- ===========================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'organizations', 'org_domains', 'users', 'identities', 'user_roles',
    'guardian_consents', 'confirmation_tokens',
    'pending_role_grants', 'notifications'
  ] loop
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function app.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end $$;


-- ===========================================================================
-- AUTHORIZATION HELPERS
--
-- Not JWT claims. The documented Supabase pattern stamps roles into the
-- access token with a custom access token hook, and it is rejected here for
-- one reason: a claim is stale until the token refreshes, and 18.3 promises
-- that a guardian confirmation restores a paused account immediately. A
-- consent state carried in a claim leaves a student locked out until their
-- token expires.
--
-- Every policy wraps these in (select ...) so Postgres evaluates them once
-- per statement rather than once per row.
-- ===========================================================================

create or replace function app.org_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.org_id from public.users u where u.id = auth.uid();
$$;

create or replace function app.has_role(p_role text, p_scope uuid default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
     where r.user_id = auth.uid()
       and r.role = p_role
       and r.revoked_at is null
       and (p_scope is null or r.scope_id is null or r.scope_id = p_scope)
  );
$$;

-- Officer or mentor. Both run the club; the mentor is the teacher and the
-- officer is usually the club president. In a school club the administrative
-- work is done by a student, which is why the officer holds real authority
-- despite being a student.
create or replace function app.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
     where r.user_id = auth.uid()
       and r.role in ('officer', 'mentor')
       and r.revoked_at is null
  );
$$;

create or replace function app.is_mentor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
     where r.user_id = auth.uid()
       and r.role = 'mentor'
       and r.revoked_at is null
  );
$$;

-- Nothing publishes before a guardian confirms. The fourteen day grace
-- period covers working, never publishing. 18.3.
create or replace function app.may_publish()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.users u
     where u.id = auth.uid() and u.consent_state = 'active'
  );
$$;

grant execute on function
  app.org_id(), app.has_role(text, uuid), app.is_staff(),
  app.is_mentor(), app.may_publish()
to authenticated;


-- ===========================================================================
-- AUDIT
-- ===========================================================================

create or replace function app.audit(
  p_org_id      uuid,
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_before      jsonb default null,
  p_after       jsonb default null,
  p_reason      text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_identity uuid;
begin
  select i.id into v_identity
    from public.identities i
   where i.user_id = auth.uid() and i.revoked_at is null
   order by i.is_primary desc, i.verified_at desc
   limit 1;

  insert into public.audit_log
    (org_id, identity_id, actor_user_id, action, entity_type, entity_id,
     before, after, reason)
  values
    (p_org_id, v_identity, auth.uid(), p_action, p_entity_type, p_entity_id,
     p_before, p_after, p_reason);
end;
$$;


-- ===========================================================================
-- IDENTITY MIRROR
--
-- Reads auth.identities for the current session and upserts our copy. No
-- client supplied data reaches this table, which is why it carries no insert
-- or update policy at all.
-- ===========================================================================

create or replace function public.sync_identities()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_count int := 0;
  r       record;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select u.org_id into v_org from public.users u where u.id = v_uid;
  if v_org is null then
    return 0;  -- signup not completed yet. Fails closed, deliberately.
  end if;

  for r in
    select i.id,
           i.provider,
           coalesce(i.provider_id, i.identity_data ->> 'sub') as subject,
           coalesce(i.identity_data ->> 'email', '')          as email,
           i.identity_data ->> 'hd'                           as hd,
           i.created_at
      from auth.identities i
     where i.user_id = v_uid
  loop
    insert into public.identities
      (org_id, user_id, auth_identity_id, provider, subject, email, hd, is_primary)
    values
      (v_org, v_uid, r.id, r.provider, r.subject, r.email, r.hd, false)
    on conflict (auth_identity_id) do update
      set email      = excluded.email,
          hd         = excluded.hd,
          revoked_at = null,
          updated_at = now();
    v_count := v_count + 1;
  end loop;

  -- Oldest surviving identity is primary. The school account is the
  -- provenance of published work and is never deleted, only marked inactive.
  update public.identities set is_primary = false
   where user_id = v_uid and is_primary;

  update public.identities set is_primary = true
   where id = (
     select id from public.identities
      where user_id = v_uid and revoked_at is null
      order by verified_at asc limit 1
   );

  -- A login through a domain identity is sufficient evidence of continuing
  -- affiliation. No separate re-verification cadence. 6.1.
  update public.users u
     set affiliation_state = 'domain_verified',
         affiliation_verified_at = now()
   where u.id = v_uid
     and exists (
       select 1
         from public.identities i
         join public.org_domains d
          on d.org_id = u.org_id
         and d.domain = coalesce(i.hd, split_part(lower(i.email), '@', 2))
        where i.user_id = v_uid
          and i.revoked_at is null
          and d.grants_affiliation
     );

  return v_count;
end;
$$;

grant execute on function public.sync_identities() to authenticated;


-- ===========================================================================
-- SIGNUP
--
-- Not a trigger on auth.users. A trigger cannot resolve the organization,
-- because a personal email signup carries no hd and the answer is known only
-- to the instance the person is standing on. Until this runs, the person
-- holds a session and owns no row, every policy fails closed, and the only
-- reachable screen is signup. That is the correct behavior and it is free.
-- ===========================================================================

create or replace function public.complete_signup(
  p_org_slug       text,
  p_display_name   text,
  p_age_band       text,
  p_grad_year      int      default null,
  p_guardian_name  text     default null,
  p_guardian_email text     default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_email      text;
  v_hd         text;
  v_org        record;
  v_domain_pop text;
  v_domain_ok  boolean;
  v_population text := 'external';
  v_affil      text := 'unverified';
  v_consent    text;
  v_grant      record;
  v_year       int := extract(year from now())::int;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  if exists (select 1 from public.users where id = v_uid) then
    raise exception 'signup already completed';
  end if;

  if coalesce(trim(p_display_name), '') = '' then
    raise exception 'display name required';
  end if;

  -- One field, three bands, no date of birth. 18.2.
  if p_age_band is null or p_age_band not in ('under_13', '13_17', '18_plus') then
    raise exception 'age band required';
  end if;
  if p_age_band = 'under_13' then
    raise exception 'must be 13 or older';
  end if;

  -- The organization comes from the instance the person is standing on,
  -- resolved by hostname before this is called. Never from the email domain.
  select * into v_org from public.organizations o where o.slug = p_org_slug;
  if v_org.id is null then
    raise exception 'unknown organization %', p_org_slug;
  end if;
  if v_org.status <> 'active' then
    raise exception 'organization is not accepting signups';
  end if;

  select au.email into v_email from auth.users au where au.id = v_uid;

  select i.identity_data ->> 'hd' into v_hd
    from auth.identities i
   where i.user_id = v_uid and i.identity_data ->> 'hd' is not null
   limit 1;

  /* Google does not always return the hd claim, and Supabase does not always
     persist it. The verified email address carries the same information: a
     provider that confirmed the address confirmed the domain with it. hd is
     preferred where present because it is the narrower claim. */
  if v_hd is null and v_email is not null then
    v_hd := split_part(lower(v_email), '@', 2);
  end if;

  -- A domain listed on THIS organization establishes population and
  -- affiliation. A domain listed on some other tenant means nothing here.
  if v_hd is not null then
    select d.population, d.grants_affiliation
      into v_domain_pop, v_domain_ok
      from public.org_domains d
     where d.org_id = v_org.id and d.domain = v_hd;
  end if;

  if v_domain_pop is not null then
    v_population := v_domain_pop;
    if v_domain_ok then
      v_affil := 'domain_verified';
    end if;
  elsif v_org.signup_mode = 'domain' then
    raise exception
      'This account (%) is not on a domain % recognizes. Sign in with your school account.',
      v_email, v_org.lockup_name;
  elsif v_org.signup_mode = 'open' then
    -- An open tenant has no district behind it and asks for no mentor.
    v_population := 'student';
    v_affil := case when v_org.requires_mentor then 'unverified'
                    else 'mentor_verified' end;
  end if;

  if p_grad_year is not null
     and p_grad_year not between v_year and v_year + 4 then
    raise exception 'graduation year out of range';
  end if;

  v_consent := case when p_age_band = '18_plus' then 'not_required' else 'pending' end;

  insert into public.users
    (id, org_id, display_name, grad_year, population, status,
     affiliation_state, affiliation_verified_at,
     consent_state, consent_requested_at, age_band, age_attested_at)
  values
    (v_uid, v_org.id, trim(p_display_name), p_grad_year, v_population,
     case when v_affil = 'unverified' then 'unaffiliated' else 'active' end,
     v_affil,
     case when v_affil = 'domain_verified' then now() end,
     v_consent,
     case when v_consent = 'pending' then now() end,
     p_age_band, now());

  perform public.sync_identities();
  perform set_config('app.system_grant', 'on', true);  -- transaction local

  if v_population = 'student' then
    insert into public.user_roles (org_id, user_id, role, granted_at)
    values (v_org.id, v_uid, 'student', now())
    on conflict do nothing;
  end if;

  -- An adult is never asked for a guardian. A minor always is.
  if v_consent = 'pending' and p_guardian_email is not null then
    insert into public.guardian_consents
      (org_id, user_id, guardian_name, guardian_email)
    values (v_org.id, v_uid, coalesce(p_guardian_name, ''), lower(p_guardian_email));
  end if;

  -- Pending grants. Org scoped, and for a domain tenant also domain checked,
  -- so a privileged grant can never be aimed at an arbitrary address. 11.8.
  for v_grant in
    select g.*
      from public.pending_role_grants g
     where g.org_id = v_org.id
       and lower(g.email) = lower(v_email)
       and g.consumed_at is null
       and g.expires_at > now()
       and (
         g.role = 'student'
         or v_org.signup_mode = 'open'
         or exists (
           select 1 from public.org_domains d
            where d.org_id = v_org.id
              and d.domain = split_part(lower(v_email), '@', 2)
         )
       )
  loop
    insert into public.user_roles (org_id, user_id, role, granted_at)
    values (v_org.id, v_uid, v_grant.role, now())
    on conflict do nothing;

    update public.pending_role_grants
       set consumed_at = now(), consumed_by = v_uid
     where id = v_grant.id;

    perform app.audit(
      v_org.id, 'role.granted.from_seed', 'user_roles', v_uid,
      null, jsonb_build_object('role', v_grant.role, 'source', 'pending_role_grant'),
      v_grant.note
    );
  end loop;

  perform set_config('app.system_grant', 'off', true);

  perform app.audit(v_org.id, 'user.signup', 'users', v_uid, null,
    jsonb_build_object('population', v_population, 'affiliation', v_affil,
                       'age_band', p_age_band));

  return v_uid;
end;
$$;

grant execute on function
  public.complete_signup(text, text, text, int, text, text)
to authenticated;


-- ===========================================================================
-- PROVISIONING
--
-- Adding an organization is one call. It is a deliberate act and is never
-- self serve, which is why this lives here and is invoked from a migration
-- rather than exposed to the API.
-- ===========================================================================

create or replace function app.provision_org(
  p_slug        text,
  p_hostname    text,
  p_lockup_name text,
  p_mark        text,
  p_theme       text,
  p_signup_mode text  default 'domain',
  p_domains     jsonb default '[]'::jsonb,
  p_address     text  default null,
  p_phone       text  default null,
  p_requires_mentor boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  d     jsonb;
begin
  insert into public.organizations
    (slug, hostname, lockup_name, mark, theme, signup_mode,
     requires_mentor, postal_address, phone, status)
  values
    (p_slug, p_hostname, p_lockup_name, p_mark, p_theme, p_signup_mode,
     p_requires_mentor, p_address, p_phone, 'active')
  on conflict (slug) do update set hostname = excluded.hostname
  returning id into v_org;

  for d in select * from jsonb_array_elements(p_domains)
  loop
    insert into public.org_domains (org_id, domain, population, grants_affiliation)
    values (v_org, d ->> 'domain', d ->> 'population',
            coalesce((d ->> 'grants_affiliation')::boolean, true))
    on conflict (org_id, domain) do nothing;
  end loop;

  return v_org;
end;
$$;


-- ===========================================================================
-- GUARDS
--
-- Policies cannot restrict columns, so the columns that carry authority are
-- protected by triggers instead.
-- ===========================================================================

create or replace function app.guard_users_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select app.is_staff()) then
    return new;
  end if;

  if new.org_id is distinct from old.org_id
     or new.status is distinct from old.status
     or new.population is distinct from old.population
     or new.affiliation_state is distinct from old.affiliation_state
     or new.consent_state is distinct from old.consent_state
     or (old.author_slug is not null and new.author_slug is distinct from old.author_slug)
  then
    raise exception 'field is not self editable';
  end if;

  return new;
end;
$$;

create trigger users_guard_update
  before update on public.users
  for each row execute function app.guard_users_update();

create or replace function app.guard_role_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return new;  -- service role and migrations
  end if;

  /* The baseline student role and a consumed pending grant are both grants
     to the person signing in, and both are correct. They are marked by a
     transaction-local setting that only a SECURITY DEFINER function in this
     migration sets, so a client insert can never claim it. */
  if coalesce(current_setting('app.system_grant', true), '') = 'on' then
    return new;
  end if;

  if new.user_id = auth.uid() then
    raise exception 'a role may not be granted to yourself';
  end if;

  if new.role = 'mentor' and not (select app.is_staff()) then
    raise exception 'only an officer or a mentor may grant the mentor role';
  end if;

  return new;
end;
$$;

create trigger user_roles_guard_grant
  before insert on public.user_roles
  for each row execute function app.guard_role_grant();


-- ===========================================================================
-- ROW LEVEL SECURITY
-- ===========================================================================

alter table public.organizations       enable row level security;
alter table public.org_domains         enable row level security;
alter table public.users               enable row level security;
alter table public.identities          enable row level security;
alter table public.user_roles          enable row level security;
alter table public.guardian_consents   enable row level security;
alter table public.confirmation_tokens enable row level security;
alter table public.pending_role_grants enable row level security;
alter table public.audit_log           enable row level security;
alter table public.notifications       enable row level security;

-- ---------------------------------------------------------------------------
-- TABLE GRANTS.
--
-- Row level security and table privileges are two separate layers, and RLS
-- alone is not enough: a role with a policy but no GRANT gets "permission
-- denied for table", which looks exactly like an empty result if the caller
-- swallows the error. Supabase's default privileges did not reach tables
-- created by this migration, so they are granted explicitly here rather than
-- assumed.
--
-- Granting broadly to authenticated is the standard model and is safe only
-- because every table above has RLS enabled and policies that are deny by
-- default. anon receives nothing at all: the public archive never touches
-- the database, which is the rule in 12.3.
-- ---------------------------------------------------------------------------

grant usage on schema public to authenticated, service_role;
grant usage on schema app to service_role;

grant select, insert, update on all tables in schema public
  to authenticated, service_role;

grant usage, select on all sequences in schema public
  to authenticated, service_role;

grant execute on all functions in schema app to service_role;

-- Nothing in this system is ever hard deleted. Removal is a state column or
-- an archived_at timestamp, so DELETE is withheld from every client role and
-- a policy cannot hand it back.
revoke delete on all tables in schema public from authenticated, service_role;

-- organizations, org_domains ------------------------------------------------
create policy organizations_read_own on public.organizations
  for select to authenticated
  using (id = (select app.org_id()));

create policy org_domains_read_own on public.org_domains
  for select to authenticated
  using (org_id = (select app.org_id()));

-- users ---------------------------------------------------------------------
-- Readable across the organization, deliberately. Co-authors need each
-- other's names, policies cannot hide columns, and once school is dropped
-- the row holds a display name, a graduation year, and author page fields
-- that are public by design. Email lives in identities, which is not
-- readable across the org.
create policy users_read_org on public.users
  for select to authenticated
  using (org_id = (select app.org_id()));

create policy users_update_self on public.users
  for update to authenticated
  using (id = (select auth.uid()) or (select app.is_staff()))
  with check (org_id = (select app.org_id()));

-- identities ----------------------------------------------------------------
create policy identities_read_self on public.identities
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (org_id = (select app.org_id()) and (select app.is_staff()))
  );
-- No insert, update, or delete policy. Written only by sync_identities().

-- user_roles ----------------------------------------------------------------
create policy user_roles_read on public.user_roles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (org_id = (select app.org_id()) and (select app.is_staff()))
  );

create policy user_roles_grant on public.user_roles
  for insert to authenticated
  with check (
    org_id = (select app.org_id())
    and ((select app.has_role('officer')) or (select app.is_staff()))
  );

create policy user_roles_revoke on public.user_roles
  for update to authenticated
  using (
    org_id = (select app.org_id())
    and ((select app.has_role('officer')) or (select app.is_staff()))
  );

-- guardian_consents -----------------------------------------------------------
-- confirmed_at is written only by the unauthenticated confirmation endpoint,
-- which runs as service role. A student may correct a mistyped address,
-- which 18.3 names as the most common cause of a stuck account.
create policy guardian_consents_read on public.guardian_consents
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (org_id = (select app.org_id()) and (select app.is_staff()))
  );

create policy guardian_consents_insert on public.guardian_consents
  for insert to authenticated
  with check (user_id = (select auth.uid()) and org_id = (select app.org_id()));

create policy guardian_consents_update_own on public.guardian_consents
  for update to authenticated
  using (user_id = (select auth.uid()) and confirmed_at is null)
  with check (user_id = (select auth.uid()));

-- confirmation_tokens -------------------------------------------------------
-- No policies at all. Service role only. Row level security is row level, so
-- a token column on a consent row would be readable by the student it
-- belongs to. This table is unreadable by any user session.

-- pending_role_grants -------------------------------------------------------
create policy pending_role_grants_read on public.pending_role_grants
  for select to authenticated
  using (org_id = (select app.org_id()) and (select app.is_staff()));

-- audit_log -----------------------------------------------------------------
create policy audit_log_read_staff on public.audit_log
  for select to authenticated
  using (org_id = (select app.org_id()) and (select app.is_staff()));

-- Append only, enforced by the grant rather than by the absence of a policy,
-- so a later migration that adds a policy cannot quietly make it writable.
-- This runs after the blanket grant above, deliberately.
revoke update, delete on public.audit_log from authenticated, anon, service_role;
revoke update, delete on public.confirmation_tokens from authenticated, anon;

-- notifications -------------------------------------------------------------
create policy notifications_read_own on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));


-- ===========================================================================
-- TENANTS
--
-- Data rather than shape, and it belongs here anyway: a school is not demo
-- content, it is the first true fact the system holds, and it has to reach
-- production. Anything that must NOT reach production goes in seed.sql.
--
-- The hostname resolves the tenant. An email domain never does: a district
-- issues one pair of domains across every school it runs, so the two schools
-- below share both domains and are told apart only by the URL.
--
-- No accounts and no roles are seeded. A migration cannot create an account
-- for a person who has never authenticated, because users.id is auth.users.id.
-- ===========================================================================

-- Tenant one. Domain signup only. Students and staff on separate domains,
-- both granting affiliation without a club mentor.
select app.provision_org(
  p_slug        => 'montavista',
  p_hostname    => 'montavista.localhost',
  p_lockup_name => 'Monta Vista High School',
  p_mark        => 'MVHS',
  p_theme       => 'proceedings',
  p_signup_mode => 'domain',
  p_domains     => '[
    {"domain": "student.fuhsd.org", "population": "student"},
    {"domain": "fuhsd.org",         "population": "staff"}
  ]'::jsonb,
  p_address     => '21840 McClellan Road, Cupertino, CA 95014',
  p_phone       => '408.366.7600'
);

-- Tenant two. Exactly the same two domains, deliberately. This is the case
-- that proves a domain cannot identify a school, and it is the reason
-- org_domains stopped keying on the domain alone.
select app.provision_org(
  p_slug        => 'lynbrook',
  p_hostname    => 'lynbrook.localhost',
  p_lockup_name => 'Lynbrook High School',
  p_mark        => 'LHS',
  p_theme       => 'proceedings',
  p_signup_mode => 'domain',
  p_domains     => '[
    {"domain": "student.fuhsd.org", "population": "student"},
    {"domain": "fuhsd.org",         "population": "staff"}
  ]'::jsonb
);

-- Tenant three. Open signup: no domain, no district, no club mentor.
-- Anyone may create an account and track a project. Many high schoolers are
-- already adults, which is why the age gate carries three bands rather than
-- one checkbox.
select app.provision_org(
  p_slug             => 'blueleaflabs',
  p_hostname         => 'open.localhost',
  p_lockup_name      => 'Open Program',
  p_mark             => 'OPEN',
  p_theme            => 'entry',
  p_signup_mode      => 'open',
  p_domains          => '[]'::jsonb,
  p_requires_mentor => false
);


-- ===========================================================================
-- PROGRAMS, PROJECTS, ENTRIES, MILESTONES
--
-- A PROGRAM is one fair in one season: the SCVSEFA Science Fair 2027, not
-- "the SCVSEFA Science Fair". Dates belong to a season and nothing else.
--
-- A PROGRAM_MILESTONE is one dated obligation in that program. org_id is
-- nullable and that nullability is the whole design: null means every school
-- in the program has this deadline, and a value means only that school does.
-- A district fair and one school's earlier internal deadlines are the same
-- table, which is what makes "common plus per school" free.
--
-- An ENTRY is one project in one program. Entering copies the milestones onto
-- the entry, so a program changing its dates mid-season never silently
-- rewrites what a student was told.
-- ===========================================================================

create table public.programs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid references public.organizations on delete restrict,
  slug          text not null,
  name          text not null,
  season_year   int not null,                  -- the year the fair is held
  fair_date     date,
  registration_opens_on date,
  source        text not null default 'external'
                  check (source in ('external', 'internal')),
  advances_to   text,                          -- where placing sends you next
  status        text not null default 'open'
                  check (status in ('draft', 'open', 'closed', 'archived')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (slug, season_year)
);

comment on column public.programs.org_id is
  'Null for a fair that many schools enter. Set for a school''s own event.';

create table public.program_milestones (
  id           uuid primary key default gen_random_uuid(),
  program_id   uuid not null references public.programs on delete restrict,
  org_id       uuid references public.organizations on delete restrict,
  name         text not null,
  kind         text not null check (kind in
                 ('form', 'approval', 'registration', 'submission', 'judging', 'local')),
  due_on       date,
  opens_on     date,
  required     boolean not null default true,
  blocks_experimentation boolean not null default false,
  form_number  text,
  source_url   text,
  notes        text,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on column public.program_milestones.org_id is
  'Null applies to every school in the program. Set applies to one school.';

comment on column public.program_milestones.blocks_experimentation is
  'True where the obligation must be satisfied before work starts. This is '
  'what the date ordering check reads: a research start date preceding one of '
  'these is the disqualification that catches students every year.';

create index program_milestones_program_idx
  on public.program_milestones (program_id, sort_order);

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete restrict,
  title       text not null,
  question    text,
  discipline  text,
  stage       text not null default 'registered'
                check (stage in ('registered', 'in_progress', 'fair_ready', 'competed', 'published')),
  started_on  date,                           -- the day experimentation began
  created_by  uuid not null references public.users on delete restrict,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on column public.projects.started_on is
  'The day work actually began. Compared against every blocking milestone.';

create index projects_org_idx on public.projects (org_id);

create table public.project_authors (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete restrict,
  project_id  uuid not null references public.projects on delete restrict,
  user_id     uuid not null references public.users on delete restrict,
  role        text not null default 'author'
                check (role in ('author', 'mentor', 'officer')),
  accepted_at timestamptz,
  invited_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, user_id)
);

create index project_authors_user_idx on public.project_authors (user_id);

create table public.entries (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete restrict,
  project_id  uuid not null references public.projects on delete restrict,
  program_id  uuid not null references public.programs on delete restrict,
  status      text not null default 'entered'
                check (status in ('entered', 'withdrawn', 'competed')),
  placement   text,
  entered_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, program_id)
);

create table public.entry_milestones (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations on delete restrict,
  entry_id             uuid not null references public.entries on delete restrict,
  program_milestone_id uuid references public.program_milestones on delete restrict,
  name                 text not null,
  kind                 text not null,
  due_on               date,
  required             boolean not null default true,
  blocks_experimentation boolean not null default false,
  completed_on         date,
  completed_by         uuid references public.users on delete restrict,
  sort_order           int not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index entry_milestones_entry_idx
  on public.entry_milestones (entry_id, sort_order);

do $$
declare t text;
begin
  foreach t in array array[
    'programs', 'program_milestones', 'projects', 'project_authors',
    'entries', 'entry_milestones'
  ] loop
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function app.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- Entering a fair copies the milestones onto the entry.
--
-- A copy rather than a reference, because a program that moves a date in
-- February must not silently rewrite what a student was told in September.
-- The copy is what they are held to; the program is what the fair publishes.
-- ---------------------------------------------------------------------------

create or replace function public.enter_program(
  p_project_id uuid,
  p_program_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_entry uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select p.org_id into v_org
    from public.projects p
   where p.id = p_project_id
     and exists (
       select 1 from public.project_authors a
        where a.project_id = p.id and a.user_id = v_uid and a.role = 'author'
     );

  if v_org is null then
    raise exception 'not an author on that project';
  end if;

  insert into public.entries (org_id, project_id, program_id)
  values (v_org, p_project_id, p_program_id)
  on conflict (project_id, program_id) do update set status = 'entered'
  returning id into v_entry;

  insert into public.entry_milestones
    (org_id, entry_id, program_milestone_id, name, kind, due_on, required,
     blocks_experimentation, sort_order)
  select v_org, v_entry, m.id, m.name, m.kind, m.due_on, m.required,
         m.blocks_experimentation, m.sort_order
    from public.program_milestones m
   where m.program_id = p_program_id
     and (m.org_id is null or m.org_id = v_org)
     and not exists (
       select 1 from public.entry_milestones e
        where e.entry_id = v_entry and e.program_milestone_id = m.id
     );

  perform app.audit(v_org, 'entry.created', 'entries', v_entry, null,
    jsonb_build_object('project_id', p_project_id, 'program_id', p_program_id));

  return v_entry;
end;
$$;

grant execute on function public.enter_program(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.programs           enable row level security;
alter table public.program_milestones enable row level security;
alter table public.projects           enable row level security;
alter table public.project_authors    enable row level security;
alter table public.entries            enable row level security;
alter table public.entry_milestones   enable row level security;

grant select, insert, update on public.programs, public.program_milestones,
  public.projects, public.project_authors, public.entries,
  public.entry_milestones to authenticated, service_role;
revoke delete on public.programs, public.program_milestones, public.projects,
  public.project_authors, public.entries, public.entry_milestones
  from authenticated, service_role;

-- A program with no org is a fair many schools enter, so everyone signed in
-- may read it. Writing one is an officer or mentor act.
create policy programs_read on public.programs
  for select to authenticated
  using (org_id is null or org_id = (select app.org_id()));

create policy programs_write on public.programs
  for insert to authenticated
  with check ((select app.has_role('officer')) or (select app.is_staff()));

create policy program_milestones_read on public.program_milestones
  for select to authenticated
  using (org_id is null or org_id = (select app.org_id()));

create policy program_milestones_write on public.program_milestones
  for insert to authenticated
  with check (
    org_id = (select app.org_id())
    and ((select app.has_role('officer')) or (select app.is_staff()))
  );

create policy projects_read on public.projects
  for select to authenticated
  using (
    org_id = (select app.org_id())
    and (
      exists (
        select 1 from public.project_authors a
         where a.project_id = projects.id and a.user_id = (select auth.uid())
      )
      or (select app.is_staff())
    )
  );

create policy projects_create on public.projects
  for insert to authenticated
  with check (
    org_id = (select app.org_id())
    and created_by = (select auth.uid())
    and (select app.has_role('student'))
  );

create policy projects_update on public.projects
  for update to authenticated
  using (
    exists (
      select 1 from public.project_authors a
       where a.project_id = projects.id
         and a.user_id = (select auth.uid())
         and a.role = 'author'
         and a.accepted_at is not null
    )
  );

create policy project_authors_read on public.project_authors
  for select to authenticated
  using (org_id = (select app.org_id()));

create policy project_authors_write on public.project_authors
  for insert to authenticated
  with check (org_id = (select app.org_id()));

create policy project_authors_update on public.project_authors
  for update to authenticated
  using (user_id = (select auth.uid()) or (select app.is_staff()));

create policy entries_read on public.entries
  for select to authenticated
  using (
    exists (
      select 1 from public.project_authors a
       where a.project_id = entries.project_id and a.user_id = (select auth.uid())
    )
    or (select app.is_staff())
  );

create policy entries_write on public.entries
  for update to authenticated
  using (
    exists (
      select 1 from public.project_authors a
       where a.project_id = entries.project_id and a.user_id = (select auth.uid())
    )
  );

create policy entry_milestones_read on public.entry_milestones
  for select to authenticated
  using (
    exists (
      select 1
        from public.entries e
        join public.project_authors a on a.project_id = e.project_id
       where e.id = entry_id and a.user_id = (select auth.uid())
    )
    or (select app.is_staff())
  );

create policy entry_milestones_update on public.entry_milestones
  for update to authenticated
  using (
    exists (
      select 1
        from public.entries e
        join public.project_authors a on a.project_id = e.project_id
       where e.id = entry_id
         and a.user_id = (select auth.uid())
         and a.role = 'author'
    )
  );


-- ===========================================================================
-- SEED: the 2027 season.
--
-- Two sources in one program. The rows with no org_id are the fair's own
-- deadlines and apply to every school entering it. The rows carrying an
-- org_id are one school's internal deadlines, which run earlier and exist to
-- make the fair's deadlines survivable.
--
-- Dates are hard calendar dates because that is how they were published. A
-- later season is a new program row, not an edit to this one.
-- ===========================================================================

do $$
declare
  v_program uuid;
  v_mv      uuid;
begin
  select id into v_mv from public.organizations where slug = 'montavista';

  insert into public.programs
    (org_id, slug, name, season_year, fair_date, source, status)
  values
    (null, 'scvsefa-science-fair', 'SCVSEFA Science Fair', 2027,
     date '2027-03-10', 'external', 'open')
  on conflict (slug, season_year) do nothing
  returning id into v_program;

  if v_program is null then
    select id into v_program from public.programs
     where slug = 'scvsefa-science-fair' and season_year = 2027;
  end if;

  -- The fair's own deadlines. Every school entering sees these.
  insert into public.program_milestones
    (program_id, org_id, name, kind, due_on, blocks_experimentation, sort_order)
  values
    (v_program, null, 'SRC submission deadline',                    'submission', date '2026-11-14', true,  60),
    (v_program, null, 'Non-SRC submission deadline',                'submission', date '2027-01-12', false, 70),
    (v_program, null, 'Last day to change title, category, or field of study', 'submission', date '2027-02-20', false, 80),
    (v_program, null, 'Final deadline to upload abstracts',         'submission', date '2027-02-27', false, 90),
    (v_program, null, 'Last day to edit abstracts',                 'submission', date '2027-03-03', false, 100),
    (v_program, null, 'SCVSEFA Science Fair',                      'judging',    date '2027-03-10', false, 120)
  on conflict do nothing;

  -- One school's internal deadlines, which run earlier on purpose.
  insert into public.program_milestones
    (program_id, org_id, name, kind, due_on, blocks_experimentation, sort_order)
  values
    (v_program, v_mv, 'Project categories due',      'submission', date '2026-09-18', false, 10),
    (v_program, v_mv, 'General research idea due',   'submission', date '2026-10-02', false, 20),
    (v_program, v_mv, 'Specific research idea due',  'submission', date '2026-10-09', false, 30),
    (v_program, v_mv, 'Teacher project sponsor named','approval',  date '2026-10-16', true,  40),
    (v_program, v_mv, 'Proposal deadline',           'submission', date '2026-10-23', false, 50),
    (v_program, v_mv, 'Mock judging',                'judging',    date '2027-03-05', false, 110)
  on conflict do nothing;
end $$;



-- ---------------------------------------------------------------------------
-- Starting a project and entering it, in one statement.
--
-- Doing this as three client calls put three row level security surfaces in
-- the path of one user action, and made partial failure possible: a project
-- with no author, or an author with no entry. It is also the case where
-- INSERT ... RETURNING needs a SELECT policy to pass on a row whose author
-- link does not exist yet, which is a genuinely confusing failure.
--
-- One function, one transaction, one thing that can go wrong.
-- ---------------------------------------------------------------------------

create or replace function public.start_entry(
  p_program_id uuid,
  p_title      text,
  p_started_on date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_org     uuid;
  v_status  text;
  v_project uuid;
  v_entry   uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select u.org_id, u.status into v_org, v_status
    from public.users u where u.id = v_uid;

  if v_org is null then
    raise exception 'finish signing up first';
  end if;

  if v_status = 'suspended' then
    raise exception 'this account is suspended';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'give the project a working title';
  end if;

  -- The program is either open to every school or belongs to this one.
  if not exists (
    select 1 from public.programs p
     where p.id = p_program_id
       and p.status = 'open'
       and (p.org_id is null or p.org_id = v_org)
  ) then
    raise exception 'that fair is not open to this school';
  end if;

  insert into public.projects (org_id, title, started_on, created_by)
  values (v_org, trim(p_title), p_started_on, v_uid)
  returning id into v_project;

  insert into public.project_authors
    (org_id, project_id, user_id, role, accepted_at)
  values (v_org, v_project, v_uid, 'author', now());

  insert into public.entries (org_id, project_id, program_id)
  values (v_org, v_project, p_program_id)
  returning id into v_entry;

  insert into public.entry_milestones
    (org_id, entry_id, program_milestone_id, name, kind, due_on, required,
     blocks_experimentation, sort_order)
  select v_org, v_entry, m.id, m.name, m.kind, m.due_on, m.required,
         m.blocks_experimentation, m.sort_order
    from public.program_milestones m
   where m.program_id = p_program_id
     and (m.org_id is null or m.org_id = v_org);

  perform app.audit(v_org, 'entry.created', 'entries', v_entry, null,
    jsonb_build_object('project_id', v_project, 'program_id', p_program_id));

  return v_entry;
end;
$$;

grant execute on function public.start_entry(uuid, text, date) to authenticated;

-- PostgREST caches the schema. A function added by a migration is invisible
-- to the API until it reloads, which presents as "could not find the
-- function ... in the schema cache" even though it exists.
notify pgrst, 'reload schema';

-- Creating a project no longer requires the student role. An officer running
-- a demonstration, and a staff account helping a student set one up, both
-- have legitimate reason to, and the author link is what actually confers
-- editing rights.
drop policy if exists projects_create on public.projects;

create policy projects_create on public.projects
  for insert to authenticated
  with check (
    org_id = (select app.org_id())
    and created_by = (select auth.uid())
  );

-- INSERT ... RETURNING needs SELECT to pass on the new row, whose author
-- link is written in the next statement. The creator can always read it.
drop policy if exists projects_read on public.projects;

create policy projects_read on public.projects
  for select to authenticated
  using (
    org_id = (select app.org_id())
    and (
      created_by = (select auth.uid())
      or exists (
        select 1 from public.project_authors a
         where a.project_id = projects.id and a.user_id = (select auth.uid())
      )
      or (select app.is_staff())
    )
  );


-- ---------------------------------------------------------------------------
-- Editing an entry.
--
-- A row level security policy that excludes a row makes UPDATE affect zero
-- rows and return no error at all. The client sees success, the value does
-- not change, and there is nothing to read. Both of these raise instead.
-- ---------------------------------------------------------------------------

create or replace function app.authors_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.project_authors a
     where a.project_id = p_project_id
       and a.user_id = auth.uid()
       and a.role = 'author'
  );
$$;

create or replace function public.set_project_start(
  p_project_id uuid,
  p_started_on date
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_was date;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not app.authors_project(p_project_id) then
    raise exception 'you are not an author on this project';
  end if;

  select p.org_id, p.started_on into v_org, v_was
    from public.projects p where p.id = p_project_id;

  update public.projects
     set started_on = p_started_on
   where id = p_project_id;

  perform app.audit(v_org, 'project.start_date', 'projects', p_project_id,
    jsonb_build_object('started_on', v_was),
    jsonb_build_object('started_on', p_started_on));

  return p_started_on;
end;
$$;

create or replace function public.set_milestone_done(
  p_milestone_id uuid,
  p_completed_on date
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_org     uuid;
  v_name    text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select e.project_id, m.org_id, m.name into v_project, v_org, v_name
    from public.entry_milestones m
    join public.entries e on e.id = m.entry_id
   where m.id = p_milestone_id;

  if v_project is null then
    raise exception 'no such obligation';
  end if;

  if not app.authors_project(v_project) then
    raise exception 'you are not an author on this project';
  end if;

  update public.entry_milestones
     set completed_on = p_completed_on,
         completed_by = case when p_completed_on is null then null else auth.uid() end
   where id = p_milestone_id;

  perform app.audit(v_org,
    case when p_completed_on is null then 'milestone.reopened' else 'milestone.completed' end,
    'entry_milestones', p_milestone_id, null,
    jsonb_build_object('name', v_name, 'completed_on', p_completed_on));

  return p_completed_on;
end;
$$;

grant execute on function public.set_project_start(uuid, date) to authenticated;
grant execute on function public.set_milestone_done(uuid, date) to authenticated;
grant execute on function app.authors_project(uuid) to authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- Attaching a mentor or an officer to a project.
--
-- The mentor IS the sponsor. There is no separate request-and-confirm dance:
-- a student naming an address and waiting for someone to click a link is two
-- steps and a stalled account, and the fair only cares that a teacher has
-- taken responsibility for the project. Attaching a mentor is that teacher
-- taking responsibility, so attaching is the approval.
--
-- Attaching therefore does three things at once, because they are one act:
-- it records who is watching, it verifies the authors' affiliation, and it
-- satisfies every approval obligation waiting on a sponsor.
--
-- A mentor comments and flags. They never author. That boundary is the
-- pedagogy: independent work is ten of the forty rubric points and judges
-- probe it directly.
-- ---------------------------------------------------------------------------

create or replace function public.attach_to_project(
  p_project_id uuid,
  p_user_id    uuid,
  p_role       text,
  p_dated      date default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_on     date := coalesce(p_dated, current_date);
  v_marked int := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_role not in ('mentor', 'officer') then
    raise exception 'a project takes a mentor or an officer';
  end if;

  if not app.is_staff() then
    raise exception 'only an officer or a mentor may attach someone to a project';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such project at this school';
  end if;

  if not exists (
    select 1 from public.users u where u.id = p_user_id and u.org_id = v_org
  ) then
    raise exception 'that person is not at this school';
  end if;

  if exists (
    select 1 from public.project_authors a
     where a.project_id = p_project_id and a.user_id = p_user_id and a.role = 'author'
  ) then
    raise exception 'an author on the project cannot also oversee it';
  end if;

  insert into public.project_authors
    (org_id, project_id, user_id, role, accepted_at)
  values (v_org, p_project_id, p_user_id, p_role, now())
  on conflict (project_id, user_id) do update
    set role = excluded.role, accepted_at = now();

  -- A mentor is the sponsor, so attaching one clears what a sponsor clears.
  if p_role = 'mentor' then
    update public.entry_milestones em
       set completed_on = v_on, completed_by = auth.uid()
      from public.entries e
     where e.id = em.entry_id
       and e.project_id = p_project_id
       and em.kind = 'approval'
       and em.completed_on is null;

    get diagnostics v_marked = row_count;

    update public.users u
       set affiliation_state = 'mentor_verified',
           affiliation_verified_at = now(),
           status = case when u.status = 'unaffiliated' then 'active' else u.status end
      from public.project_authors a
     where a.project_id = p_project_id
       and a.role = 'author'
       and a.user_id = u.id
       and u.affiliation_state = 'unverified';
  end if;

  perform app.audit(v_org, 'project.attached', 'projects', p_project_id, null,
    jsonb_build_object('user', p_user_id, 'role', p_role,
                       'approvals_cleared', v_marked));

  return v_marked;
end;
$$;

create or replace function public.detach_from_project(
  p_project_id uuid,
  p_user_id    uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_staff() then
    raise exception 'only an officer or a mentor may detach someone';
  end if;

  delete from public.project_authors
   where project_id = p_project_id
     and user_id = p_user_id
     and role in ('mentor', 'officer');

  perform app.audit(app.org_id(), 'project.detached', 'projects', p_project_id,
    jsonb_build_object('user', p_user_id), null);
end;
$$;

grant execute on function public.attach_to_project(uuid, uuid, text, date) to authenticated;
grant execute on function public.detach_from_project(uuid, uuid) to authenticated;

-- Staff need to see who holds which role in order to attach one.
create policy user_roles_read_staff on public.user_roles
  for select to authenticated
  using (org_id = (select app.org_id()) and (select app.is_staff()));

-- And need to see everyone at the school to pick from.
-- users_read_org already permits this.

notify pgrst, 'reload schema';


-- ===========================================================================
-- DELIVERABLES, FIELD NOTES, LINKS
--
-- A milestone is WHEN. A deliverable is WHAT, and it is where the signature
-- dates live. The distinction matters for one specific reason: the check the
-- whole system is justified by compares a form's SIGNED date against the day
-- work began, and a student ticking "done" is not a signed form (11.3).
--
-- Field notes are the primary working surface and the universal primitive.
-- Append only, each attributed and timestamped. A correction is a new entry
-- pointing at the one it corrects, never an edit, which sidesteps concurrent
-- editing and is what makes the exported notebook defensible.
--
-- Honest framing, kept from 7.2: timestamped notes are a discipline device,
-- not tamper-proof evidence. We control this database. The export says what
-- it can support and no more.
-- ===========================================================================

create table public.deliverables (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations on delete restrict,
  entry_id     uuid not null references public.entries on delete restrict,
  milestone_id uuid references public.entry_milestones on delete restrict,

  type         text not null,          -- form_1|form_1a|form_1b|abstract|...
  label        text not null,

  -- One of the two. A file we hold, or a link we store and never fetch (7.4).
  storage_path text,
  external_url text,

  -- The date on the signature, which is not the date it was uploaded and is
  -- the only one the ordering check may use.
  signed_on    date,

  required     boolean not null default true,
  submitted_at timestamptz,
  verified_by  uuid references public.users on delete restrict,
  verified_at  timestamptz,
  created_by   uuid not null references public.users on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index deliverables_entry_idx on public.deliverables (entry_id);
create index deliverables_milestone_idx on public.deliverables (milestone_id);

create table public.field_notes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete restrict,
  project_id  uuid not null references public.projects on delete restrict,
  author_id   uuid not null references public.users on delete restrict,

  -- Markdown, with a deliberately small vocabulary. Not fonts and not
  -- colors: a notebook is a record, and styling produces worse notebooks and
  -- an export that looks like a ransom note.
  body_md     text not null check (char_length(trim(body_md)) > 0),

  -- The day the work happened, which is not always the day it was written up.
  occurred_on date not null default current_date,

  -- A correction points at what it corrects. Nothing is ever edited.
  corrects_id uuid references public.field_notes on delete restrict,

  seq         bigserial,
  created_at  timestamptz not null default now()
);

create index field_notes_project_idx
  on public.field_notes (project_id, occurred_on, seq);

create table public.note_media (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations on delete restrict,
  note_id      uuid not null references public.field_notes on delete restrict,
  storage_path text not null,
  caption      text,
  created_at   timestamptz not null default now()
);

create index note_media_note_idx on public.note_media (note_id);

create table public.project_links (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations on delete restrict,
  project_id uuid not null references public.projects on delete restrict,
  label      text not null,
  url        text not null,
  visibility text not null default 'private'
               check (visibility in ('private', 'published')),
  added_by   uuid not null references public.users on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index project_links_project_idx on public.project_links (project_id);

do $$
declare t text;
begin
  foreach t in array array['deliverables', 'project_links'] loop
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function app.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end $$;


-- ---------------------------------------------------------------------------
-- Append only, enforced by the grant.
--
-- A policy can be dropped by a later migration. A revoked privilege has to be
-- deliberately granted back, which is the difference between a rule and a
-- convention.
-- ---------------------------------------------------------------------------

alter table public.deliverables  enable row level security;
alter table public.field_notes   enable row level security;
alter table public.note_media    enable row level security;
alter table public.project_links enable row level security;

grant select, insert, update on public.deliverables, public.project_links
  to authenticated, service_role;
grant select, insert on public.field_notes, public.note_media
  to authenticated, service_role;
grant usage, select on sequence public.field_notes_seq_seq
  to authenticated, service_role;

revoke update, delete on public.field_notes, public.note_media
  from authenticated, anon, service_role;
revoke delete on public.deliverables, public.project_links
  from authenticated, service_role;

-- Everything here is scoped by the project it belongs to, and who may see a
-- project is already decided. These policies only have to ask the same
-- question in one more place.
create policy deliverables_read on public.deliverables
  for select to authenticated
  using (
    exists (
      select 1 from public.entries e
       where e.id = entry_id
         and (
           exists (select 1 from public.project_authors a
                    where a.project_id = e.project_id and a.user_id = (select auth.uid()))
           or (select app.is_staff())
         )
    )
  );

create policy deliverables_write on public.deliverables
  for insert to authenticated
  with check (org_id = (select app.org_id()));

create policy deliverables_update on public.deliverables
  for update to authenticated
  using (org_id = (select app.org_id()));

create policy field_notes_read on public.field_notes
  for select to authenticated
  using (
    exists (select 1 from public.project_authors a
             where a.project_id = field_notes.project_id and a.user_id = (select auth.uid()))
    or (select app.is_staff())
  );

create policy note_media_read on public.note_media
  for select to authenticated
  using (
    exists (
      select 1 from public.field_notes n
       join public.project_authors a on a.project_id = n.project_id
      where n.id = note_id and a.user_id = (select auth.uid())
    )
    or (select app.is_staff())
  );

create policy project_links_read on public.project_links
  for select to authenticated
  using (
    exists (select 1 from public.project_authors a
             where a.project_id = project_links.project_id and a.user_id = (select auth.uid()))
    or (select app.is_staff())
  );

create policy project_links_write on public.project_links
  for insert to authenticated
  with check (org_id = (select app.org_id()) and added_by = (select auth.uid()));


-- ---------------------------------------------------------------------------
-- Files are not stored here.
--
-- Notebook photographs and signed forms live in Cloudflare R2, not in
-- Supabase Storage. The reason is a failure mode rather than a price: on the
-- Supabase free tier, crossing the egress allowance applies the Fair Use
-- Policy and every service returns 402 until the period resets, so a club
-- scrolling their own notebooks could take auth and the database offline
-- days before judging. R2 charges nothing for egress at all.
--
-- What the database keeps is the path. See src/lib/blob.ts, and 12.8.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Writing a note, attaching a deliverable, storing a link.
-- ---------------------------------------------------------------------------

create or replace function public.add_field_note(
  p_project_id  uuid,
  p_body_md     text,
  p_occurred_on date default null,
  p_corrects_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(trim(p_body_md), '') = '' then
    raise exception 'an empty note records nothing';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  if v_org is null then
    raise exception 'no such project';
  end if;

  -- Anyone attached to the project may write a note. A mentor's observation
  -- belongs in the record as much as a student's, and it is attributed, so
  -- the distinction is visible rather than enforced.
  if not exists (
    select 1 from public.project_authors a
     where a.project_id = p_project_id and a.user_id = auth.uid()
  ) then
    raise exception 'you are not attached to this project';
  end if;

  if p_corrects_id is not null and not exists (
    select 1 from public.field_notes n
     where n.id = p_corrects_id and n.project_id = p_project_id
  ) then
    raise exception 'that note is not on this project';
  end if;

  insert into public.field_notes
    (org_id, project_id, author_id, body_md, occurred_on, corrects_id)
  values
    (v_org, p_project_id, auth.uid(), trim(p_body_md),
     coalesce(p_occurred_on, current_date), p_corrects_id)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.attach_note_media(
  p_note_id      uuid,
  p_storage_path text,
  p_caption      text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  select n.org_id into v_org
    from public.field_notes n
    join public.project_authors a on a.project_id = n.project_id
   where n.id = p_note_id and a.user_id = auth.uid();

  if v_org is null then
    raise exception 'no such note on a project you are attached to';
  end if;

  insert into public.note_media (org_id, note_id, storage_path, caption)
  values (v_org, p_note_id, p_storage_path, p_caption)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.record_deliverable(
  p_entry_id     uuid,
  p_milestone_id uuid,
  p_type         text,
  p_label        text,
  p_signed_on    date,
  p_external_url text default null,
  p_storage_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_project uuid;
  v_id      uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select e.org_id, e.project_id into v_org, v_project
    from public.entries e where e.id = p_entry_id;

  if v_org is null then
    raise exception 'no such entry';
  end if;

  if not exists (
    select 1 from public.project_authors a
     where a.project_id = v_project and a.user_id = auth.uid()
  ) and not app.is_staff() then
    raise exception 'you are not attached to this project';
  end if;

  if coalesce(trim(p_label), '') = '' then
    raise exception 'give the deliverable a name';
  end if;

  insert into public.deliverables
    (org_id, entry_id, milestone_id, type, label, signed_on,
     external_url, storage_path, submitted_at, created_by)
  values
    (v_org, p_entry_id, p_milestone_id, p_type, trim(p_label), p_signed_on,
     nullif(trim(coalesce(p_external_url, '')), ''),
     nullif(trim(coalesce(p_storage_path, '')), ''),
     now(), auth.uid())
  returning id into v_id;

  -- A signed deliverable satisfies the obligation it hangs off. The date
  -- recorded is the SIGNATURE date, never today, because that is the date
  -- the ordering check compares against the day work began.
  if p_milestone_id is not null and p_signed_on is not null then
    update public.entry_milestones
       set completed_on = p_signed_on, completed_by = auth.uid()
     where id = p_milestone_id and completed_on is null;
  end if;

  perform app.audit(v_org, 'deliverable.recorded', 'deliverables', v_id, null,
    jsonb_build_object('type', p_type, 'signed_on', p_signed_on));

  return v_id;
end;
$$;

create or replace function public.verify_deliverable(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_staff() then
    raise exception 'only an officer or a club mentor may verify a deliverable';
  end if;

  update public.deliverables
     set verified_by = auth.uid(), verified_at = now()
   where id = p_id and org_id = app.org_id();

  perform app.audit(app.org_id(), 'deliverable.verified', 'deliverables', p_id,
    null, null);
end;
$$;

create or replace function public.add_project_link(
  p_project_id uuid,
  p_label      text,
  p_url        text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  if p_url !~* '^https?://' then
    raise exception 'a link has to start with http:// or https://';
  end if;

  select p.org_id into v_org
    from public.projects p
    join public.project_authors a on a.project_id = p.id
   where p.id = p_project_id and a.user_id = auth.uid();

  if v_org is null then
    raise exception 'you are not attached to this project';
  end if;

  insert into public.project_links (org_id, project_id, label, url, added_by)
  values (v_org, p_project_id, trim(p_label), trim(p_url), auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.add_field_note(uuid, text, date, uuid) to authenticated;
grant execute on function public.attach_note_media(uuid, text, text) to authenticated;
grant execute on function public.record_deliverable(uuid, uuid, text, text, date, text, text) to authenticated;
grant execute on function public.verify_deliverable(uuid) to authenticated;
grant execute on function public.add_project_link(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- Oversight watches. It does not do the work.
--
-- A club officer or mentor reads everything on a project and changes none of
-- it, with two exceptions that are theirs by definition: verifying a
-- deliverable, and adding an attributed observation to the notebook.
--
-- This is the pedagogy rather than a permission detail. Independent Work is
-- ten of the forty rubric points and judges ask about it directly, so if an
-- officer can edit a start date or record a form, the boundary a student is
-- being graded on is one the software quietly erased.
--
-- Hiding the controls is not the enforcement. This is.
-- ---------------------------------------------------------------------------

create or replace function public.record_deliverable(
  p_entry_id     uuid,
  p_milestone_id uuid,
  p_type         text,
  p_label        text,
  p_signed_on    date,
  p_external_url text default null,
  p_storage_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_project uuid;
  v_id      uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select e.org_id, e.project_id into v_org, v_project
    from public.entries e where e.id = p_entry_id;

  if v_org is null then
    raise exception 'no such entry';
  end if;

  -- Authors only. A mentor confirming a form they did not obtain is the
  -- boundary this whole design exists to keep visible.
  if not app.authors_project(v_project) then
    raise exception 'only an author on this project may record a deliverable';
  end if;

  if coalesce(trim(p_label), '') = '' then
    raise exception 'give the deliverable a name';
  end if;

  insert into public.deliverables
    (org_id, entry_id, milestone_id, type, label, signed_on,
     external_url, storage_path, submitted_at, created_by)
  values
    (v_org, p_entry_id, p_milestone_id, p_type, trim(p_label), p_signed_on,
     nullif(trim(coalesce(p_external_url, '')), ''),
     nullif(trim(coalesce(p_storage_path, '')), ''),
     now(), auth.uid())
  returning id into v_id;

  if p_milestone_id is not null and p_signed_on is not null then
    update public.entry_milestones
       set completed_on = p_signed_on, completed_by = auth.uid()
     where id = p_milestone_id and completed_on is null;
  end if;

  perform app.audit(v_org, 'deliverable.recorded', 'deliverables', v_id, null,
    jsonb_build_object('type', p_type, 'signed_on', p_signed_on));

  return v_id;
end;
$$;

create or replace function public.add_project_link(
  p_project_id uuid,
  p_label      text,
  p_url        text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  if p_url !~* '^https?://' then
    raise exception 'a link has to start with http:// or https://';
  end if;

  if not app.authors_project(p_project_id) then
    raise exception 'only an author on this project may add a document link';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  insert into public.project_links (org_id, project_id, label, url, added_by)
  values (v_org, p_project_id, trim(p_label), trim(p_url), auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

-- A note from a mentor is worth having in the record, and it is attributed,
-- so the distinction between an observation and the student's own account is
-- visible rather than forbidden. Attachment is still required.

grant execute on function public.record_deliverable(uuid, uuid, text, text, date, text, text) to authenticated;
grant execute on function public.add_project_link(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- Whoever may read a project may add an observation to it.
--
-- The first version required attachment, which quietly assumed that seeing a
-- project and being attached to it are the same thing. They are not: an
-- officer reads every project at the school by role, and is attached to only
-- the ones somebody attached them to. So an officer could open a notebook,
-- be invited to add an observation, and be told they were not attached.
--
-- The rule that matches the design: reading is decided by role or
-- attachment, and writing an attributed observation follows reading. Editing
-- the work still follows authorship, which is enforced separately.
-- ---------------------------------------------------------------------------

create or replace function public.add_field_note(
  p_project_id  uuid,
  p_body_md     text,
  p_occurred_on date default null,
  p_corrects_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(trim(p_body_md), '') = '' then
    raise exception 'an empty note records nothing';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  if v_org is null then
    raise exception 'no such project';
  end if;

  if not (
    exists (
      select 1 from public.project_authors a
       where a.project_id = p_project_id and a.user_id = auth.uid()
    )
    or (app.is_staff() and v_org = app.org_id())
  ) then
    raise exception 'you cannot write in this notebook';
  end if;

  if p_corrects_id is not null and not exists (
    select 1 from public.field_notes n
     where n.id = p_corrects_id and n.project_id = p_project_id
  ) then
    raise exception 'that note is not on this project';
  end if;

  insert into public.field_notes
    (org_id, project_id, author_id, body_md, occurred_on, corrects_id)
  values
    (v_org, p_project_id, auth.uid(), trim(p_body_md),
     coalesce(p_occurred_on, current_date), p_corrects_id)
  returning id into v_id;

  return v_id;
end;
$$;

-- Attaching an image follows the same rule as writing the note it hangs off.
create or replace function public.attach_note_media(
  p_note_id      uuid,
  p_storage_path text,
  p_caption      text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_project uuid;
  v_id      uuid;
begin
  select n.org_id, n.project_id into v_org, v_project
    from public.field_notes n where n.id = p_note_id;

  if v_org is null then
    raise exception 'no such note';
  end if;

  if not (
    exists (
      select 1 from public.project_authors a
       where a.project_id = v_project and a.user_id = auth.uid()
    )
    or (app.is_staff() and v_org = app.org_id())
  ) then
    raise exception 'you cannot add to this notebook';
  end if;

  insert into public.note_media (org_id, note_id, storage_path, caption)
  values (v_org, p_note_id, p_storage_path, p_caption)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.add_field_note(uuid, text, date, uuid) to authenticated;
grant execute on function public.attach_note_media(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- TWO AXES
--
-- The earlier model had one: a club role that also decided project access.
-- The club actually has two independent things, and conflating them is what
-- made assignment feel awkward.
--
--   WHO YOU ARE IN THE CLUB     a standing fact, granted once
--     student                   runs their own projects
--     officer                   a student, several of them, each holding
--                               five or six projects
--     advisor                   the Teacher Club Advisor. One person, runs
--                               the club, and decides which projects go
--                               forward
--
--   WHAT YOU ARE ON A PROJECT   an attachment, and there can be several
--     author                    does the work
--     officer                   manages it, comments, chases
--
-- The Teacher Project Sponsor is neither. It is a FACT ABOUT A PROJECT: a
-- named teacher, recorded by the student, who signs the fair's form and may
-- never sign in at all. Modelling it as a role would require provisioning an
-- account for somebody whose entire involvement might be a signature.
-- ===========================================================================

alter table public.user_roles
  drop constraint if exists user_roles_role_check;

alter table public.user_roles
  add constraint user_roles_role_check
  check (role in ('student', 'officer', 'advisor', 'editor'));

alter table public.pending_role_grants
  drop constraint if exists pending_role_grants_role_check;

alter table public.pending_role_grants
  add constraint pending_role_grants_role_check
  check (role in ('student', 'officer', 'advisor', 'editor'));

alter table public.project_authors
  drop constraint if exists project_authors_role_check;

alter table public.project_authors
  add constraint project_authors_role_check
  check (role in ('author', 'officer'));


-- ---------------------------------------------------------------------------
-- The Teacher Project Sponsor.
--
-- Recorded by the student, because in practice that is who does the asking.
-- No confirmation is required and none is waited for: the fair wants a name
-- on a form, and blocking a student's account on a teacher clicking a link
-- is a stalled account in exchange for nothing.
--
-- `confirmed_at` exists anyway, unset. It lets the advisor see which sponsors
-- a teacher has actually acknowledged and which are self-reported, which is
-- useful to her and invisible to everyone else.
--
-- Changing a sponsor is normal and expected. The old row is superseded
-- rather than edited, so a change after a form was signed leaves a trace.
-- ---------------------------------------------------------------------------

create table public.project_sponsors (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,
  project_id    uuid not null references public.projects on delete restrict,

  teacher_name  text not null,
  teacher_email text not null,

  -- The date on the signature, which is what the ordering check compares.
  signed_on     date,

  recorded_by   uuid not null references public.users on delete restrict,
  recorded_at   timestamptz not null default now(),

  -- Set only if that teacher signs in and says yes. Never waited for.
  confirmed_at  timestamptz,
  confirmed_by  uuid references public.users on delete restrict,

  superseded_at timestamptz,
  superseded_by uuid references public.project_sponsors on delete restrict,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index project_sponsors_project_idx
  on public.project_sponsors (project_id) where superseded_at is null;

create index project_sponsors_email_idx
  on public.project_sponsors (lower(teacher_email)) where superseded_at is null;

create trigger project_sponsors_set_updated_at
  before update on public.project_sponsors
  for each row execute function app.set_updated_at();


-- ---------------------------------------------------------------------------
-- Selection.
--
-- The advisor decides which projects the school puts forward. There is a cap,
-- and it is a real one, so the decision is recorded with a date and a decider
-- rather than implied by who happens to still be in a list.
-- ---------------------------------------------------------------------------

alter table public.programs
  add column if not exists selection_cap int;

alter table public.entries
  add column if not exists selection_state text not null default 'candidate'
    check (selection_state in ('candidate', 'selected', 'not_selected', 'withdrawn')),
  add column if not exists selection_decided_at timestamptz,
  add column if not exists selection_decided_by uuid references public.users on delete restrict,
  add column if not exists selection_note text;

update public.programs
   set selection_cap = 50
 where slug = 'scvsefa-science-fair' and selection_cap is null;


-- ---------------------------------------------------------------------------
-- Helpers, restated for the two-axis model.
-- ---------------------------------------------------------------------------

create or replace function app.is_advisor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
     where r.user_id = auth.uid() and r.role = 'advisor' and r.revoked_at is null
  );
$$;

create or replace function app.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
     where r.user_id = auth.uid()
       and r.role in ('officer', 'advisor')
       and r.revoked_at is null
  );
$$;

/* A sponsor is matched by email rather than by an account, because a sponsor
   may never have one. If a teacher whose address is on a project ever signs
   in, the match is the grant: no invitation, no provisioning, no admin. */
create or replace function app.sponsors_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.project_sponsors s
      join public.identities i
        on lower(i.email) = lower(s.teacher_email)
     where s.project_id = p_project_id
       and s.superseded_at is null
       and i.user_id = auth.uid()
       and i.revoked_at is null
  );
$$;

grant execute on function app.is_advisor(), app.sponsors_project(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Recording a sponsor. The student does this.
-- ---------------------------------------------------------------------------

create or replace function public.record_sponsor(
  p_project_id    uuid,
  p_teacher_name  text,
  p_teacher_email text,
  p_signed_on     date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org      uuid;
  v_previous uuid;
  v_id       uuid;
  v_marked   int := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not (app.authors_project(p_project_id) or app.is_staff()) then
    raise exception 'only an author on this project may record its sponsor';
  end if;

  if coalesce(trim(p_teacher_name), '') = '' then
    raise exception 'give the teacher''s name';
  end if;

  if p_teacher_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'that does not look like an email address';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  select s.id into v_previous
    from public.project_sponsors s
   where s.project_id = p_project_id and s.superseded_at is null
   limit 1;

  insert into public.project_sponsors
    (org_id, project_id, teacher_name, teacher_email, signed_on, recorded_by)
  values
    (v_org, p_project_id, trim(p_teacher_name), lower(trim(p_teacher_email)),
     p_signed_on, auth.uid())
  returning id into v_id;

  /* Superseded, never edited. A sponsor changing after a form was signed is
     ordinary, and it should still leave a trace. */
  if v_previous is not null then
    update public.project_sponsors
       set superseded_at = now(), superseded_by = v_id
     where id = v_previous;
  end if;

  /* Naming a sponsor is what the fair's approval obligation is asking for. */
  if p_signed_on is not null then
    update public.entry_milestones em
       set completed_on = p_signed_on, completed_by = auth.uid()
      from public.entries e
     where e.id = em.entry_id
       and e.project_id = p_project_id
       and em.kind = 'approval'
       and em.completed_on is null;
    get diagnostics v_marked = row_count;
  end if;

  update public.users u
     set affiliation_state = 'mentor_verified',
         affiliation_verified_at = now(),
         status = case when u.status = 'unaffiliated' then 'active' else u.status end
    from public.project_authors a
   where a.project_id = p_project_id
     and a.role = 'author'
     and a.user_id = u.id
     and u.affiliation_state = 'unverified';

  perform app.audit(v_org, 'sponsor.recorded', 'projects', p_project_id,
    case when v_previous is null then null
         else jsonb_build_object('superseded', v_previous) end,
    jsonb_build_object('teacher', trim(p_teacher_name),
                       'email', lower(trim(p_teacher_email)),
                       'signed_on', p_signed_on,
                       'approvals_cleared', v_marked));

  return v_id;
end;
$$;

/* A sponsor who does sign in can say so. Nothing depends on it. */
create or replace function public.confirm_sponsorship(p_sponsor_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select s.project_id into v_project
    from public.project_sponsors s where s.id = p_sponsor_id;

  if v_project is null or not app.sponsors_project(v_project) then
    raise exception 'only the named sponsor may confirm this';
  end if;

  update public.project_sponsors
     set confirmed_at = now(), confirmed_by = auth.uid()
   where id = p_sponsor_id and superseded_at is null;

  perform app.audit(app.org_id(), 'sponsor.confirmed', 'projects', v_project,
    null, jsonb_build_object('sponsor', p_sponsor_id));
end;
$$;


-- ---------------------------------------------------------------------------
-- Assigning an officer, and deciding selection.
-- ---------------------------------------------------------------------------

create or replace function public.assign_officer(
  p_project_id uuid,
  p_user_id    uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if not app.is_staff() then
    raise exception 'only an officer or the club advisor may assign an officer';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such project at this school';
  end if;

  if not exists (
    select 1 from public.user_roles r
     where r.user_id = p_user_id
       and r.role in ('officer', 'advisor')
       and r.revoked_at is null
       and r.org_id = v_org
  ) then
    raise exception 'that person does not hold a club role here';
  end if;

  if exists (
    select 1 from public.project_authors a
     where a.project_id = p_project_id and a.user_id = p_user_id and a.role = 'author'
  ) then
    raise exception 'an author on the project cannot also manage it';
  end if;

  insert into public.project_authors
    (org_id, project_id, user_id, role, accepted_at)
  values (v_org, p_project_id, p_user_id, 'officer', now())
  on conflict (project_id, user_id) do update
    set role = 'officer', accepted_at = now();

  perform app.audit(v_org, 'officer.assigned', 'projects', p_project_id,
    null, jsonb_build_object('officer', p_user_id));
end;
$$;

create or replace function public.set_selection(
  p_entry_id uuid,
  p_state    text,
  p_note     text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if not app.is_advisor() then
    raise exception 'only the club advisor decides which projects go forward';
  end if;

  if p_state not in ('candidate', 'selected', 'not_selected', 'withdrawn') then
    raise exception 'unknown selection state';
  end if;

  select e.org_id into v_org from public.entries e where e.id = p_entry_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such entry at this school';
  end if;

  update public.entries
     set selection_state = p_state,
         selection_decided_at = case when p_state = 'candidate' then null else now() end,
         selection_decided_by = case when p_state = 'candidate' then null else auth.uid() end,
         selection_note = p_note
   where id = p_entry_id;

  perform app.audit(v_org, 'selection.' || p_state, 'entries', p_entry_id,
    null, jsonb_build_object('note', p_note));
end;
$$;

grant execute on function public.record_sponsor(uuid, text, text, date) to authenticated;
grant execute on function public.confirm_sponsorship(uuid) to authenticated;
grant execute on function public.assign_officer(uuid, uuid) to authenticated;
grant execute on function public.set_selection(uuid, text, text) to authenticated;

grant select, insert, update on public.project_sponsors to authenticated, service_role;
revoke delete on public.project_sponsors from authenticated, service_role;
alter table public.project_sponsors enable row level security;


-- ---------------------------------------------------------------------------
-- Reading, restated. Four ways to see a project:
--   you author it, you are the officer on it, you run the club, or your
--   address is the sponsor's.
-- ---------------------------------------------------------------------------

drop policy if exists projects_read on public.projects;

create policy projects_read on public.projects
  for select to authenticated
  using (
    org_id = (select app.org_id())
    and (
      created_by = (select auth.uid())
      or exists (
        select 1 from public.project_authors a
         where a.project_id = projects.id and a.user_id = (select auth.uid())
      )
      or (select app.is_staff())
      or (select app.sponsors_project(id))
    )
  );

drop policy if exists field_notes_read on public.field_notes;

create policy field_notes_read on public.field_notes
  for select to authenticated
  using (
    exists (select 1 from public.project_authors a
             where a.project_id = field_notes.project_id and a.user_id = (select auth.uid()))
    or (select app.is_staff())
    or (select app.sponsors_project(project_id))
  );

drop policy if exists entries_read on public.entries;

create policy entries_read on public.entries
  for select to authenticated
  using (
    exists (
      select 1 from public.project_authors a
       where a.project_id = entries.project_id and a.user_id = (select auth.uid())
    )
    or (select app.is_staff())
    or (select app.sponsors_project(project_id))
  );

drop policy if exists entry_milestones_read on public.entry_milestones;

create policy entry_milestones_read on public.entry_milestones
  for select to authenticated
  using (
    exists (
      select 1
        from public.entries e
        join public.project_authors a on a.project_id = e.project_id
       where e.id = entry_id and a.user_id = (select auth.uid())
    )
    or (select app.is_staff())
    or exists (
      select 1 from public.entries e
       where e.id = entry_id and (select app.sponsors_project(e.project_id))
    )
  );

create policy project_sponsors_read on public.project_sponsors
  for select to authenticated
  using (
    org_id = (select app.org_id())
    and (
      exists (select 1 from public.project_authors a
               where a.project_id = project_sponsors.project_id and a.user_id = (select auth.uid()))
      or (select app.is_staff())
      or (select app.sponsors_project(project_id))
    )
  );

/* A sponsor writes an observation like anyone else who can read the project.
   add_field_note already asks the reading question; it just has to ask the
   new one too. */
create or replace function public.add_field_note(
  p_project_id  uuid,
  p_body_md     text,
  p_occurred_on date default null,
  p_corrects_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_id  uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if coalesce(trim(p_body_md), '') = '' then
    raise exception 'an empty note records nothing';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  if v_org is null then
    raise exception 'no such project';
  end if;

  if not (
    exists (
      select 1 from public.project_authors a
       where a.project_id = p_project_id and a.user_id = auth.uid()
    )
    or (app.is_staff() and v_org = app.org_id())
    or app.sponsors_project(p_project_id)
  ) then
    raise exception 'you cannot write in this notebook';
  end if;

  if p_corrects_id is not null and not exists (
    select 1 from public.field_notes n
     where n.id = p_corrects_id and n.project_id = p_project_id
  ) then
    raise exception 'that note is not on this project';
  end if;

  insert into public.field_notes
    (org_id, project_id, author_id, body_md, occurred_on, corrects_id)
  values
    (v_org, p_project_id, auth.uid(), trim(p_body_md),
     coalesce(p_occurred_on, current_date), p_corrects_id)
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.add_field_note(uuid, text, date, uuid) to authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- A fair is more structured than a name and a date.
--
-- The year is the SEASON, not part of the name: "SCVSEFA Science Fair" is
-- the fair and 2027 is which running of it. Keeping them in one string means
-- every list sorts alphabetically by accident and no query can ask for last
-- season. Advancement is a list, because a fair can feed more than one.
-- ---------------------------------------------------------------------------

alter table public.programs
  add column if not exists description text,
  add column if not exists website_url text,
  add column if not exists advances_to_fairs text[];

update public.programs
   set description = 'The regional science and engineering fair for Santa Clara County. '
                     'Open to students in grades 6 through 12, judged in March, with '
                     'winners advancing to the state and international fairs.',
       website_url = 'https://www.scvsefa.org',
       advances_to_fairs = array[
         'California Science and Engineering Fair',
         'International Science and Engineering Fair'
       ]
 where slug = 'scvsefa-science-fair' and season_year = 2027;

alter table public.programs drop column if exists advances_to;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- An officer is a student, and runs projects of their own.
--
-- The earlier rule refused to let an author be the officer on their own
-- project, on the reasoning that oversight should not be self-administered.
-- In a club of this size that rule produces a worse outcome: an officer's own
-- project ends up with nobody looking after it, and the queue reports it as
-- unassigned forever.
--
-- So it is allowed, and instead of being prevented it is made visible. The
-- audit records it, and every club screen marks the project as self-managed,
-- which is what an advisor scanning for problems actually needs.
-- ---------------------------------------------------------------------------

create or replace function public.assign_officer(
  p_project_id uuid,
  p_user_id    uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_self boolean;
begin
  if not app.is_staff() then
    raise exception 'only an officer or the club advisor may assign an officer';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such project at this school';
  end if;

  if not exists (
    select 1 from public.user_roles r
     where r.user_id = p_user_id
       and r.role in ('officer', 'advisor')
       and r.revoked_at is null
       and r.org_id = v_org
  ) then
    raise exception 'that person does not hold a club role here';
  end if;

  select exists (
    select 1 from public.project_authors a
     where a.project_id = p_project_id and a.user_id = p_user_id and a.role = 'author'
  ) into v_self;

  /* An author is already on the project as an author. Adding a second
     attachment would collide on the unique key, so self-management is
     recorded on the authorship row rather than as a separate one. */
  if v_self then
    update public.project_authors
       set self_managed_at = now()
     where project_id = p_project_id and user_id = p_user_id and role = 'author';
  else
    insert into public.project_authors
      (org_id, project_id, user_id, role, accepted_at)
    values (v_org, p_project_id, p_user_id, 'officer', now())
    on conflict (project_id, user_id) do update
      set role = 'officer', accepted_at = now();
  end if;

  perform app.audit(v_org, 'officer.assigned', 'projects', p_project_id,
    null, jsonb_build_object('officer', p_user_id, 'self_managed', v_self));
end;
$$;

alter table public.project_authors
  add column if not exists self_managed_at timestamptz;

create or replace function public.detach_from_project(
  p_project_id uuid,
  p_user_id    uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_staff() then
    raise exception 'only an officer or the club advisor may detach someone';
  end if;

  /* Detaching a self-managing author clears the marker, not the authorship. */
  update public.project_authors
     set self_managed_at = null
   where project_id = p_project_id and user_id = p_user_id and role = 'author';

  delete from public.project_authors
   where project_id = p_project_id
     and user_id = p_user_id
     and role = 'officer';

  perform app.audit(app.org_id(), 'project.detached', 'projects', p_project_id,
    jsonb_build_object('user', p_user_id), null);
end;
$$;

grant execute on function public.assign_officer(uuid, uuid) to authenticated;
grant execute on function public.detach_from_project(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- OBLIGATIONS THE SYSTEM ALREADY KNOWS THE ANSWER TO
--
-- Two kinds of obligation live in the same list and want different controls.
--
--   MANUAL      something done elsewhere and reported here: upload the
--               abstract, submit the form. A dropdown is right, because only
--               the student knows.
--
--   DERIVED     a fact this system already holds: a sponsor is named, an
--               officer is assigned, a start date is set. A dropdown is
--               wrong three ways here — it lets somebody tick a box while the
--               fact is false, it puts two sources of truth in one row, and
--               it makes an obligation editable by the person it constrains.
--
-- `satisfied_by` names the fact. Null means manual.
-- ===========================================================================

alter table public.program_milestones
  add column if not exists satisfied_by text
    check (satisfied_by in ('sponsor', 'officer', 'start_date'));

alter table public.entry_milestones
  add column if not exists satisfied_by text
    check (satisfied_by in ('sponsor', 'officer', 'start_date'));

comment on column public.entry_milestones.satisfied_by is
  'The fact that closes this obligation, or null when a person reports it. '
  'A derived obligation is never hand ticked; it follows the fact.';

-- The copy at entry time carries it across.
create or replace function public.start_entry(
  p_program_id uuid,
  p_title      text,
  p_started_on date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_org     uuid;
  v_status  text;
  v_project uuid;
  v_entry   uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select u.org_id, u.status into v_org, v_status
    from public.users u where u.id = v_uid;

  if v_org is null then
    raise exception 'finish signing up first';
  end if;

  if v_status = 'suspended' then
    raise exception 'this account is suspended';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'give the project a working title';
  end if;

  if not exists (
    select 1 from public.programs p
     where p.id = p_program_id
       and p.status = 'open'
       and (p.org_id is null or p.org_id = v_org)
  ) then
    raise exception 'that fair is not open to this school';
  end if;

  insert into public.projects (org_id, title, started_on, created_by)
  values (v_org, trim(p_title), p_started_on, v_uid)
  returning id into v_project;

  insert into public.project_authors
    (org_id, project_id, user_id, role, accepted_at)
  values (v_org, v_project, v_uid, 'author', now());

  insert into public.entries (org_id, project_id, program_id)
  values (v_org, v_project, p_program_id)
  returning id into v_entry;

  insert into public.entry_milestones
    (org_id, entry_id, program_milestone_id, name, kind, due_on, required,
     blocks_experimentation, satisfied_by, sort_order)
  select v_org, v_entry, m.id, m.name, m.kind, m.due_on, m.required,
         m.blocks_experimentation, m.satisfied_by, m.sort_order
    from public.program_milestones m
   where m.program_id = p_program_id
     and (m.org_id is null or m.org_id = v_org);

  perform app.audit(v_org, 'entry.created', 'entries', v_entry, null,
    jsonb_build_object('project_id', v_project, 'program_id', p_program_id));

  return v_entry;
end;
$$;

grant execute on function public.start_entry(uuid, text, date) to authenticated;


-- ---------------------------------------------------------------------------
-- One place that reconciles derived obligations with the facts.
--
-- Called after anything that could change one. It closes what has become
-- true and reopens what has stopped being true, so a sponsor removed does
-- not leave an obligation showing as met.
-- ---------------------------------------------------------------------------

create or replace function app.sync_derived(p_project_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sponsor date;
  v_officer date;
  v_start   date;
  v_touched int := 0;
begin
  select s.signed_on, s.recorded_at::date into v_sponsor, v_officer
    from public.project_sponsors s
   where s.project_id = p_project_id and s.superseded_at is null
   limit 1;

  /* A sponsor with no signature date still counts as named; the date it was
     recorded is what we have. */
  v_sponsor := coalesce(v_sponsor, v_officer);

  select min(a.accepted_at)::date into v_officer
    from public.project_authors a
   where a.project_id = p_project_id
     and (a.role = 'officer' or (a.role = 'author' and a.self_managed_at is not null));

  select p.started_on into v_start
    from public.projects p where p.id = p_project_id;

  update public.entry_milestones em
     set completed_on = case em.satisfied_by
                          when 'sponsor'    then v_sponsor
                          when 'officer'    then v_officer
                          when 'start_date' then v_start
                        end,
         completed_by = null
    from public.entries e
   where e.id = em.entry_id
     and e.project_id = p_project_id
     and em.satisfied_by is not null
     and em.completed_on is distinct from
         (case em.satisfied_by
            when 'sponsor'    then v_sponsor
            when 'officer'    then v_officer
            when 'start_date' then v_start
          end);

  get diagnostics v_touched = row_count;
  return v_touched;
end;
$$;

grant execute on function app.sync_derived(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Every write that could change a derived fact reconciles afterwards.
-- ---------------------------------------------------------------------------

create or replace function public.record_sponsor(
  p_project_id    uuid,
  p_teacher_name  text,
  p_teacher_email text,
  p_signed_on     date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org      uuid;
  v_previous uuid;
  v_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not (app.authors_project(p_project_id) or app.is_staff()) then
    raise exception 'only an author on this project may record its sponsor';
  end if;

  if coalesce(trim(p_teacher_name), '') = '' then
    raise exception 'give the teacher''s name';
  end if;

  if p_teacher_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'that does not look like an email address';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  select s.id into v_previous
    from public.project_sponsors s
   where s.project_id = p_project_id and s.superseded_at is null
   limit 1;

  insert into public.project_sponsors
    (org_id, project_id, teacher_name, teacher_email, signed_on, recorded_by)
  values
    (v_org, p_project_id, trim(p_teacher_name), lower(trim(p_teacher_email)),
     p_signed_on, auth.uid())
  returning id into v_id;

  if v_previous is not null then
    update public.project_sponsors
       set superseded_at = now(), superseded_by = v_id
     where id = v_previous;
  end if;

  perform app.sync_derived(p_project_id);

  update public.users u
     set affiliation_state = 'mentor_verified',
         affiliation_verified_at = now(),
         status = case when u.status = 'unaffiliated' then 'active' else u.status end
    from public.project_authors a
   where a.project_id = p_project_id
     and a.role = 'author'
     and a.user_id = u.id
     and u.affiliation_state = 'unverified';

  perform app.audit(v_org, 'sponsor.recorded', 'projects', p_project_id,
    case when v_previous is null then null
         else jsonb_build_object('superseded', v_previous) end,
    jsonb_build_object('teacher', trim(p_teacher_name),
                       'email', lower(trim(p_teacher_email)),
                       'signed_on', p_signed_on));

  return v_id;
end;
$$;

create or replace function public.assign_officer(
  p_project_id uuid,
  p_user_id    uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_self boolean;
begin
  if not app.is_staff() then
    raise exception 'only an officer or the club advisor may assign an officer';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such project at this school';
  end if;

  if not exists (
    select 1 from public.user_roles r
     where r.user_id = p_user_id
       and r.role in ('officer', 'advisor')
       and r.revoked_at is null
       and r.org_id = v_org
  ) then
    raise exception 'that person does not hold a club role here';
  end if;

  select exists (
    select 1 from public.project_authors a
     where a.project_id = p_project_id and a.user_id = p_user_id and a.role = 'author'
  ) into v_self;

  if v_self then
    update public.project_authors
       set self_managed_at = now()
     where project_id = p_project_id and user_id = p_user_id and role = 'author';
  else
    insert into public.project_authors
      (org_id, project_id, user_id, role, accepted_at)
    values (v_org, p_project_id, p_user_id, 'officer', now())
    on conflict (project_id, user_id) do update
      set role = 'officer', accepted_at = now();
  end if;

  perform app.sync_derived(p_project_id);

  perform app.audit(v_org, 'officer.assigned', 'projects', p_project_id,
    null, jsonb_build_object('officer', p_user_id, 'self_managed', v_self));
end;
$$;

create or replace function public.detach_from_project(
  p_project_id uuid,
  p_user_id    uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_staff() then
    raise exception 'only an officer or the club advisor may detach someone';
  end if;

  update public.project_authors
     set self_managed_at = null
   where project_id = p_project_id and user_id = p_user_id and role = 'author';

  delete from public.project_authors
   where project_id = p_project_id
     and user_id = p_user_id
     and role = 'officer';

  /* Reopens the obligation. A fact that stops being true has to stop
     closing the row that depends on it. */
  perform app.sync_derived(p_project_id);

  perform app.audit(app.org_id(), 'project.detached', 'projects', p_project_id,
    jsonb_build_object('user', p_user_id), null);
end;
$$;

create or replace function public.set_project_start(
  p_project_id uuid,
  p_started_on date
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_was date;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not app.authors_project(p_project_id) then
    raise exception 'you are not an author on this project';
  end if;

  select p.org_id, p.started_on into v_org, v_was
    from public.projects p where p.id = p_project_id;

  update public.projects
     set started_on = p_started_on
   where id = p_project_id;

  perform app.sync_derived(p_project_id);

  perform app.audit(v_org, 'project.start_date', 'projects', p_project_id,
    jsonb_build_object('started_on', v_was),
    jsonb_build_object('started_on', p_started_on));

  return p_started_on;
end;
$$;

/* A derived obligation cannot be hand ticked. The interface does not offer
   it, and this refuses it, because an interface is not an enforcement. */
create or replace function public.set_milestone_done(
  p_milestone_id uuid,
  p_completed_on date
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_org     uuid;
  v_name    text;
  v_derived text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select e.project_id, m.org_id, m.name, m.satisfied_by
    into v_project, v_org, v_name, v_derived
    from public.entry_milestones m
    join public.entries e on e.id = m.entry_id
   where m.id = p_milestone_id;

  if v_project is null then
    raise exception 'no such obligation';
  end if;

  if v_derived is not null then
    raise exception
      'this obligation follows from the project itself and is not set by hand';
  end if;

  if not app.authors_project(v_project) then
    raise exception 'you are not an author on this project';
  end if;

  update public.entry_milestones
     set completed_on = p_completed_on,
         completed_by = case when p_completed_on is null then null else auth.uid() end
   where id = p_milestone_id;

  perform app.audit(v_org,
    case when p_completed_on is null then 'milestone.reopened' else 'milestone.completed' end,
    'entry_milestones', p_milestone_id, null,
    jsonb_build_object('name', v_name, 'completed_on', p_completed_on));

  return p_completed_on;
end;
$$;

grant execute on function public.record_sponsor(uuid, text, text, date) to authenticated;
grant execute on function public.assign_officer(uuid, uuid) to authenticated;
grant execute on function public.detach_from_project(uuid, uuid) to authenticated;
grant execute on function public.set_project_start(uuid, date) to authenticated;
grant execute on function public.set_milestone_done(uuid, date) to authenticated;


-- ---------------------------------------------------------------------------
-- The 2027 season, with the two derived obligations named as such.
-- "Club mentor attached" referred to a role that no longer exists.
-- ---------------------------------------------------------------------------

update public.program_milestones m
   set satisfied_by = 'sponsor'
  from public.programs p
 where p.id = m.program_id
   and p.slug = 'scvsefa-science-fair'
   and m.name = 'Teacher project sponsor named';

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- One student, one entry, per fair per season.
--
-- A person may run several projects across their school career and may enter
-- different fairs, but a single student cannot have two projects in the same
-- running of the same fair. The fair itself would refuse the second one, and
-- a system that lets a student build one for four months before finding that
-- out is worse than one that says so on the first day.
--
-- Enforced in two places on purpose. The function refuses with a sentence a
-- student can act on; the trigger refuses whatever route the row came by,
-- including a co-author being added to a project later.
-- ---------------------------------------------------------------------------

create or replace function app.entry_conflict(
  p_project_id uuid,
  p_program_id uuid,
  p_user_id    uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.project_id
    from public.entries e
    join public.project_authors a
      on a.project_id = e.project_id and a.role = 'author'
   where e.program_id = p_program_id
     and a.user_id = p_user_id
     and e.project_id <> p_project_id
     and e.status <> 'withdrawn'
   limit 1;
$$;

grant execute on function app.entry_conflict(uuid, uuid, uuid) to authenticated;

create or replace function app.guard_one_entry_per_student()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clash uuid;
  v_title text;
begin
  select app.entry_conflict(new.project_id, new.program_id, a.user_id)
    into v_clash
    from public.project_authors a
   where a.project_id = new.project_id
     and a.role = 'author'
     and app.entry_conflict(new.project_id, new.program_id, a.user_id) is not null
   limit 1;

  if v_clash is not null then
    select p.title into v_title from public.projects p where p.id = v_clash;
    raise exception
      'an author on this project is already entered in this fair with "%"', v_title;
  end if;

  return new;
end;
$$;

drop trigger if exists entries_one_per_student on public.entries;

create trigger entries_one_per_student
  before insert on public.entries
  for each row execute function app.guard_one_entry_per_student();

create or replace function app.guard_author_entry_clash()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clash uuid;
  v_title text;
begin
  if new.role <> 'author' then
    return new;
  end if;

  select app.entry_conflict(e.project_id, e.program_id, new.user_id)
    into v_clash
    from public.entries e
   where e.project_id = new.project_id
     and app.entry_conflict(e.project_id, e.program_id, new.user_id) is not null
   limit 1;

  if v_clash is not null then
    select p.title into v_title from public.projects p where p.id = v_clash;
    raise exception
      'that person is already entered in this fair with "%"', v_title;
  end if;

  return new;
end;
$$;

drop trigger if exists project_authors_one_entry on public.project_authors;

create trigger project_authors_one_entry
  before insert on public.project_authors
  for each row execute function app.guard_author_entry_clash();


/* start_entry says it in a sentence a student can act on, before the trigger
   has to. */
create or replace function public.start_entry(
  p_program_id uuid,
  p_title      text,
  p_started_on date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_org     uuid;
  v_status  text;
  v_project uuid;
  v_entry   uuid;
  v_clash   uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select u.org_id, u.status into v_org, v_status
    from public.users u where u.id = v_uid;

  if v_org is null then
    raise exception 'finish signing up first';
  end if;

  if v_status = 'suspended' then
    raise exception 'this account is suspended';
  end if;

  if coalesce(trim(p_title), '') = '' then
    raise exception 'give the project a working title';
  end if;

  if not exists (
    select 1 from public.programs p
     where p.id = p_program_id
       and p.status = 'open'
       and (p.org_id is null or p.org_id = v_org)
  ) then
    raise exception 'that fair is not open to this school';
  end if;

  v_clash := app.entry_conflict(gen_random_uuid(), p_program_id, v_uid);

  if v_clash is not null then
    raise exception
      'you are already entered in this fair with "%". A student may enter one project per fair each season.',
      (select p.title from public.projects p where p.id = v_clash);
  end if;

  insert into public.projects (org_id, title, started_on, created_by)
  values (v_org, trim(p_title), p_started_on, v_uid)
  returning id into v_project;

  insert into public.project_authors
    (org_id, project_id, user_id, role, accepted_at)
  values (v_org, v_project, v_uid, 'author', now());

  insert into public.entries (org_id, project_id, program_id)
  values (v_org, v_project, p_program_id)
  returning id into v_entry;

  insert into public.entry_milestones
    (org_id, entry_id, program_milestone_id, name, kind, due_on, required,
     blocks_experimentation, satisfied_by, sort_order)
  select v_org, v_entry, m.id, m.name, m.kind, m.due_on, m.required,
         m.blocks_experimentation, m.satisfied_by, m.sort_order
    from public.program_milestones m
   where m.program_id = p_program_id
     and (m.org_id is null or m.org_id = v_org);

  perform app.audit(v_org, 'entry.created', 'entries', v_entry, null,
    jsonb_build_object('project_id', v_project, 'program_id', p_program_id));

  return v_entry;
end;
$$;

grant execute on function public.start_entry(uuid, text, date) to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- THE MANUSCRIPT
--
-- Publication does not begin at `submissions`. Section 8 assumed a thing to
-- submit and nothing held one: `projects` carries a title, a question, a
-- discipline, a stage, and a start date, while 8.1 needs an abstract,
-- keywords, a contributions statement, references, and figures with captions
-- and alt text, and 7.12 checks thirteen sections against minimum lengths.
--
-- One manuscript per project. A project that publishes twice is rare enough
-- to handle on the day it happens rather than to model now.
-- ===========================================================================

create table public.manuscripts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,
  project_id    uuid not null unique references public.projects on delete restrict,

  -- An article is a manuscript. A project entry is what a fair produces:
  -- a title, an abstract, a category, a board, and a result. They are
  -- siblings rather than versions of each other, so the kind is a fact about
  -- this record and never a stage it passes through.
  record_kind   text not null default 'article'
                  check (record_kind in ('article', 'project')),

  -- Which path it arrived by. The published page reads this rather than
  -- guessing, because a record that came in finished from somewhere else
  -- must not claim a process it never went through.
  source        text not null default 'workbench'
                  check (source in ('workbench', 'external', 'migrated')),

  title         text not null,
  abstract      text,
  keywords      text[] not null default '{}',
  discipline    text,

  -- Names what each author did and what any mentor did. The written form of
  -- what Independent Work scores, and what the existing archive most
  -- conspicuously lacks.
  contributions text,

  license       text not null default 'CC BY 4.0',

  -- Month precision is the honest default: most work is known to the month,
  -- and rendering a day nobody recorded is inventing one.
  completed_on   date,
  date_precision text not null default 'month'
                  check (date_precision in ('month', 'day')),

  body_format   text not null default 'full-text'
                  check (body_format in ('full-text', 'pdf-only', 'link-only', 'none')),

  -- Set only with link-only: the authoritative version held elsewhere, for
  -- work a conference or journal already holds rights to.
  external_url  text,
  pdf_path      text,

  created_by    uuid not null references public.users on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint manuscripts_link_needs_url
    check (body_format <> 'link-only' or external_url is not null)
);

create index manuscripts_org_idx on public.manuscripts (org_id);

comment on table public.manuscripts is
  'One per project. The thing that is submitted, reviewed, and published.';


-- ---------------------------------------------------------------------------
-- Sections are rows.
--
-- 7.12 checks presence and length per section, and a parser that infers a
-- section from a student''s headings turns their formatting into a pass or a
-- fail. `section_key` is the join to the rule set in src/config/structure.ts.
-- ---------------------------------------------------------------------------

create table public.manuscript_sections (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,
  manuscript_id uuid not null references public.manuscripts on delete restrict,

  section_key   text not null,
  body          text not null default '',
  sort_order    int  not null default 0,

  -- The concurrency token. Abstract and discussion are genuinely shared
  -- prose between co-authors, which field notes deliberately are not.
  updated_at    timestamptz not null default now(),
  updated_by    uuid references public.users on delete restrict,
  created_at    timestamptz not null default now(),

  unique (manuscript_id, section_key)
);

create index manuscript_sections_idx
  on public.manuscript_sections (manuscript_id, sort_order);


-- ---------------------------------------------------------------------------
-- A figure without alt text is impossible to store.
--
-- Not validated at submission, where somebody can be talked into waiving it.
-- The column is NOT NULL and the check rejects whitespace, so the only way
-- to have a figure is to have described it.
-- ---------------------------------------------------------------------------

create table public.manuscript_figures (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,
  manuscript_id uuid not null references public.manuscripts on delete restrict,

  number        int  not null,
  storage_path  text not null,
  caption       text not null check (length(btrim(caption)) > 0),
  alt           text not null check (length(btrim(alt)) > 0),

  withdrawn_at  timestamptz,
  added_by      uuid not null references public.users on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index manuscript_figures_number_idx
  on public.manuscript_figures (manuscript_id, number) where withdrawn_at is null;

create index manuscript_figures_path_idx
  on public.manuscript_figures (storage_path);


create table public.manuscript_references (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,
  manuscript_id uuid not null references public.manuscripts on delete restrict,

  sort_order    int  not null,
  citation      text not null check (length(btrim(citation)) > 0),
  created_at    timestamptz not null default now()
);

create index manuscript_references_idx
  on public.manuscript_references (manuscript_id, sort_order);


-- ---------------------------------------------------------------------------
-- What the record quotes from the competition.
--
-- `placement` existed and nothing else did. "Presented at the Synopsys
-- Championship 2027, Category: Computational Biology, First Award" is the
-- evidence an admissions officer is looking for, and it cannot be assembled
-- from a placement alone. `advances_to_fairs` on the program says where
-- placing *can* send a project; this records where one *went*.
--
-- `entry_code` is the fair''s own, e.g. CHEM047. It is displayed and is never
-- a key: the fair reassigns it to a different project next season.
-- ---------------------------------------------------------------------------

alter table public.entries
  add column if not exists category    text,
  add column if not exists entry_code  text,
  add column if not exists awards      text[] not null default '{}',
  add column if not exists advanced_to text,
  add column if not exists result_recorded_at timestamptz,
  add column if not exists result_recorded_by uuid references public.users on delete restrict;


create trigger manuscripts_set_updated_at
  before update on public.manuscripts
  for each row execute function app.set_updated_at();

create trigger manuscript_sections_set_updated_at
  before update on public.manuscript_sections
  for each row execute function app.set_updated_at();

create trigger manuscript_figures_set_updated_at
  before update on public.manuscript_figures
  for each row execute function app.set_updated_at();


-- ---------------------------------------------------------------------------
-- Row level security answers "may I read this". A query still has to answer
-- "is this mine", which is what the functions below do.
-- ---------------------------------------------------------------------------

alter table public.manuscripts            enable row level security;
alter table public.manuscript_sections    enable row level security;
alter table public.manuscript_figures     enable row level security;
alter table public.manuscript_references  enable row level security;

grant select, insert, update on
  public.manuscripts, public.manuscript_sections,
  public.manuscript_figures, public.manuscript_references
  to authenticated, service_role;

revoke delete on
  public.manuscripts, public.manuscript_sections,
  public.manuscript_figures, public.manuscript_references
  from authenticated, anon, service_role;


create or replace function app.manuscript_project(p_manuscript_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.project_id from public.manuscripts m where m.id = p_manuscript_id;
$$;

grant execute on function app.manuscript_project(uuid) to authenticated;


-- Who may see a project is already decided. These policies ask the same
-- question in four more places rather than inventing a second answer.
create policy manuscripts_read on public.manuscripts
  for select to authenticated
  using (
    exists (select 1 from public.project_authors a
             where a.project_id = manuscripts.project_id and a.user_id = (select auth.uid()))
    or (select app.is_staff())
  );

create policy manuscripts_write on public.manuscripts
  for insert to authenticated
  with check (org_id = (select app.org_id()));

create policy manuscripts_update on public.manuscripts
  for update to authenticated
  using (org_id = (select app.org_id()));

create policy manuscript_sections_read on public.manuscript_sections
  for select to authenticated
  using (
    exists (
      select 1 from public.project_authors a
       where a.project_id = (select app.manuscript_project(manuscript_sections.manuscript_id))
         and a.user_id = (select auth.uid())
    )
    or (select app.is_staff())
  );

create policy manuscript_sections_write on public.manuscript_sections
  for insert to authenticated
  with check (org_id = (select app.org_id()));

create policy manuscript_sections_update on public.manuscript_sections
  for update to authenticated
  using (org_id = (select app.org_id()));

create policy manuscript_figures_read on public.manuscript_figures
  for select to authenticated
  using (
    exists (
      select 1 from public.project_authors a
       where a.project_id = (select app.manuscript_project(manuscript_figures.manuscript_id))
         and a.user_id = (select auth.uid())
    )
    or (select app.is_staff())
  );

create policy manuscript_figures_write on public.manuscript_figures
  for insert to authenticated
  with check (org_id = (select app.org_id()));

create policy manuscript_figures_update on public.manuscript_figures
  for update to authenticated
  using (org_id = (select app.org_id()));

create policy manuscript_references_read on public.manuscript_references
  for select to authenticated
  using (
    exists (
      select 1 from public.project_authors a
       where a.project_id = (select app.manuscript_project(manuscript_references.manuscript_id))
         and a.user_id = (select auth.uid())
    )
    or (select app.is_staff())
  );

create policy manuscript_references_write on public.manuscript_references
  for insert to authenticated
  with check (org_id = (select app.org_id()));

create policy manuscript_references_update on public.manuscript_references
  for update to authenticated
  using (org_id = (select app.org_id()));


-- ---------------------------------------------------------------------------
-- Writing a manuscript.
--
-- Every function here requires authorship. An officer or an advisor reads
-- everything and writes nothing, which is the same boundary 1.17 drew for
-- deliverables and links: independent work is what a judge probes, and a
-- club member editing a student''s methods section would make that claim
-- untrue in a way nobody could later see.
-- ---------------------------------------------------------------------------

create or replace function app.require_author(p_project_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select p.org_id into v_org
    from public.projects p where p.id = p_project_id;

  if v_org is null then
    raise exception 'no such project';
  end if;

  if not exists (
    select 1 from public.project_authors a
     where a.project_id = p_project_id
       and a.user_id = v_uid
       and a.role = 'author'
       and a.accepted_at is not null
  ) then
    raise exception
      'only an author of this project can change its manuscript. You can read it and add an observation to the notebook.';
  end if;

  return v_org;
end;
$$;

grant execute on function app.require_author(uuid) to authenticated;


create or replace function public.ensure_manuscript(p_project_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_id    uuid;
  v_title text;
  v_disc  text;
begin
  v_org := app.require_author(p_project_id);

  select m.id into v_id
    from public.manuscripts m where m.project_id = p_project_id;

  if v_id is not null then
    return v_id;
  end if;

  select p.title, p.discipline into v_title, v_disc
    from public.projects p where p.id = p_project_id;

  insert into public.manuscripts
    (org_id, project_id, title, discipline, created_by)
  values (v_org, p_project_id, v_title, v_disc, auth.uid())
  returning id into v_id;

  perform app.audit(v_org, 'manuscript.created', 'manuscripts', v_id, null,
    jsonb_build_object('project_id', p_project_id));

  return v_id;
end;
$$;

grant execute on function public.ensure_manuscript(uuid) to authenticated;


-- The concurrency token is passed in and compared. Two co-authors editing the
-- same abstract is the ordinary case, not an edge one, and last-write-wins
-- would lose somebody's paragraph without anybody knowing it happened.
create or replace function public.save_manuscript(
  p_manuscript_id  uuid,
  p_expected       timestamptz,
  p_title          text,
  p_abstract       text default null,
  p_keywords       text[] default '{}',
  p_discipline     text default null,
  p_contributions  text default null,
  p_license        text default 'CC BY 4.0',
  p_completed_on   date default null,
  p_date_precision text default 'month',
  p_record_kind    text default 'article',
  p_body_format    text default 'full-text',
  p_external_url   text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_org     uuid;
  v_current timestamptz;
  v_who     text;
begin
  select m.project_id, m.updated_at into v_project, v_current
    from public.manuscripts m where m.id = p_manuscript_id;

  if v_project is null then
    raise exception 'no such manuscript';
  end if;

  v_org := app.require_author(v_project);

  if p_expected is not null and v_current is distinct from p_expected then
    raise exception
      'somebody else saved this while you were writing. Reload the page, and your text is still in the box below it.';
  end if;

  if coalesce(btrim(p_title), '') = '' then
    raise exception 'the manuscript needs a title';
  end if;

  if p_body_format = 'link-only' and coalesce(btrim(p_external_url), '') = '' then
    raise exception 'a record that points elsewhere needs the address it points at';
  end if;

  update public.manuscripts
     set title          = btrim(p_title),
         abstract       = nullif(btrim(coalesce(p_abstract, '')), ''),
         keywords       = coalesce(p_keywords, '{}'),
         discipline     = nullif(btrim(coalesce(p_discipline, '')), ''),
         contributions  = nullif(btrim(coalesce(p_contributions, '')), ''),
         license        = coalesce(nullif(btrim(p_license), ''), 'CC BY 4.0'),
         completed_on   = p_completed_on,
         date_precision = coalesce(p_date_precision, 'month'),
         record_kind    = coalesce(p_record_kind, 'article'),
         body_format    = coalesce(p_body_format, 'full-text'),
         external_url   = nullif(btrim(coalesce(p_external_url, '')), '')
   where id = p_manuscript_id
   returning updated_at into v_current;

  perform app.audit(v_org, 'manuscript.saved', 'manuscripts', p_manuscript_id, null,
    jsonb_build_object('project_id', v_project));

  return v_current;
end;
$$;

grant execute on function public.save_manuscript(
  uuid, timestamptz, text, text, text[], text, text, text, date, text, text, text, text
) to authenticated;


create or replace function public.save_section(
  p_manuscript_id uuid,
  p_section_key   text,
  p_body          text,
  p_sort_order    int default 0,
  p_expected      timestamptz default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_org     uuid;
  v_current timestamptz;
  v_id      uuid;
begin
  select m.project_id into v_project
    from public.manuscripts m where m.id = p_manuscript_id;

  if v_project is null then
    raise exception 'no such manuscript';
  end if;

  v_org := app.require_author(v_project);

  select s.id, s.updated_at into v_id, v_current
    from public.manuscript_sections s
   where s.manuscript_id = p_manuscript_id and s.section_key = p_section_key;

  if v_id is null then
    insert into public.manuscript_sections
      (org_id, manuscript_id, section_key, body, sort_order, updated_by)
    values (v_org, p_manuscript_id, p_section_key, coalesce(p_body, ''),
            coalesce(p_sort_order, 0), auth.uid())
    returning updated_at into v_current;

    return v_current;
  end if;

  if p_expected is not null and v_current is distinct from p_expected then
    raise exception
      'somebody else saved this section while you were writing it. Reload, and your text is still in the box.';
  end if;

  update public.manuscript_sections
     set body = coalesce(p_body, ''),
         sort_order = coalesce(p_sort_order, sort_order),
         updated_by = auth.uid()
   where id = v_id
   returning updated_at into v_current;

  return v_current;
end;
$$;

grant execute on function public.save_section(uuid, text, text, int, timestamptz)
  to authenticated;


-- Numbering is assigned here rather than by the person, because a figure
-- numbered by hand drifts from the body text the moment one is removed.
create or replace function public.add_figure(
  p_manuscript_id uuid,
  p_storage_path  text,
  p_caption       text,
  p_alt           text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_org     uuid;
  v_next    int;
  v_id      uuid;
begin
  select m.project_id into v_project
    from public.manuscripts m where m.id = p_manuscript_id;

  if v_project is null then
    raise exception 'no such manuscript';
  end if;

  v_org := app.require_author(v_project);

  if coalesce(btrim(p_caption), '') = '' then
    raise exception 'a figure needs a caption. Say what it shows.';
  end if;

  if coalesce(btrim(p_alt), '') = '' then
    raise exception
      'a figure needs alt text. Describe what a reader who cannot see it would need to know.';
  end if;

  select coalesce(max(f.number), 0) + 1 into v_next
    from public.manuscript_figures f
   where f.manuscript_id = p_manuscript_id and f.withdrawn_at is null;

  insert into public.manuscript_figures
    (org_id, manuscript_id, number, storage_path, caption, alt, added_by)
  values (v_org, p_manuscript_id, v_next, p_storage_path,
          btrim(p_caption), btrim(p_alt), auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.add_figure(uuid, text, text, text) to authenticated;


create or replace function public.withdraw_figure(p_figure_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manuscript uuid;
  v_project    uuid;
begin
  select f.manuscript_id into v_manuscript
    from public.manuscript_figures f where f.id = p_figure_id;

  if v_manuscript is null then
    raise exception 'no such figure';
  end if;

  select m.project_id into v_project
    from public.manuscripts m where m.id = v_manuscript;

  perform app.require_author(v_project);

  update public.manuscript_figures
     set withdrawn_at = now()
   where id = p_figure_id and withdrawn_at is null;

  -- Close the gap, so Figure 3 does not vanish out of the middle of a
  -- numbered sequence the body text refers to.
  --
  -- Two passes, and the reason is the partial unique index on
  -- (manuscript_id, number). A partial index cannot be a deferrable
  -- constraint, so uniqueness is checked as each row is written rather than
  -- at the end of the statement. Renumbering 2,3 to 1,2 in one update
  -- therefore fails the moment 3 becomes 2 while 2 is still 2, which is a
  -- collision between a row and its own predecessor and reads as a
  -- nonsensical error. Parking the numbers below zero first sidesteps it:
  -- negatives cannot collide with positives, and they cannot collide with
  -- each other because the numbers they came from were already unique.
  update public.manuscript_figures
     set number = -number
   where manuscript_id = v_manuscript and withdrawn_at is null;

  with ordered as (
    select id, row_number() over (order by number desc) as n
      from public.manuscript_figures
     where manuscript_id = v_manuscript and withdrawn_at is null
  )
  update public.manuscript_figures f
     set number = ordered.n
    from ordered
   where f.id = ordered.id;
end;
$$;

grant execute on function public.withdraw_figure(uuid) to authenticated;


-- References arrive as a block of text, one per line, because that is how a
-- student has them: pasted out of a document. Replacing the set is simpler
-- than reconciling it and there is nothing here worth preserving row identity
-- for.
create or replace function public.save_references(
  p_manuscript_id uuid,
  p_citations     text[]
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_org     uuid;
  v_count   int := 0;
  v_line    text;
begin
  select m.project_id into v_project
    from public.manuscripts m where m.id = p_manuscript_id;

  if v_project is null then
    raise exception 'no such manuscript';
  end if;

  v_org := app.require_author(v_project);

  delete from public.manuscript_references where manuscript_id = p_manuscript_id;

  foreach v_line in array coalesce(p_citations, '{}') loop
    if coalesce(btrim(v_line), '') <> '' then
      v_count := v_count + 1;
      insert into public.manuscript_references
        (org_id, manuscript_id, sort_order, citation)
      values (v_org, p_manuscript_id, v_count, btrim(v_line));
    end if;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.save_references(uuid, text[]) to authenticated;

-- Replacing the set means deleting the old rows, which is the one place in
-- this schema where a delete is correct. Granted narrowly and to nothing else.
grant delete on public.manuscript_references to authenticated, service_role;

create policy manuscript_references_delete on public.manuscript_references
  for delete to authenticated
  using (org_id = (select app.org_id()));


-- ---------------------------------------------------------------------------
-- Recording what the fair decided.
--
-- Either an author or somebody running the club may record a result, which
-- is a deliberate exception to the author-only rule above. A placement is a
-- fact the fair announced rather than a claim a student makes about their
-- own compliance, and in practice an officer standing at the awards ceremony
-- knows it first.
-- ---------------------------------------------------------------------------

create or replace function public.record_entry_result(
  p_entry_id    uuid,
  p_category    text default null,
  p_entry_code  text default null,
  p_placement   text default null,
  p_awards      text[] default '{}',
  p_advanced_to text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_org     uuid;
  v_project uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select e.org_id, e.project_id into v_org, v_project
    from public.entries e where e.id = p_entry_id;

  if v_org is null then
    raise exception 'no such entry';
  end if;

  if not exists (
    select 1 from public.project_authors a
     where a.project_id = v_project and a.user_id = v_uid
       and a.role = 'author' and a.accepted_at is not null
  ) and not app.is_staff() then
    raise exception 'only an author or somebody running the club can record a result';
  end if;

  update public.entries
     set category    = nullif(btrim(coalesce(p_category, '')), ''),
         entry_code  = nullif(btrim(coalesce(p_entry_code, '')), ''),
         placement   = nullif(btrim(coalesce(p_placement, '')), ''),
         awards      = coalesce(p_awards, '{}'),
         advanced_to = nullif(btrim(coalesce(p_advanced_to, '')), ''),
         result_recorded_at = now(),
         result_recorded_by = v_uid
   where id = p_entry_id;

  perform app.audit(v_org, 'entry.result_recorded', 'entries', p_entry_id, null,
    jsonb_build_object('placement', p_placement, 'awards', p_awards));
end;
$$;

grant execute on function public.record_entry_result(uuid, text, text, text, text[], text)
  to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- SUBMISSION
--
-- The seam between the working surface and the published one. Everything
-- before this is the authors' own; everything after is a queue with a named
-- human on the end of it.
-- ===========================================================================

create table public.submissions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,
  project_id    uuid not null references public.projects on delete restrict,
  manuscript_id uuid not null references public.manuscripts on delete restrict,
  record_kind   text not null,

  submitted_by  uuid references public.users on delete restrict,
  submitted_at  timestamptz,

  state         text not null default 'submitted'
                  check (state in ('draft', 'submitted', 'screening', 'in_review',
                                   'revisions_requested', 'editorial_review',
                                   'accepted', 'scheduled', 'exported',
                                   'published', 'declined', 'withdrawn')),
  round         int not null default 1,

  assigned_editor uuid references public.users on delete restrict,
  decision      text,
  decided_by    uuid references public.users on delete restrict,
  decided_at    timestamptz,

  -- The id is a bearer token in a URL. This is how it stops working.
  tracking_revoked_at timestamptz,

  -- Once reviewers are working, withdrawal stops being a button and becomes
  -- a request an editor accepts. Recorded here rather than acted on.
  withdrawal_requested_at timestamptz,
  withdrawal_reason       text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index submissions_project_idx on public.submissions (project_id);
create index submissions_state_idx on public.submissions (org_id, state);

-- One live submission per manuscript. A withdrawn or declined one does not
-- stop somebody trying again.
create unique index submissions_one_live_idx
  on public.submissions (manuscript_id)
  where state not in ('withdrawn', 'declined');


create table public.state_events (
  id            bigserial primary key,
  org_id        uuid not null references public.organizations on delete restrict,
  submission_id uuid not null references public.submissions on delete restrict,

  from_state    text,
  to_state      text not null,
  actor_id      uuid references public.users on delete restrict,

  -- What the tracker shows. Never the raw state: the author sees
  -- "With reviewers" where the queue says in_review with two named people on
  -- it, and the two surfaces must not leak into each other.
  public_label  text not null,
  note          text,
  occurred_at   timestamptz not null default now()
);

create index state_events_submission_idx
  on public.state_events (submission_id, occurred_at);

create trigger submissions_set_updated_at
  before update on public.submissions
  for each row execute function app.set_updated_at();

alter table public.submissions  enable row level security;
alter table public.state_events enable row level security;

grant select, insert, update on public.submissions to authenticated, service_role;
grant select, insert on public.state_events to authenticated, service_role;
grant usage, select on sequence public.state_events_id_seq
  to authenticated, service_role;

revoke delete on public.submissions, public.state_events
  from authenticated, anon, service_role;
revoke update on public.state_events from authenticated, anon, service_role;

create policy submissions_read on public.submissions
  for select to authenticated
  using (
    exists (select 1 from public.project_authors a
             where a.project_id = submissions.project_id
               and a.user_id = (select auth.uid()))
    or (select app.is_staff())
  );

create policy state_events_read on public.state_events
  for select to authenticated
  using (
    exists (select 1 from public.submissions s
             where s.id = state_events.submission_id
               and (
                 exists (select 1 from public.project_authors a
                          where a.project_id = s.project_id
                            and a.user_id = (select auth.uid()))
                 or (select app.is_staff())
               ))
  );


-- ---------------------------------------------------------------------------
-- Submitting.
--
-- Three gates, and only two of them live here. Authorship acceptance and
-- guardian consent are permission questions and belong in the database.
-- The structural check does not: it is a completeness gate rather than a
-- security boundary, it runs in the application against one rule set that the
-- public checklist also reads, and somebody who defeats it has submitted an
-- incomplete paper that an editor will see at screening.
-- ---------------------------------------------------------------------------

create or replace function public.submit_manuscript(p_manuscript_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := auth.uid();
  v_project   uuid;
  v_org       uuid;
  v_kind      text;
  v_id        uuid;
  v_unaccepted text;
  v_unconsented text;
begin
  select m.project_id, m.record_kind into v_project, v_kind
    from public.manuscripts m where m.id = p_manuscript_id;

  if v_project is null then
    raise exception 'no such manuscript';
  end if;

  v_org := app.require_author(v_project);

  -- Attributing work to somebody who has not agreed to it is not a
  -- formatting problem, so this blocks on every path.
  select string_agg(u.display_name, ', ')
    into v_unaccepted
    from public.project_authors a
    join public.users u on u.id = a.user_id
   where a.project_id = v_project
     and a.role = 'author'
     and a.accepted_at is null;

  if v_unaccepted is not null then
    raise exception
      '% has not accepted authorship yet. Nothing is submitted until every listed author has.',
      v_unaccepted;
  end if;

  -- Every listed author who is a minor, not only the person pressing the
  -- button. A two author paper has two guardians.
  select string_agg(u.display_name, ', ')
    into v_unconsented
    from public.project_authors a
    join public.users u on u.id = a.user_id
   where a.project_id = v_project
     and a.role = 'author'
     and u.consent_state not in ('active', 'not_required');

  if v_unconsented is not null then
    raise exception
      'Guardian permission has not been confirmed for %. Nothing can be published before it is.',
      v_unconsented;
  end if;

  if exists (
    select 1 from public.submissions s
     where s.manuscript_id = p_manuscript_id
       and s.state not in ('withdrawn', 'declined')
  ) then
    raise exception 'this manuscript has already been submitted';
  end if;

  insert into public.submissions
    (org_id, project_id, manuscript_id, record_kind, submitted_by, submitted_at, state)
  values (v_org, v_project, p_manuscript_id, v_kind, v_uid, now(), 'submitted')
  returning id into v_id;

  insert into public.state_events
    (org_id, submission_id, from_state, to_state, actor_id, public_label)
  values (v_org, v_id, 'draft', 'submitted', v_uid, 'Received');

  perform app.audit(v_org, 'submission.created', 'submissions', v_id, null,
    jsonb_build_object('project_id', v_project, 'manuscript_id', p_manuscript_id));

  return v_id;
end;
$$;

grant execute on function public.submit_manuscript(uuid) to authenticated;


create or replace function public.withdraw_submission(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_org     uuid;
  v_state   text;
begin
  select s.project_id, s.org_id, s.state into v_project, v_org, v_state
    from public.submissions s where s.id = p_submission_id;

  if v_project is null then
    raise exception 'no such submission';
  end if;

  perform app.require_author(v_project);

  if v_state = 'published' then
    raise exception
      'a published record is not withdrawn. It is corrected or retracted, and both leave a dated notice.';
  end if;

  /* Before anybody has read it, withdrawal is the authors' own business.
     Once reviewers are working it becomes a request, because other people
     have spent time on it by then. That is what journals do, and COPE's
     position is that a request made before formal acceptance should be
     accepted, so this is a change of manners rather than a refusal. */
  if v_state not in ('draft', 'submitted', 'screening') then
    raise exception
      'reviewers are already working on this. Ask to withdraw instead, and an editor will confirm it.';
  end if;

  update public.submissions
     set state = 'withdrawn'
   where id = p_submission_id;

  insert into public.state_events
    (org_id, submission_id, from_state, to_state, actor_id, public_label)
  values (v_org, p_submission_id, v_state, 'withdrawn', auth.uid(), 'Withdrawn by the authors');
end;
$$;

grant execute on function public.withdraw_submission(uuid) to authenticated;


create or replace function public.request_withdrawal(
  p_submission_id uuid,
  p_reason        text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_org     uuid;
  v_state   text;
begin
  select s.project_id, s.org_id, s.state into v_project, v_org, v_state
    from public.submissions s where s.id = p_submission_id;

  if v_project is null then
    raise exception 'no such submission';
  end if;

  perform app.require_author(v_project);

  if v_state = 'published' then
    raise exception
      'a published record is not withdrawn. It is corrected or retracted, and both leave a dated notice.';
  end if;

  update public.submissions
     set withdrawal_requested_at = now(),
         withdrawal_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_submission_id;

  /* The state does not move. An editor confirms it, which is the whole point
     of it being a request rather than a button. */
  insert into public.state_events
    (org_id, submission_id, from_state, to_state, actor_id, public_label, note)
  values (v_org, p_submission_id, v_state, v_state, auth.uid(),
          'Withdrawal requested by the authors', p_reason);

  perform app.audit(v_org, 'submission.withdrawal_requested', 'submissions',
    p_submission_id, null, jsonb_build_object('reason', p_reason));
end;
$$;

grant execute on function public.request_withdrawal(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- The public tracker.
--
-- A per-submission URL with an opaque identifier, no login. The id in the URL
-- is a bearer token, so this returns the least that is useful and nothing
-- that could embarrass anyone: no reviewer names, no comments, no editor
-- notes, no addresses. The author's own view, behind a login, shows the rest.
-- ---------------------------------------------------------------------------

create or replace function public.track_submission(p_id uuid)
returns table (
  title       text,
  authors     text,
  record_kind text,
  state       text,
  submitted_at timestamptz,
  events      jsonb
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    m.title,
    (select string_agg(u.display_name, ', ' order by a.created_at)
       from public.project_authors a
       join public.users u on u.id = a.user_id
      where a.project_id = s.project_id and a.role = 'author'),
    s.record_kind,
    s.state,
    s.submitted_at,
    (select jsonb_agg(jsonb_build_object('label', e.public_label, 'on', e.occurred_at)
                      order by e.occurred_at)
       from public.state_events e where e.submission_id = s.id)
  from public.submissions s
  join public.manuscripts m on m.id = s.manuscript_id
 where s.id = p_id
   and s.tracking_revoked_at is null;
$$;

grant execute on function public.track_submission(uuid) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- A finished paper, brought in as a file.
-- ---------------------------------------------------------------------------

create or replace function public.set_manuscript_pdf(
  p_manuscript_id uuid,
  p_storage_path  text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select m.project_id into v_project
    from public.manuscripts m where m.id = p_manuscript_id;

  if v_project is null then
    raise exception 'no such manuscript';
  end if;

  perform app.require_author(v_project);

  update public.manuscripts
     set pdf_path = nullif(btrim(coalesce(p_storage_path, '')), '')
   where id = p_manuscript_id;
end;
$$;

grant execute on function public.set_manuscript_pdf(uuid, text) to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- EDITORIAL REVIEW
--
-- 1.13 collapsed six roles into three and recorded that reviewer and editor
-- return when peer review is built. This is that.
--
-- They return on different axes, which is 6.4's correction applied a second
-- time. Being an editor is a standing fact about a person: they run the
-- queue, they screen, they decide. Reviewing one submission is a fact about
-- that submission, so it is an attachment with a due date rather than a
-- badge somebody keeps between seasons.
--
-- And be precise about what this is. Editorial review by named reviewers,
-- not double blind peer review. In a club this size blinding is theater, and
-- signed review is both the honest option and the better teaching.
-- ===========================================================================

create or replace function app.is_editor()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
     where r.user_id = auth.uid()
       and r.role in ('editor', 'advisor')
       and r.revoked_at is null
  );
$$;

grant execute on function app.is_editor() to authenticated;

comment on function app.is_editor is
  'Editors and the club advisor. The advisor is always an editor because the advisor decides.';


create table public.reviews (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,
  submission_id uuid not null references public.submissions on delete restrict,
  reviewer_id   uuid not null references public.users on delete restrict,
  round         int  not null,

  assigned_at   timestamptz not null default now(),
  assigned_by   uuid references public.users on delete restrict,
  due_at        timestamptz not null,
  submitted_at  timestamptz,
  declined_at   timestamptz,

  recommendation text check (recommendation in ('accept', 'minor', 'major', 'decline')),

  -- The structured form. Scales inform the reviewer's thinking and are never
  -- averaged into a score, because a number would be argued with and the
  -- prose would not be read.
  responses     jsonb,

  comments_to_author text,
  -- Authors never read this, and it is not protected by a policy. Their
  -- access to a review goes through a function that does not select the
  -- column, so it cannot leak by somebody widening a query later.
  comments_to_editor text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (submission_id, reviewer_id, round)
);

create index reviews_reviewer_idx on public.reviews (reviewer_id, submitted_at);
create index reviews_submission_idx on public.reviews (submission_id, round);


-- The editor's consolidated list. Authors get one merged, ordered set of
-- changes, not raw reviewer dumps: two reviewers contradicting each other is
-- the editor's problem to resolve, not the student's to referee.
create table public.review_findings (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,
  submission_id uuid not null references public.submissions on delete restrict,
  round         int  not null,
  sort_order    int  not null,

  severity      text not null check (severity in ('required', 'suggested')),
  section       text,
  finding       text not null check (length(btrim(finding)) > 0),

  -- The author works down the list and answers each one, which produces the
  -- response to reviewers document. Standard practice, and an unusually good
  -- teaching artifact: it makes a student defend or concede each point in
  -- writing.
  author_response text,
  resolved      boolean not null default false,

  created_by    uuid references public.users on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index review_findings_idx
  on public.review_findings (submission_id, round, sort_order);

create trigger reviews_set_updated_at
  before update on public.reviews
  for each row execute function app.set_updated_at();

create trigger review_findings_set_updated_at
  before update on public.review_findings
  for each row execute function app.set_updated_at();

alter table public.reviews         enable row level security;
alter table public.review_findings enable row level security;

grant select, insert, update on public.reviews, public.review_findings
  to authenticated, service_role;
revoke delete on public.reviews, public.review_findings
  from authenticated, anon, service_role;


-- A reviewer reads their own assignment. An editor reads all of them.
-- An author reads none of them, and gets the parts meant for them through
-- author_feedback() instead.
create policy reviews_read on public.reviews
  for select to authenticated
  using (
    reviews.reviewer_id = (select auth.uid())
    or (select app.is_editor())
  );

create policy reviews_write on public.reviews
  for insert to authenticated
  with check (org_id = (select app.org_id()) and (select app.is_editor()));

create policy reviews_update on public.reviews
  for update to authenticated
  using (
    org_id = (select app.org_id())
    and (reviews.reviewer_id = (select auth.uid()) or (select app.is_editor()))
  );

-- Findings are the half of a review the author is meant to read.
create policy review_findings_read on public.review_findings
  for select to authenticated
  using (
    (select app.is_editor())
    or exists (
      select 1 from public.submissions s
       join public.project_authors a on a.project_id = s.project_id
       where s.id = review_findings.submission_id
         and a.user_id = (select auth.uid())
         and a.role = 'author'
    )
  );

create policy review_findings_write on public.review_findings
  for insert to authenticated
  with check (org_id = (select app.org_id()) and (select app.is_editor()));

create policy review_findings_update on public.review_findings
  for update to authenticated
  using (org_id = (select app.org_id()));


-- ---------------------------------------------------------------------------
-- Moving a submission.
--
-- One guard, used by every transition, so the state machine is stated once
-- rather than reimplemented in each function. The same table is mirrored in
-- src/lib/workflow.ts for the interface, and a test asserts the two agree.
-- ---------------------------------------------------------------------------

create or replace function app.move_submission(
  p_submission_id uuid,
  p_to            text,
  p_label         text,
  p_note          text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_from  text;
begin
  select s.org_id, s.state into v_org, v_from
    from public.submissions s where s.id = p_submission_id;

  if v_org is null then
    raise exception 'no such submission';
  end if;

  update public.submissions set state = p_to where id = p_submission_id;

  insert into public.state_events
    (org_id, submission_id, from_state, to_state, actor_id, public_label, note)
  values (v_org, p_submission_id, v_from, p_to, auth.uid(), p_label, p_note);

  perform app.audit(v_org, 'submission.' || p_to, 'submissions',
    p_submission_id, jsonb_build_object('state', v_from),
    jsonb_build_object('state', p_to));
end;
$$;


create or replace function app.require_editor()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not app.is_editor() then
    raise exception 'only an editor or the club advisor can do this';
  end if;
end;
$$;

grant execute on function app.require_editor() to authenticated;


-- Taking a submission off the queue. Whoever claims it is the editor of
-- record for it, which is the point: an unclaimed queue is nobody's job.
create or replace function public.claim_submission(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
  v_held  uuid;
begin
  perform app.require_editor();

  select s.state, s.assigned_editor into v_state, v_held
    from public.submissions s where s.id = p_submission_id;

  if v_state is null then
    raise exception 'no such submission';
  end if;

  if v_held is not null and v_held <> auth.uid() then
    raise exception 'somebody else is already the editor for this one';
  end if;

  if v_state <> 'submitted' then
    raise exception 'this is already past screening';
  end if;

  update public.submissions
     set assigned_editor = auth.uid()
   where id = p_submission_id;

  perform app.move_submission(p_submission_id, 'screening', 'Being screened');
end;
$$;

grant execute on function public.claim_submission(uuid) to authenticated;


-- Screening. Scope, ethics flags, prior venue disclosure, and anything the
-- automated checks cannot judge, before anybody's volunteer time is spent.
create or replace function public.screen_submission(
  p_submission_id uuid,
  p_outcome       text,
  p_note          text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  perform app.require_editor();

  select s.state into v_state from public.submissions s where s.id = p_submission_id;

  if v_state <> 'screening' then
    raise exception 'this submission is not being screened';
  end if;

  if p_outcome = 'advance' then
    perform app.move_submission(p_submission_id, 'in_review', 'With reviewers', p_note);
  elsif p_outcome = 'return' then
    /* Returning at screening skips the findings list entirely, so this note
       is the only thing the authors receive. Sending it back with nothing
       attached tells them something is wrong and not what, which is worse
       than not sending it back at all. */
    if coalesce(btrim(coalesce(p_note, '')), '') = '' then
      raise exception
        'say what needs fixing. Returning a submission at screening sends no list, so this note is all the authors get.';
    end if;

    perform app.move_submission(p_submission_id, 'revisions_requested',
      'Back with the authors', p_note);
  elsif p_outcome = 'decline' then
    update public.submissions
       set decision = 'declined', decided_by = auth.uid(), decided_at = now()
     where id = p_submission_id;
    perform app.move_submission(p_submission_id, 'declined', 'Not accepted', p_note);
  else
    raise exception 'unknown screening outcome';
  end if;
end;
$$;

grant execute on function public.screen_submission(uuid, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Reviewers.
--
-- Anybody in the organization who is not an author of this project. Not a
-- standing role: an assignment, with a date on it.
-- ---------------------------------------------------------------------------

create or replace function public.assign_reviewer(
  p_submission_id uuid,
  p_reviewer_id   uuid,
  p_due_at        timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_project uuid;
  v_round   int;
  v_state   text;
  v_id      uuid;
begin
  perform app.require_editor();

  select s.org_id, s.project_id, s.round, s.state
    into v_org, v_project, v_round, v_state
    from public.submissions s where s.id = p_submission_id;

  if v_org is null then
    raise exception 'no such submission';
  end if;

  if v_state not in ('screening', 'in_review') then
    raise exception 'reviewers are assigned during screening or review';
  end if;

  if exists (
    select 1 from public.project_authors a
     where a.project_id = v_project and a.user_id = p_reviewer_id and a.role = 'author'
  ) then
    raise exception 'an author cannot review their own work';
  end if;

  /* Reviewing is a job the club gives somebody, so it goes to people the
     club has already given a job to: an officer, an editor, or the advisor.
     Enforced here and not only in the picker, because a picker is a
     convenience and this is a rule.

     And within this organization. Nothing else in the assignment path
     checked, so a reviewer id from another school would have been accepted
     and their work shown to somebody who is not part of it. */
  if not exists (
    select 1 from public.user_roles r
     where r.user_id = p_reviewer_id
       and r.org_id = v_org
       and r.role in ('officer', 'advisor', 'editor')
       and r.revoked_at is null
  ) then
    raise exception
      'reviewers are officers, editors, or the club advisor at this school. Give them the role first if they should be reviewing.';
  end if;

  if p_due_at is null or p_due_at <= now() then
    raise exception 'a review needs a due date in the future. An assignment with no date is the one that sits.';
  end if;

  insert into public.reviews
    (org_id, submission_id, reviewer_id, round, assigned_by, due_at)
  values (v_org, p_submission_id, p_reviewer_id, v_round, auth.uid(), p_due_at)
  returning id into v_id;

  insert into public.notifications
    (org_id, user_id, kind, subject, body, entity_type, entity_id, immediate, queued_at)
  values (v_org, p_reviewer_id, 'review_assigned',
    'You have a paper to review',
    'A submission has been assigned to you for review. It is due on '
      || to_char(p_due_at, 'FMMonth FMDD') || '.',
    'submissions', p_submission_id, true, now());

  if v_state = 'screening' then
    perform app.move_submission(p_submission_id, 'in_review', 'With reviewers');
  end if;

  return v_id;
end;
$$;

grant execute on function public.assign_reviewer(uuid, uuid, timestamptz) to authenticated;


create or replace function public.submit_review(
  p_review_id      uuid,
  p_recommendation text,
  p_responses      jsonb,
  p_to_author      text,
  p_to_editor      text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid;
  v_org      uuid;
  v_sub      uuid;
  v_editor   uuid;
begin
  select r.reviewer_id, r.org_id, r.submission_id
    into v_reviewer, v_org, v_sub
    from public.reviews r where r.id = p_review_id;

  if v_reviewer is null then
    raise exception 'no such review';
  end if;

  if v_reviewer <> auth.uid() then
    raise exception 'this review is somebody else''s';
  end if;

  if coalesce(btrim(p_to_author), '') = '' then
    raise exception
      'write something to the author. A recommendation with no reasoning is not a review.';
  end if;

  update public.reviews
     set recommendation = p_recommendation,
         responses = p_responses,
         comments_to_author = btrim(p_to_author),
         comments_to_editor = nullif(btrim(coalesce(p_to_editor, '')), ''),
         submitted_at = now()
   where id = p_review_id;

  select s.assigned_editor into v_editor
    from public.submissions s where s.id = v_sub;

  if v_editor is not null then
    insert into public.notifications
      (org_id, user_id, kind, subject, body, entity_type, entity_id, queued_at)
    values (v_org, v_editor, 'review_returned', 'A review has come back',
      'A reviewer has returned their comments.', 'submissions', v_sub, now());
  end if;
end;
$$;

grant execute on function
  public.submit_review(uuid, text, jsonb, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- The consolidated list, and the revision loop.
-- ---------------------------------------------------------------------------

create or replace function public.add_finding(
  p_submission_id uuid,
  p_severity      text,
  p_finding       text,
  p_section       text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_round int;
  v_next  int;
  v_id    uuid;
begin
  perform app.require_editor();

  select s.org_id, s.round into v_org, v_round
    from public.submissions s where s.id = p_submission_id;

  if v_org is null then
    raise exception 'no such submission';
  end if;

  select coalesce(max(f.sort_order), 0) + 1 into v_next
    from public.review_findings f
   where f.submission_id = p_submission_id and f.round = v_round;

  insert into public.review_findings
    (org_id, submission_id, round, sort_order, severity, section, finding, created_by)
  values (v_org, p_submission_id, v_round, v_next, p_severity,
          nullif(btrim(coalesce(p_section, '')), ''), btrim(p_finding), auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function public.add_finding(uuid, text, text, text) to authenticated;


/* An earlier version took only the submission id. If both survive, PostgREST
   has two candidates for the same call and refuses to pick, so every attempt
   to send a submission back fails on a database that was migrated rather than
   rebuilt. */
drop function if exists public.request_revisions(uuid);

create or replace function public.request_revisions(
  p_submission_id uuid,
  p_note          text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_round int;
  v_state text;
  v_count int;
  v_author record;
begin
  perform app.require_editor();

  select s.org_id, s.round, s.state into v_org, v_round, v_state
    from public.submissions s where s.id = p_submission_id;

  if v_state not in ('screening', 'in_review', 'editorial_review') then
    raise exception 'this submission is not with you';
  end if;

  select count(*) into v_count
    from public.review_findings f
   where f.submission_id = p_submission_id and f.round = v_round;

  /* Something has to reach them, and it can be either. A consolidated list
     is right after a round of review; a note on its own is right for the
     small correction that does not need one, which is a real and frequent
     case and used to have no route once a submission was past screening. */
  if v_count = 0 and coalesce(btrim(coalesce(p_note, '')), '') = '' then
    raise exception
      'send them something. Either put changes on the list or write a note saying what needs doing.';
  end if;

  perform app.move_submission(p_submission_id, 'revisions_requested',
    'Back with the authors', p_note);

  for v_author in
    select a.user_id from public.project_authors a
     join public.submissions s on s.project_id = a.project_id
     where s.id = p_submission_id and a.role = 'author'
  loop
    insert into public.notifications
      (org_id, user_id, kind, subject, body, entity_type, entity_id, immediate, queued_at)
    values (v_org, v_author.user_id, 'revisions_requested',
      'Changes have been asked for',
      case when v_count > 0
           then 'The editor has sent back a list of ' || v_count || ' changes.'
           else 'The editor has sent it back with a note.' end,
      'submissions', p_submission_id, true, now());
  end loop;
end;
$$;

grant execute on function public.request_revisions(uuid, text) to authenticated;


-- The author answers each finding in writing. That is the artifact: it makes
-- a student defend or concede every point rather than silently ignoring one.
create or replace function public.respond_to_finding(
  p_finding_id uuid,
  p_response   text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  select s.project_id into v_project
    from public.review_findings f
    join public.submissions s on s.id = f.submission_id
   where f.id = p_finding_id;

  if v_project is null then
    raise exception 'no such finding';
  end if;

  perform app.require_author(v_project);

  update public.review_findings
     set author_response = nullif(btrim(coalesce(p_response, '')), '')
   where id = p_finding_id;
end;
$$;

grant execute on function public.respond_to_finding(uuid, text) to authenticated;


create or replace function public.resubmit(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project   uuid;
  v_org       uuid;
  v_state     text;
  v_round     int;
  v_unanswered int;
begin
  select s.project_id, s.org_id, s.state, s.round
    into v_project, v_org, v_state, v_round
    from public.submissions s where s.id = p_submission_id;

  if v_project is null then
    raise exception 'no such submission';
  end if;

  perform app.require_author(v_project);

  if v_state <> 'revisions_requested' then
    raise exception 'this submission is not waiting on you';
  end if;

  select count(*) into v_unanswered
    from public.review_findings f
   where f.submission_id = p_submission_id
     and f.round = v_round
     and f.severity = 'required'
     and coalesce(btrim(f.author_response), '') = '';

  if v_unanswered > 0 then
    raise exception
      '% required % still unanswered. Say what you changed, or say why you disagree. Either is an answer.',
      v_unanswered, case when v_unanswered = 1 then 'change is' else 'changes are' end;
  end if;

  /* No cap on rounds.
   
     An earlier version stopped at two and sent the third straight to a
     decision, on the reasoning that an uncapped queue becomes a graveyard.
     That reasoning was about submissions nobody is working on, and this is
     the opposite: a short correction sent back and returned the same day is
     the loop working. The thing that actually prevents a graveyard is the
     editor being able to decide at any point, which they can, from
     `to_editorial_review`.

     So a resubmission always goes back to the editor, and the round number
     is a count of how many times rather than a budget. */
  update public.submissions set round = v_round + 1 where id = p_submission_id;
  perform app.move_submission(p_submission_id, 'in_review', 'With reviewers');
end;
$$;

grant execute on function public.resubmit(uuid) to authenticated;


-- The editor moves it, not a quorum of returned reviews. If advancement
-- waited on every assigned reviewer, one student who stops answering would
-- hold a paper indefinitely.
create or replace function public.to_editorial_review(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text;
begin
  perform app.require_editor();

  select s.state into v_state from public.submissions s where s.id = p_submission_id;

  if v_state <> 'in_review' then
    raise exception 'this submission is not with reviewers';
  end if;

  perform app.move_submission(p_submission_id, 'editorial_review',
    'With the editor for a decision');
end;
$$;

grant execute on function public.to_editorial_review(uuid) to authenticated;


-- One person reads the paper alongside the reviews and decides. Reviewers
-- recommend; they do not decide, and no average decides either.
create or replace function public.decide_submission(
  p_submission_id uuid,
  p_decision      text,
  p_note          text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_state  text;
  v_author record;
  v_label  text;
begin
  perform app.require_editor();

  select s.org_id, s.state into v_org, v_state
    from public.submissions s where s.id = p_submission_id;

  if v_state <> 'editorial_review' then
    raise exception 'a decision is made from the editorial read';
  end if;

  if p_decision not in ('accepted', 'declined') then
    raise exception 'a decision is accepted or declined';
  end if;

  update public.submissions
     set decision = p_decision, decided_by = auth.uid(), decided_at = now()
   where id = p_submission_id;

  v_label := case when p_decision = 'accepted' then 'Accepted' else 'Not accepted' end;
  perform app.move_submission(p_submission_id, p_decision, v_label, p_note);

  for v_author in
    select a.user_id from public.project_authors a
     join public.submissions s on s.project_id = a.project_id
     where s.id = p_submission_id and a.role = 'author'
  loop
    insert into public.notifications
      (org_id, user_id, kind, subject, body, entity_type, entity_id, immediate, queued_at)
    values (v_org, v_author.user_id, p_decision,
      case when p_decision = 'accepted' then 'Your work has been accepted'
           else 'A decision on your submission' end,
      coalesce(p_note, ''), 'submissions', p_submission_id, true, now());
  end loop;
end;
$$;

grant execute on function public.decide_submission(uuid, text, text) to authenticated;


create or replace function public.confirm_withdrawal(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested timestamptz;
begin
  perform app.require_editor();

  select s.withdrawal_requested_at into v_requested
    from public.submissions s where s.id = p_submission_id;

  if v_requested is null then
    raise exception 'the authors have not asked to withdraw this';
  end if;

  perform app.move_submission(p_submission_id, 'withdrawn',
    'Withdrawn at the authors'' request');
end;
$$;

grant execute on function public.confirm_withdrawal(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- What an author may read of a review.
--
-- A function rather than a policy, deliberately. Row level security cannot
-- withhold a column, so protecting comments_to_editor with a policy would
-- mean trusting every future select not to ask for it. This returns a fixed
-- shape and the column is not in it.
-- ---------------------------------------------------------------------------

create or replace function public.author_feedback(p_submission_id uuid)
returns table (
  round          int,
  recommendation text,
  comments       text,
  returned_at    timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.round, r.recommendation, r.comments_to_author, r.submitted_at
    from public.reviews r
    join public.submissions s on s.id = r.submission_id
    join public.project_authors a on a.project_id = s.project_id
   where r.submission_id = p_submission_id
     and r.submitted_at is not null
     and a.user_id = auth.uid()
     and a.role = 'author'
   order by r.round, r.submitted_at;
$$;

grant execute on function public.author_feedback(uuid) to authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- What an author may read of the change list.
--
-- The same treatment as author_feedback, and for the same reason. Reaching
-- review_findings through a policy meant the author's read depended on a
-- subquery over submissions and project_authors, each of which carries its
-- own row level security, so a correct policy on this table could still
-- return nothing because of a policy two joins away. That failure is silent:
-- an empty list looks exactly like a list with nothing on it.
--
-- A function returns a fixed shape, bypasses the chain, and is one place to
-- read when it goes wrong.
-- ---------------------------------------------------------------------------

create or replace function public.author_changes(p_submission_id uuid)
returns table (
  id              uuid,
  round           int,
  sort_order      int,
  severity        text,
  section         text,
  finding         text,
  author_response text
)
language sql
stable
security definer
set search_path = ''
as $$
  select f.id, f.round, f.sort_order, f.severity, f.section, f.finding,
         f.author_response
    from public.review_findings f
    join public.submissions s on s.id = f.submission_id
    join public.project_authors a on a.project_id = s.project_id
   where f.submission_id = p_submission_id
     and f.round = s.round
     and a.user_id = auth.uid()
     and a.role = 'author'
   order by f.sort_order;
$$;

grant execute on function public.author_changes(uuid) to authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- What the editor wrote to the authors.
--
-- Screening returns, declines, and decisions all carry an optional line for
-- the authors, and it lands in state_events.note. Nothing read it, so an
-- editor could return a submission with a written explanation and the author
-- would see a page saying nothing was on the list.
--
-- Never on the tracker. That page promises it does not show what anybody has
-- said, and a note addressed to the authors is exactly that. This is for the
-- authors, signed in.
-- ---------------------------------------------------------------------------

create or replace function public.author_notes(p_submission_id uuid)
returns table (
  label       text,
  note        text,
  occurred_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select e.public_label, e.note, e.occurred_at
    from public.state_events e
    join public.submissions s on s.id = e.submission_id
    join public.project_authors a on a.project_id = s.project_id
   where e.submission_id = p_submission_id
     and coalesce(btrim(e.note), '') <> ''
     and a.user_id = auth.uid()
     and a.role = 'author'
   order by e.occurred_at desc;
$$;

grant execute on function public.author_notes(uuid) to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- WHO RUNS THE CLUB
--
-- Officer and editor are grants, and until now the only thing that wrote
-- either of them was a seed script. A club could therefore be set up exactly
-- once, by somebody with database access, and never changed by the people
-- who run it. An officer graduating in June left no way to appoint the next
-- one.
--
-- The advisor grants them, and nobody else. That is the one role a school
-- appoints out of band, when the organization is provisioned, because the
-- advisor is a teacher and the school decides who its teachers are. Every
-- other role in the club is theirs to hand out and take back.
-- ===========================================================================

create or replace function app.require_advisor()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not app.is_advisor() then
    raise exception
      'only the club advisor can change who runs the club. Ask them.';
  end if;
end;
$$;

grant execute on function app.require_advisor() to authenticated;


create or replace function public.grant_club_role(
  p_user_id uuid,
  p_role    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_them uuid;
begin
  perform app.require_advisor();

  /* Officer and editor only.
   
     Not advisor: a role that can appoint itself is a role that only needs
     to be captured once, and the advisor is a teacher whose standing comes
     from the school rather than from this software. Not student either,
     which follows from the account rather than being granted. */
  if p_role not in ('officer', 'editor') then
    raise exception 'officer and editor are the roles you can hand out';
  end if;

  select u.org_id into v_org from public.users u where u.id = auth.uid();
  select u.org_id into v_them from public.users u where u.id = p_user_id;

  if v_them is null then
    raise exception 'no such person';
  end if;

  if v_them is distinct from v_org then
    raise exception 'that person is not at this school';
  end if;

  /* The uniqueness here comes from two partial indexes and ON CONFLICT
     cannot infer a target from those, so this checks first. A grant that is
     already held is not an error; it is a no-op, because the advisor's
     intent was that the person holds the role. */
  if exists (
    select 1 from public.user_roles r
     where r.user_id = p_user_id
       and r.role = p_role
       and r.scope_id is null
       and r.revoked_at is null
  ) then
    return;
  end if;

  insert into public.user_roles (org_id, user_id, role, granted_by)
  values (v_org, p_user_id, p_role, auth.uid());

  perform app.audit(v_org, 'role.granted', 'user_roles', p_user_id, null,
    jsonb_build_object('role', p_role));
end;
$$;

grant execute on function public.grant_club_role(uuid, text) to authenticated;


create or replace function public.revoke_club_role(
  p_user_id uuid,
  p_role    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  perform app.require_advisor();

  if p_role not in ('officer', 'editor') then
    raise exception 'officer and editor are the roles you can take back';
  end if;

  select u.org_id into v_org from public.users u where u.id = auth.uid();

  /* Revoked rather than deleted, so who held what and when survives. A club
     that cannot answer "who was the editor last season" cannot explain a
     decision made last season. */
  update public.user_roles
     set revoked_at = now()
   where user_id = p_user_id
     and role = p_role
     and scope_id is null
     and revoked_at is null;

  perform app.audit(v_org, 'role.revoked', 'user_roles', p_user_id, null,
    jsonb_build_object('role', p_role));
end;
$$;

grant execute on function public.revoke_club_role(uuid, text) to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- THE ROSTER
--
-- A club starts with a spreadsheet. This accepts one.
--
-- The important thing it does NOT do is create accounts. Signup is where the
-- age band is collected and guardian permission is requested, and a roster
-- that provisioned people directly would walk around both. For a list that is
-- mostly minors, that is the one shortcut this system cannot take.
--
-- So a row is a reservation rather than a person: this address, when it signs
-- up, holds this role. The person still signs up normally, still meets the age
-- gate, still triggers the consent flow. The role attaches on the way in.
--
-- This is the same mechanism the teacher sponsor already uses. A sponsor is
-- matched by email because a sponsor may never have an account, and if they
-- ever sign in, the match is the grant. Roles now work the same way, which
-- also solves the bootstrap: an organization is provisioned with a file
-- naming its advisor, nobody holds anything until a real person signs in with
-- that address, and no path inside the application can grant advisor at all.
-- ===========================================================================

create table public.role_reservations (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations on delete restrict,

  email        text not null,
  display_name text,
  role         text not null check (role in ('advisor', 'officer', 'editor')),

  added_by     uuid references public.users on delete restrict,
  created_at   timestamptz not null default now(),

  -- An unclaimed row is visibly different from a granted one, which is the
  -- whole point of keeping it after it has been used.
  claimed_at   timestamptz,
  claimed_by   uuid references public.users on delete restrict
);

-- Addresses are compared case insensitively everywhere else here, so the
-- uniqueness has to be too.
create unique index role_reservations_uq
  on public.role_reservations (org_id, lower(email), role)
  where claimed_at is null;

create index role_reservations_email_idx
  on public.role_reservations (lower(email)) where claimed_at is null;

alter table public.role_reservations enable row level security;

grant select, insert, update, delete on public.role_reservations
  to authenticated, service_role;

create policy role_reservations_read on public.role_reservations
  for select to authenticated
  using (org_id = (select app.org_id()) and (select app.is_staff()));

create policy role_reservations_write on public.role_reservations
  for insert to authenticated
  with check (org_id = (select app.org_id()) and (select app.is_advisor()));

create policy role_reservations_update on public.role_reservations
  for update to authenticated
  using (org_id = (select app.org_id()) and (select app.is_advisor()));

create policy role_reservations_delete on public.role_reservations
  for delete to authenticated
  using (org_id = (select app.org_id()) and (select app.is_advisor()));


-- ---------------------------------------------------------------------------
-- Claiming.
--
-- Two moments, because a reservation and an account can arrive in either
-- order: the file may be uploaded before somebody signs up, or a name may be
-- added to a roster after they already have an account.
-- ---------------------------------------------------------------------------

create or replace function app.claim_reservations(p_user_id uuid, p_email text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_row record;
  v_n   int := 0;
begin
  select u.org_id into v_org from public.users u where u.id = p_user_id;
  if v_org is null then
    return 0;
  end if;

  for v_row in
    select r.id, r.role
      from public.role_reservations r
     where r.org_id = v_org
       and lower(r.email) = lower(p_email)
       and r.claimed_at is null
  loop
    if not exists (
      select 1 from public.user_roles ur
       where ur.user_id = p_user_id
         and ur.role = v_row.role
         and ur.scope_id is null
         and ur.revoked_at is null
    ) then
      insert into public.user_roles (org_id, user_id, role, granted_by)
      values (v_org, p_user_id, v_row.role, null);
    end if;

    update public.role_reservations
       set claimed_at = now(), claimed_by = p_user_id
     where id = v_row.id;

    v_n := v_n + 1;
  end loop;

  if v_n > 0 then
    perform app.audit(v_org, 'roles.claimed', 'users', p_user_id, null,
      jsonb_build_object('count', v_n, 'email', p_email));
  end if;

  return v_n;
end;
$$;


-- An address arriving. Fires on signup and on any later address added to an
-- account, so a reservation written for a school address is picked up even if
-- the person first signed in with a personal one.
create or replace function app.claim_on_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.claim_reservations(new.user_id, new.email);
  return new;
end;
$$;

create trigger identities_claim_reservations
  after insert on public.identities
  for each row execute function app.claim_on_identity();


create or replace function public.add_role_reservations(p_rows jsonb)
returns table (email text, role text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org   uuid;
  v_row   jsonb;
  v_email text;
  v_role  text;
  v_name  text;
  v_user  uuid;
begin
  perform app.require_advisor();

  select u.org_id into v_org from public.users u where u.id = auth.uid();

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_email := lower(btrim(coalesce(v_row->>'email', '')));
    v_role  := lower(btrim(coalesce(v_row->>'role', '')));
    v_name  := nullif(btrim(coalesce(v_row->>'display_name', '')), '');

    email := v_email;
    role  := v_role;

    if v_email = '' or position('@' in v_email) = 0 then
      outcome := 'not an address';
      return next;
      continue;
    end if;

    /* Advisor is not on this list for the same reason it is not on the roles
       page: a role that can appoint itself only has to be captured once. An
       advisor is named when the organization is provisioned. */
    if v_role not in ('officer', 'editor') then
      outcome := 'officer and editor only';
      return next;
      continue;
    end if;

    /* Already signed in? Then this is a grant, not a reservation, and there
       is no reason to make them sign out and back in for it. */
    select i.user_id into v_user
      from public.identities i
     where lower(i.email) = v_email
       and i.org_id = v_org
       and i.revoked_at is null
     limit 1;

    if v_user is not null then
      if exists (
        select 1 from public.user_roles ur
         where ur.user_id = v_user and ur.role = v_role
           and ur.scope_id is null and ur.revoked_at is null
      ) then
        outcome := 'already held';
      else
        insert into public.user_roles (org_id, user_id, role, granted_by)
        values (v_org, v_user, v_role, auth.uid());
        outcome := 'granted now';
      end if;
      return next;
      continue;
    end if;

    if exists (
      select 1 from public.role_reservations r
       where r.org_id = v_org and lower(r.email) = v_email
         and r.role = v_role and r.claimed_at is null
    ) then
      outcome := 'already waiting';
      return next;
      continue;
    end if;

    insert into public.role_reservations
      (org_id, email, display_name, role, added_by)
    values (v_org, v_email, v_name, v_role, auth.uid());

    outcome := 'waiting for them to sign up';
    return next;
  end loop;
end;
$$;

grant execute on function public.add_role_reservations(jsonb) to authenticated;


create or replace function public.drop_role_reservation(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_advisor();

  delete from public.role_reservations
   where id = p_id and claimed_at is null;
end;
$$;

grant execute on function public.drop_role_reservation(uuid) to authenticated;

notify pgrst, 'reload schema';
