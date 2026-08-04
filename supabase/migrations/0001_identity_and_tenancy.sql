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
-- A PROGRAM is one fair in one season: the Synopsys Championship 2027, not
-- "the Synopsys Championship". Dates belong to a season and nothing else.
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
         where a.project_id = id and a.user_id = (select auth.uid())
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
       where a.project_id = id
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
       where a.project_id = project_id and a.user_id = (select auth.uid())
    )
    or (select app.is_staff())
  );

create policy entries_write on public.entries
  for update to authenticated
  using (
    exists (
      select 1 from public.project_authors a
       where a.project_id = project_id and a.user_id = (select auth.uid())
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
    (org_id, slug, name, season_year, fair_date, source, advances_to, status)
  values
    (null, 'synopsys-championship', 'Synopsys Championship', 2027,
     date '2027-03-10', 'external', 'California Science and Engineering Fair', 'open')
  on conflict (slug, season_year) do nothing
  returning id into v_program;

  if v_program is null then
    select id into v_program from public.programs
     where slug = 'synopsys-championship' and season_year = 2027;
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
    (v_program, null, 'Synopsys Championship',                      'judging',    date '2027-03-10', false, 120)
  on conflict do nothing;

  -- One school's internal deadlines, which run earlier on purpose.
  insert into public.program_milestones
    (program_id, org_id, name, kind, due_on, blocks_experimentation, sort_order)
  values
    (v_program, v_mv, 'Project categories due',      'submission', date '2026-09-18', false, 10),
    (v_program, v_mv, 'General research idea due',   'submission', date '2026-10-02', false, 20),
    (v_program, v_mv, 'Specific research idea due',  'submission', date '2026-10-09', false, 30),
    (v_program, v_mv, 'Club mentor attached',        'approval',   date '2026-10-16', true,  40),
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
         where a.project_id = id and a.user_id = (select auth.uid())
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
             where a.project_id = project_id and a.user_id = (select auth.uid()))
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
             where a.project_id = project_id and a.user_id = (select auth.uid()))
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
