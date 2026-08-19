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
  /* The label this tenant answers on, not a whole hostname: `montavista`,
     served as montavista.localhost while developing and
     montavista.scipath.org in production. Storing the hostname meant the
     database held a fact about one deployment, so the same migration could
     not seed both and a mailed link was right in only one of them. The root
     domain is configuration; the label is the tenant.

     Tenancy is resolved by this and never by email domain: two schools in one
     district share student.fuhsd.org, so a domain cannot say which school. */
  subdomain      text not null unique,
  lockup_name    text not null,
  /* Two to six.

     This has widened twice, both times because a real organization's mark did
     not fit and the mark is theirs rather than ours: `MVHS` broke a ceiling of
     three, and `SVSLC` broke a ceiling of four. Widened rather than the mark
     being cut to fit, which is the precedent 1.5 set and the right direction —
     an organization does not get told its own abbreviation is too long by a
     database.

     Six rather than eight, because the badge in `ui.css` is a block and a mark
     wide enough to turn it into a bar has stopped being a mark. `SCVSEFA` is
     seven and would not fit; that is a conversation to have with SCVSEFA
     rather than a ceiling to guess at now, and `tests/orgs.mjs` makes it a
     visible one-line widening rather than a discovery halfway through a reset.

     `tests/orgs.mjs` parses these two numbers out of this line and checks
     every organization file against them, so this is the one place they
     exist. */
  mark           text not null check (char_length(mark) between 2 and 6),
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
  -- officer : runs a program. Usually a student
  -- advisor : the teacher responsible for it
  -- editor  : reads submissions for the journal
  --
  -- `mentor` was the earlier word for the advisor. The check refuses it, and
  -- anything still testing for it is testing for a row that cannot exist.
  role       text not null
               check (role in ('student', 'officer', 'advisor', 'editor')),
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
  role        text not null
                check (role in ('student', 'officer', 'advisor', 'editor')),
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
-- notifications : the outbox. 20.7.
--
-- Rows are written by triggers, in the same transaction as the state change
-- that caused them: if the change commits the row exists, and if it rolls
-- back it does not. The alternative, every call site remembering to enqueue,
-- is a rule somebody forgets, and the one they forget is invisible, because
-- a missing notification looks exactly like nothing having happened.
--
-- **Nothing here stores a rendered message.** An earlier version of this
-- table held `subject` and `body`, which is how a reminder composed at six
-- for a form signed at seven goes out as a lie that was true when it was
-- written. Events carry only the few values their sentence needs, and a
-- digest is composed at the moment it is sent from state as it stands
-- (20.2).
-- --------------------------------------------------------------------------
create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations on delete restrict,

  -- A platform kind from src/lib/notify/platform.ts, or 'digest'.
  kind          text not null,

  -- Who hears, and who caused it. Nobody is told about their own click, so
  -- the actor is kept in order to be excluded at send time.
  recipient_id  uuid not null references public.users on delete restrict,
  actor_id      uuid references public.users on delete restrict,

  -- What it is about, so a message can link to the exact thing and somebody
  -- can later ask what was ever sent about one entry.
  subject_kind  text,
  subject_id    uuid,

  -- The few values the sentence needs. Never the notebook, never the
  -- manuscript, never review comments (20.8).
  payload       jsonb not null default '{}'::jsonb,

  -- The event rather than the moment: 'place_granted:{entry}' or
  -- 'digest:{user}:{date}'. With the constraint below, a retry, a replay or
  -- a second drain cannot double a message.
  dedupe_key    text not null,

  -- Held back so a burst becomes one message, and so a thousand of them do
  -- not leave in the same second (20.11).
  send_after    timestamptz not null default now(),

  state         text not null default 'pending'
                check (state in ('pending', 'sent', 'failed', 'skipped')),
  attempts      int not null default 0,
  last_error    text,

  created_at    timestamptz not null default now(),
  sent_at       timestamptz,

  unique (recipient_id, dedupe_key)
);

-- The drain's only query: what is due, oldest first.
create index notifications_due_idx
  on public.notifications (send_after)
  where state = 'pending';

-- --------------------------------------------------------------------------
-- notification_settings : 20.4.
--
-- Keyed on a category, never on a kind. A template with forty dated steps
-- generates forty kinds and nobody has an opinion about forty switches, so a
-- step added to a template never adds a row to a settings screen.
--
-- Absent means the default, which is on for everything except that a digest
-- is weekly rather than daily. `account` is not listed, because consent and
-- sign in are the substance of the thing rather than news about it.
-- --------------------------------------------------------------------------
create table public.notification_settings (
  user_id  uuid not null references public.users on delete cascade,
  category text not null
           check (category in ('reminders', 'approvals', 'editorial')),
  channel  text not null default 'email',
  enabled  boolean not null default true,

  -- Only meaningful for 'reminders'. 'off' is enabled = false; this decides
  -- how often the digest arrives when it is on.
  cadence  text not null default 'weekly'
           check (cadence in ('weekly', 'daily')),

  -- Whether anything inside its urgent window arrives on its own rather
  -- than waiting for the next digest.
  urgent   boolean not null default true,

  updated_at timestamptz not null default now(),

  primary key (user_id, category, channel)
);


-- ===========================================================================
-- updated_at triggers
-- ===========================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'organizations', 'org_domains', 'users', 'identities', 'user_roles',
    'guardian_consents', 'confirmation_tokens',
    'pending_role_grants', 'notification_settings'
  ] loop
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function app.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;


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

-- Officer or advisor. Both run the program; the advisor is the teacher and
-- the officer is usually the club president. In a school club the
-- administrative work is done by a student, which is why the officer holds
-- real authority despite being a student.
--
-- `mentor` was the earlier word for the teacher and `user_roles.role` no
-- longer permits it. A predicate naming a role the check constraint refuses
-- can only ever answer false for that half of its own name, and this one
-- said `('officer', 'mentor')` in the first of its two definitions for the
-- whole of the previous design. See 19.9: a rule stated in a comment is not
-- a rule, and a word left behind by a rename is the same failure wearing the
-- constraint's clothes.
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

-- The teacher. One advisor may be scoped to a program and another left
-- unscoped; this asks only whether the caller is one, because a teacher's
-- duty of care does not stop at the edge of the club they were named on.
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

-- `app.is_mentor()` stood here and asked whether the caller held the role
-- `mentor`, which `user_roles.role` has not permitted since the rename to
-- `advisor`. It could only ever answer false, it was granted to every signed
-- in account, and nothing in `src/` had called it in any case. `is_advisor`
-- is the question it was asking.

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
  app.org_id(), app.has_role(text, uuid), app.is_staff(), app.is_advisor(),
  app.may_publish()
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
  p_subdomain   text,
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
    (slug, subdomain, lockup_name, mark, theme, signup_mode,
     requires_mentor, postal_address, phone, status)
  values
    (p_slug, p_subdomain, p_lockup_name, p_mark, p_theme, p_signup_mode,
     p_requires_mentor, p_address, p_phone, 'active')
  on conflict (slug) do update set subdomain = excluded.subdomain
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

/* **Provisioning, over the API, for the secret key alone.**
 *
 * `app` is not an exposed schema, so a script cannot call the function above
 * through PostgREST — and the scripts are how a school reaches the database
 * now that each one is a file rather than a line in this migration.
 *
 * Granted to `service_role` and to nothing else. `authenticated` must never
 * hold this: creating an organization is a deliberate act, never self-serve,
 * and a signed-in student holding it could mint a tenant. The absence of a
 * grant to `authenticated` is the whole of the access control here, which is
 * why it is stated rather than left to be inferred. */
create or replace function public.provision_org(
  p_slug        text,
  p_subdomain   text,
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
language sql
security definer
set search_path = ''
as $$
  select app.provision_org(
    p_slug, p_subdomain, p_lockup_name, p_mark, p_theme, p_signup_mode,
    p_domains, p_address, p_phone, p_requires_mentor
  );
$$;

revoke all on function public.provision_org(
  text, text, text, text, text, text, jsonb, text, text, boolean
) from public, anon, authenticated;

grant execute on function public.provision_org(
  text, text, text, text, text, text, jsonb, text, text, boolean
) to service_role;


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

  /* **A function in this migration acting on the caller's behalf.**
  
     Same transaction-local flag `app.guard_role_grant` reads, set only by a
     SECURITY DEFINER function defined here, so a client update can never
     claim it.
  
     It is needed because `record_sponsor` verifies the authors' affiliation
     as part of naming a teacher -- which is the whole point of naming one --
     and a student recording their own sponsor is not staff, so this guard
     refused the update with *field is not self editable*. The refusal was
     correct about the column and wrong about the actor: the student did not
     edit `affiliation_state`, a function did, on the strength of a teacher's
     signature.
  
     It fires only where the author is still `unverified`, which is exactly
     the student the update exists for, so the failure was invisible in any
     fixture where students arrive already domain verified. */
  if coalesce(current_setting('app.system_grant', true), '') = 'on' then
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

  /* **The teacher's role is granted by a teacher.**
 
     This read `new.role = 'mentor'` and `user_roles.role` has not permitted
     `mentor` since the rename, so the guard fired on nothing at all while the
     insert policy admits any officer. An officer is usually a student, and
     `advisor` with a null `scope_id` is the widest role here -- it satisfies
     `app.is_advisor()` outright, which `can_see_project` reads as a duty of
     care over every project at the school. So the club president could make
     a classmate an advisor, and the check written to prevent exactly that had
     been inert for as long as the word had been wrong.
 
     An officer may still grant the roles an officer runs; it is this one that
     asks for a teacher. See 19.9: a word left behind by a rename disables the
     rule that names it, and the rule goes on reading as though it were there. */
  if new.role = 'advisor' and not (select app.is_advisor()) then
    raise exception 'only the club advisor may grant the advisor role';
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
alter table public.notification_settings enable row level security;

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

/* `on all tables` means every table that exists **at this point in the
   file**, not every table the file eventually creates. Two tables added for
   the cohort model were declared below this line and received nothing, so a
   seed running as the service role was told `permission denied` by a table
   it had just created.
 
   The blanket grant stays for everything above; anything created below has
   to say so, and a check refuses a table that does not. */
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
--
-- No policy at all, deliberately. The outbox is drained by a scheduled
-- Worker on the service role, and nothing in the interface reads it: a table
-- recording who was told what is the wrong thing to leave readable by
-- default. When there is an in app inbox, a policy giving a person their own
-- rows is the change to make, and it should be a decision somebody takes
-- rather than a permission they inherit (20.7).

-- notification_settings -----------------------------------------------------
--
-- A person's own, and only their own. An advisor has no business reading
-- whether a student turned reminders off, and turning them back on for them
-- would be worse.
create policy notification_settings_read_own on public.notification_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy notification_settings_write_own on public.notification_settings
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy notification_settings_update_own on public.notification_settings
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));


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

-- Tenants are not listed here.
--
-- They were: three `provision_org` calls naming eight facts about each school,
-- while `src/config/orgs.ts` named the same eight again, under a comment
-- saying the two must not be allowed to drift. A rule stated in a comment is
-- not a rule (19.9), and the hostnames in them were `.localhost`, so the same
-- migration could not seed a laptop and production.
--
-- Each school is one file in `src/config/orgs/` now, read by the application
-- and by `scripts/seed-orgs.mjs`, which provisions the rows through the
-- wrapper below. That step runs in every environment including production,
-- and is idempotent.

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
  status        text not null default 'open'
                  check (status in ('draft', 'open', 'closed', 'archived')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- ── Added as the model grew ─────────────────────────────────────────────
  description   text,
  website_url   text,
  advances_to_fairs text[],

  -- How many a school may put forward. 7.8.
  selection_cap int,

  -- ── A program is one edition of one activity at one school. 5.1 ─────────
  --
  -- `family` groups editions: scvsefa-2027 and scvsefa-2028 share it, which
  -- is what lets this year's officers see last year's work. It is a string
  -- and not an object, because a family with staff of its own would be the
  -- seasons model returning through the side door.
  family        text,
  -- `showcase` is a checkpoint that produces a record without judging: the
  -- IRPD Community Showcase, where nobody places and nothing is accepted or
  -- declined, but a student can say two years later that they presented
  -- there. It is an opportunity by 22.2's test — it produces something the
  -- project carries afterwards — and it is its own kind because none of the
  -- others describe an outcome with no decision in it.
  kind          text not null default 'competition'
                  check (kind in
                    ('competition', 'course', 'publication', 'grant',
                     'independent', 'showcase')),
  template_id   text,

  -- The research process this program prescribes for a project started in
  -- it, or null where it prescribes none. A cohort may; an opportunity may
  -- not, and the check at the foot of this table refuses one that tries
  -- (22.4).
  --
  -- The check is written there rather than here because it reads
  -- `program_role`, which is declared below.
  process_id    text,

  -- Which of the two things this is: a group you belong to, or something a
  -- project enters (22.2).
  --
  -- One table for now, deliberately. Splitting the rows and splitting the
  -- tables at once means every page breaks in two ways and neither can be
  -- diagnosed from the other. This column is what lets `memberships` refuse
  -- an opportunity and `entries` refuse a cohort, which is the correctness
  -- that mattered; the tables can follow.
  --
  -- `none` is `independent-research`, which is neither and is being deleted.
  program_role  text not null default 'opportunity'
                check (program_role in ('cohort', 'opportunity', 'none')),

  -- An opportunity only one cohort's members may enter, naming that cohort.
  -- A class's showcase is where the class shows its work, and a student who
  -- never took the class has nothing to show there.
  open_to_cohort uuid references public.programs on delete restrict,

  -- What a cohort prepares its members for, where its own deadlines are
  -- offsets from somebody else's calendar. **The anchors come from that
  -- opportunity directly, not through a member's entry**: a club member who
  -- works all year and is not selected still needs the deadlines they were
  -- working toward (22.6).
  prepares_for  uuid references public.programs on delete restrict,

  -- **You arrive here by advancing, not by applying.**
  --
  -- A state fair takes the projects a regional puts forward. Offering its
  -- entry form to everybody is offering a door that is not there: a student
  -- fills it in, is entered, and finds out in May that the fair never had
  -- their name.
  --
  -- Set from the templates, where `advances_to` already names the chain, so
  -- this is a fact restated for the database rather than a second place to
  -- maintain it. Derived at seed time rather than matched on display names,
  -- because "California Science and Engineering Fair" being equal to itself
  -- is the sort of join that survives until somebody renames a fair.
  reached_by_advancing boolean not null default false,

  version       int not null default 1,
  level         text,

  -- The real dates somebody read off the organizer's page. Here rather than
  -- in the shared template, because a template is shared between schools and
  -- dates are not.
  anchors       jsonb not null default '{}'::jsonb,

  -- How somebody joins.
  --
  --   open      : anybody at the school, the moment they ask
  --   approval  : a request, granted by the program's staff
  --
  -- From the template, because it is a fact about the program rather than a
  -- setting: IRPD takes a handful of students and a fair takes everybody who
  -- turns up, and neither is a preference an administrator should toggle.
  joining     text not null default 'open'
                check (joining in ('open', 'approval')),

  -- How many places, where there are a limited number of them. Null means
  -- as many as ask.
  places      int check (places > 0),

  -- The phases this program runs, resolved from its template: id, name, and
  -- the month window a teacher set. Held here rather than repeated on every
  -- milestone, because a phase belongs to the program and a milestone only
  -- names one. 6.8.
  phases        jsonb not null default '[]'::jsonb,

  -- What this program calls the people in it, resolved from its template.
  --
  --   { "staff":  { "singular": "Elder",  "plural": "Elders" },
  --     "member": { "singular": "Student", "plural": "Students" } }
  --
  -- The template supplies the words and never a second permission
  -- vocabulary (6.4): an Elder, an Officer, and an Editor hold exactly the
  -- same powers, and only the label differs. The database role stays
  -- `officer` everywhere, which is what keeps the access model auditable.
  --
  -- Here rather than resolved at render, for the same reason `phases` is
  -- here. The words are needed on nine screens and only two of them have
  -- any other reason to load the template library, which is a 183 KB chunk
  -- and a parse of every YAML file in it. Every one of those screens
  -- already selects this row, so the words arrive in a query that was
  -- happening anyway.
  --
  -- The cost is drift: edit a template's vocabulary and rows written before
  -- the edit keep the old word until a reseed. Accepted, because it is the
  -- same trade `phases` already makes and because a stale label is cosmetic
  -- where a stale date is not.
  roles         jsonb not null default '{}'::jsonb,

  -- Editors are derived rather than granted twice: staff of any program in
  -- these families are staff here, resolved against whichever edition is
  -- current. 6.7.
  staff_from    text[] not null default '{}',
  publishes_to  text,
  current       boolean not null default true,

  -- Per organization. Two schools running the same template is the ordinary
  -- case — every school has an `independent-research` — and a global
  -- uniqueness made the second one to seed fail. The slug comes from the
  -- template, so it is only unique within a school by construction.
  unique (org_id, slug, season_year),

  -- **Only a cohort may prescribe a research process, and grants. 22.4.**
  --
  -- The comment on `process_id` claimed this check existed for the whole of
  -- the previous design, and it did not.
  --
  -- The rule it enforces is that a *venue* may not impose a *way of doing
  -- research*: a fair's science and engineering tracks are categories, and
  -- letting one choose would ask a student who enters two to have done the
  -- work two ways. It stops being harmless the moment resolution becomes a
  -- precedence, because an opportunity carrying a stray `process_id` would
  -- then silently overwrite the work's own process.
  --
  -- **A grant is genuinely outside that rule, and is permitted here.**
  -- `process-grant` is not a way of doing research; it is how you apply for
  -- money -- find it, propose, be decided on, report on what you spent --
  -- and those steps belong to the opportunity and to nothing else. See the
  -- note at the head of `grant-mvhs-micro-2027.yaml`, which says the same
  -- thing and calls moving these steps into the file the honest fix, at
  -- which point this clause goes.
  --
  -- Written on `kind` rather than as a list of process ids, because the
  -- exception is a property of what the program *is*, and an id list would
  -- have to be edited every time a school adds a funder.
  constraint programs_only_cohorts_prescribe_process
    check (process_id is null or program_role = 'cohort' or kind = 'grant')
);

comment on column public.programs.org_id is
  'Null for a fair that many schools enter. Set for a school''s own event.';

create table public.program_milestones (
  id           uuid primary key default gen_random_uuid(),
  program_id   uuid not null references public.programs on delete restrict,
  org_id       uuid references public.organizations on delete restrict,
  name         text not null,
  -- `event` is a day something happens rather than something to hand in:
  -- applications open, results are announced. It has no deliverable and no
  -- consequence, and counting down to one tells a student nothing to act on.
  kind         text not null check (kind in
                 ('form', 'approval', 'registration', 'submission', 'judging',
                  'local', 'event')),
  due_on       date,
  opens_on     date,
  required     boolean not null default true,
  blocks_experimentation boolean not null default false,
  form_number  text,
  source_url   text,
  -- Whose deadline this is.
  --
  --   process  the research itself: read the prior work, collect the data
  --   program  the institution's, and the only kind that can end a season
  --   school   the club's own, earlier on purpose and binding on nobody else
  --
  -- A student who cannot tell a club deadline from a fair rule starts
  -- treating real deadlines as advisory, and the fair's November date is one
  -- where that ends a season. `org_id` cannot say it: on a copied milestone
  -- it is always the school's. 6.8.
  source       text not null default 'program'
                 check (source in ('process', 'program', 'school')),

  -- Which phase it belongs to, naming an entry in `programs.phases`. A phase
  -- is what lets forty projects be read in five buckets rather than as one
  -- list of nineteen rows, which is the job `projects.stage` did badly.
  phase        text,
  notes        text,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- Completed by something happening rather than by somebody ticking it.
  satisfied_by  text check (satisfied_by in ('sponsor', 'officer', 'start_date')),

  /* **Which deliverable this step asks for**, by the id the template uses.
  
     A milestone is a step's deadline and a deliverable is what the step wants
     handed in, and nothing on the row said which. Everything downstream had
     to guess: the scenario seed wrote the milestone's *kind* as the
     deliverable's type, so a class with eleven `submission` steps produced
     eleven deliverables all typed `submission` — which matched no template id,
     satisfied no obligation, and collided the moment one current row per kind
     was enforced.
  
     Null where a step hands nothing over, which is eight of the class's
     twenty-nine: a board measured, judging practised. The first of them where
     a step wants several, because that is the one the deadline is named for. */
  deliverable_ref text
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
  -- There was a `stage` column here: registered, in_progress, fair_ready,
  -- competed, published. That is a competition's lifecycle imposed on every
  -- project, and a design research course has different phases while generic
  -- research has almost none. Where a project is comes from its steps, which
  -- the program declares. 7.1.
  started_on  date,                           -- the day experimentation began

  -- How this work is done: the scientific method, engineering design, or a
  -- class's own framework. A template id from src/config/programs.
  --
  -- **On the project, because you did one piece of work.** Nobody uses design
  -- thinking for one venue and the scientific method for another, so this is
  -- decided once and the same eleven steps follow the work wherever it goes
  -- (22.4).
  --
  -- A cohort may prescribe it: enrolling in IRPD picks the d.school process,
  -- because that is what the class teaches. An opportunity may not — Synopsys
  -- science and engineering are *categories*, the fair's view of what you
  -- did, and they live on `has.categories`. Keeping that line is what stops
  -- three parties fighting over one field.
  --
  -- Not null with a default, because a fourteen year old's first screen must
  -- not be "scientific method or engineering design?", and a project with no
  -- process has an empty calendar and a digest that never speaks.
  process_id  text not null default 'process-science',
  created_by  uuid not null references public.users on delete restrict,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- Set by any author. Keeps the project out of the browsable history for
  -- staff of later editions. It does not hide a running project from the
  -- people responsible for it, and does not unpublish a published record:
  -- that is a retraction. 6.6.
  is_private    boolean not null default false,

  -- One address, stored and never fetched. 7.4.
  video_url     text,

  -- What the project says about itself: does it involve human participants,
  -- vertebrate animals, hazardous agents, a regulated institution.
  --
  -- Eight questions answered once, and the paperwork follows. ISEF publishes
  -- a Rules Wizard because working out your own forms from the rulebook is
  -- genuinely hard, and a student who gets it wrong finds out at check-in.
  --
  -- Held as json because the questions belong to a program's template rather
  -- than to this schema: a course asks two, a fair asks eight, and a column
  -- per question would put a template's content in a migration. 6.8.
  facts         jsonb not null default '{}'::jsonb
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
                check (role in ('author', 'officer')),
  accepted_at timestamptz,
  invited_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- An author looking after their own work rather than an officer being
  -- assigned. 6.4. Marks an oversight row as self management.
  self_managed_at timestamptz,

  /* **Which place this oversight belongs to.**
  
     An author belongs to the project and leaves this null: authorship is
     project level and does not change because the work went to a fair
     (23.1). An officer belongs to one participation and must name it.
  
     22.18 made this argument about sponsors and it is the same argument. A
     project in the class and the club has an Elder and a club officer, two
     different students holding two different roles. While oversight was
     project level there was one row for both, so every participation page
     named the same person and the assignment queue counted the project as
     looked after the moment anybody took it — leaving the other program with
     nobody while the page said it was handled.
  
     The foreign key is added below rather than here, because `participations`
     is declared further down and a column belongs in its create statement
     (19.9's ordering rule). */
  participation_id uuid,

  constraint project_authors_place check (
    (role = 'author'  and participation_id is null) or
    (role = 'officer' and participation_id is not null)
  )
);

/* One authorship per person per project, and one oversight per person per
   place. The old `unique (project_id, user_id)` could not tell "this person
   twice on one project" from "this person in the class and in the club", and
   refused both. */
create unique index project_authors_one_author
  on public.project_authors (project_id, user_id)
  where role = 'author';

create unique index project_authors_one_officer
  on public.project_authors (participation_id, user_id)
  where role = 'officer';

create index project_authors_user_idx on public.project_authors (user_id);


/**
 * A membership points at a cohort; an entry points at an opportunity.
 *
 * A foreign key cannot say this, because both point at `programs` while the
 * split is under way. Without it the old conflation can be recreated one row
 * at a time: a student "enrolled in" a regional fair, or a project "entered
 * into" a class.
 */
create or replace function app.membership_is_cohort()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select p.program_role into v_role
    from public.programs p
   where p.id = new.cohort_id;

  if v_role is distinct from 'cohort' then
    raise exception 'that is an %, not a cohort. A person joins a cohort; a project enters an opportunity.',
      coalesce(v_role, 'unknown thing');
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- memberships : a person is in a cohort. 22.5.
--
-- `entries` used to carry this, which is how a class and a regional fair came
-- to sit at one level. Joining IRPD is a person enrolling; entering Synopsys
-- is a project being submitted. The same row modelled both, and `start_entry`
-- had to invent a project in order to have something to hang an enrolment on.
--
-- **A membership needs no project.** A club member who never starts one is
-- rare and real, and requiring one is what created the conflation.
-- ---------------------------------------------------------------------------
create table public.memberships (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete restrict,
  user_id     uuid not null references public.users on delete restrict,

  -- A cohort. `programs` still holds both kinds while the split is under way;
  -- `app.is_cohort` refuses an opportunity here.
  cohort_id   uuid not null references public.programs on delete restrict,

  state       text not null default 'member'
              check (state in ('requested', 'member', 'declined', 'left')),

  joined_at   timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  uuid references public.users on delete restrict,
  left_at     timestamptz,
  note        text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- One membership per person per cohort. Leaving and rejoining is a state
  -- change rather than a second row, so that a roster cannot show somebody
  -- twice.
  unique (user_id, cohort_id)
);

create index memberships_cohort_idx on public.memberships (cohort_id);

-- Created below the blanket grant above, so it grants for itself.
grant select, insert, update on public.memberships to authenticated, service_role;

create trigger memberships_cohort_only
  before insert or update on public.memberships
  for each row execute function app.membership_is_cohort();

-- ---------------------------------------------------------------------------
-- participations : this is my IRPD project, and this went to Synopsys. 22.5.
--
-- `project_cohorts` and `entries` were the same relationship wearing two
-- table names. Both were project -> `programs`, separated only by
-- `programs.program_role`, which is already a column with already-enforced
-- triggers. Two tables for one relationship is what forced two pages, and it
-- is why four tables -- `entry_milestones`, `deliverables`, `records` and the
-- sponsor -- could not share a participation id.
--
-- The word is `participation` and not `entry` because "entry" is the word
-- 22.1 killed: calling the IRPD row an entry puts a class and a regional fair
-- back on one level.
--
-- Two real cases forced this relationship to exist at all, and both still
-- hold:
--
-- **A partner from another school.** A student enters Toshiba Exploravision
-- with somebody in no cohort at all, so a project's cohort cannot be
-- inferred from its authors.
--
-- **One person, three cohorts, different projects in each.** IRPD, the
-- research club and MV Environmental Science. Which cohort a project belongs
-- to is a fact about the project.
--
-- This is also where a project's supervisor and its role word come from,
-- which is what lets one project say Elder, another Officer, and a third
-- Mentor, for one person.
--
-- **What differs between the two cases is rules, not columns.** Attaching a
-- project to a cohort requires an accepted membership; entering an
-- opportunity does not. Leaving a cohort deletes the row, because a project
-- that was never in a class should leave no trace of having been; withdrawing
-- an entry is a state change, because it happened. Both are enforced on
-- `program_role`, in one table.
--
-- **The cost, recorded so it is not discovered later.** A query reading this
-- table raw counts IRPD as a fair -- 22.1's conflation returning through the
-- data-access layer instead of the schema. The mitigation is structural
-- rather than disciplinary: the two views below, and no page code selecting
-- from this table directly.
-- ---------------------------------------------------------------------------
create table public.participations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete restrict,
  project_id  uuid not null references public.projects on delete cascade,
  program_id  uuid not null references public.programs on delete restrict,

  -- ── via_id : with my research, in my club. 22.6 ─────────────────────────
  --
  -- The cohort participation an entry went through. *I entered Synopsys WITH
  -- my research and IN the club.* That **in** had no place in the model, and
  -- three questions were unanswerable without it: which cohort's officer
  -- looks after an entry, whose `selection_cap` it counts against, and which
  -- `source = 'school'` milestones layer on top.
  --
  -- `on delete set null`, because leaving the club in March must not unmake
  -- the Synopsys entry made in November. The entry happened; the club's
  -- involvement ending is a later fact about the club.
  --
  -- Null is ordinary and means the entry was made on the work's own account:
  -- the solo student entering SCVSEFA with no school infrastructure at all
  -- (22.14), which the model must carry the whole way.
  via_id      uuid references public.participations on delete set null,

  -- Who attached this, and when. On the cohort side this is the person who
  -- put the project in the class; on the opportunity side, who entered it.
  added_by    uuid references public.users on delete restrict,
  -- `requested` is a place asked for and not yet granted. IRPD takes a
  -- handful of students and the club has a signup, so joining is a request
  -- at some programs and immediate at others.
  --
  -- **It does not gate the work.** A student with a requested place can
  -- write, keep a notebook, and upload from the first day: the project is
  -- theirs and the participation is what a teacher grants. Software that
  -- refuses to let somebody work while an adult gets round to clicking is
  -- software that has confused an administrative state for a permission,
  -- and the student it stops is the one with nobody to chase it for them.
  --
  -- What a requested place does not get is the program's deadlines, its
  -- staff, or a place in its showcase, because none of those are true yet.
  status      text not null default 'entered'
                check (status in
                  ('requested', 'declined', 'entered', 'withdrawn', 'competed')),

  -- Who granted or refused it, and when. A refusal with nobody's name on it
  -- is a refusal nobody can ask about.
  decided_by  uuid references public.users on delete restrict,
  decided_at  timestamptz,
  decided_note text,
  placement   text,
  entered_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- ── Selection: which entries a school puts forward. 7.8 ─────────────────
  selection_state text not null default 'candidate'
                  check (selection_state in ('candidate', 'selected', 'not_selected', 'withdrawn')),
  selection_decided_at timestamptz,
  selection_decided_by uuid references public.users on delete restrict,
  selection_note  text,

  -- ── Money, where the program is a grant ─────────────────────────────────
  --
  -- Two numbers and no budget. A line-item budget belongs in a spreadsheet a
  -- student already knows how to use, and holding one here would mean
  -- holding a family's financial circumstances, which is not ours to keep.
  --
  -- Asked and given, because they differ more often than not: a partial
  -- award is the ordinary outcome and a student should be able to see what
  -- they have to cut.
  requested_amount numeric(10, 2) check (requested_amount >= 0),
  awarded_amount   numeric(10, 2) check (awarded_amount >= 0),
  currency         text not null default 'USD',

  -- ── What happened at the fair ───────────────────────────────────────────
  category      text,
  entry_code    text,
  awards        text[] not null default '{}',
  advanced_to   text,
  result_recorded_at timestamptz,
  result_recorded_by uuid references public.users on delete restrict,

  unique (project_id, program_id)
);

/* The key for `project_authors.participation_id`, declared with that table
   and pointed here once `participations` exists.

   `on delete cascade`, because leaving a cohort deletes the participation
   (22.5) and an officer of a place that no longer exists is not a fact about
   anything. */
alter table public.project_authors
  add constraint project_authors_participation_fkey
  foreign key (participation_id) references public.participations on delete cascade;

create index participations_program_idx on public.participations (program_id);
create index participations_via_idx
  on public.participations (via_id) where via_id is not null;

grant select, insert, update on public.participations to authenticated, service_role;

-- Leaving a cohort is a delete rather than a state change, because a project
-- that was never in a class should leave no trace of having been. Withdrawing
-- an entry is a state change, because it happened.
grant delete on public.participations to authenticated, service_role;

/**
 * A participation names a cohort or an opportunity, never `none`.
 *
 * `none` is `independent-research`, which is neither and is being deleted.
 * Without this a row could name it and belong to neither view, which is the
 * one way a participation can become invisible to every page at once.
 */
create or replace function app.participation_role_ok()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select p.program_role into v_role
    from public.programs p
   where p.id = new.program_id;

  if v_role is distinct from 'cohort' and v_role is distinct from 'opportunity' then
    raise exception 'a project participates in a cohort or an opportunity, not in %',
      coalesce(v_role, 'an unknown thing');
  end if;

  return new;
end;
$$;

/**
 * `via_id` points at a cohort participation on the same project. 22.6.
 *
 * Constrained rather than documented, because the whole value of the column
 * is that the answer to "which club looked after this entry" is a fact and
 * not a guess. A row pointing at another project's cohort, at an
 * opportunity, or at itself would each answer that question wrongly while
 * looking well-formed.
 */
create or replace function app.participation_via_ok()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role    text;
  v_project uuid;
begin
  if new.via_id is null then
    return new;
  end if;

  if new.via_id = new.id then
    raise exception 'a participation cannot be made through itself';
  end if;

  select pr.program_role, pa.project_id into v_role, v_project
    from public.participations pa
    join public.programs pr on pr.id = pa.program_id
   where pa.id = new.via_id;

  if v_project is null then
    raise exception 'no such participation to have gone through';
  end if;

  if v_project is distinct from new.project_id then
    raise exception 'an entry goes through a cohort on the same project';
  end if;

  if v_role is distinct from 'cohort' then
    raise exception 'an entry goes through a cohort, not through another opportunity';
  end if;

  return new;
end;
$$;

create trigger participations_role_ok
  before insert or update on public.participations
  for each row execute function app.participation_role_ok();

create trigger participations_via_ok
  before insert or update on public.participations
  for each row execute function app.participation_via_ok();

-- ---------------------------------------------------------------------------
-- The two read views. 22.5.
--
-- Page code selects from these and never from `participations` directly,
-- because the one failure the merge introduces is a query that counts IRPD as
-- a fair. Built here, in the same migration as the table, rather than after:
-- a view added later is a view some page was written without.
-- ---------------------------------------------------------------------------
create view public.cohort_participations as
  select pa.*
    from public.participations pa
    join public.programs pr on pr.id = pa.program_id
   where pr.program_role = 'cohort';

create view public.opportunity_participations as
  select pa.*
    from public.participations pa
    join public.programs pr on pr.id = pa.program_id
   where pr.program_role = 'opportunity';

grant select on public.cohort_participations to authenticated, service_role;
grant select on public.opportunity_participations to authenticated, service_role;

create table public.entry_milestones (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations on delete restrict,
  participation_id     uuid not null references public.participations on delete restrict,
  program_milestone_id uuid references public.program_milestones on delete restrict,
  name                 text not null,
  kind                 text not null,
  due_on               date,
  required             boolean not null default true,
  blocks_experimentation boolean not null default false,
  completed_on         date,
  completed_by         uuid references public.users on delete restrict,
  sort_order           int not null default 0,

  -- Copied from the program milestone. See the notes there.
  source               text not null default 'program'
                         check (source in ('process', 'program', 'school')),
  phase                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  satisfied_by  text check (satisfied_by in ('sponsor', 'officer', 'start_date'))
);

create index entry_milestones_participation_idx
  on public.entry_milestones (participation_id, sort_order);

do $$
declare t text;
begin
  foreach t in array array[
    'programs', 'program_milestones', 'projects', 'project_authors',
    'participations', 'entry_milestones'
  ] loop
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function app.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- Entering a fair copies the milestones onto the entry.
--
-- A copy rather than a reference, because a program that moves a date in
-- February must not silently rewrite what a student was told in September.
-- The copy is what they are held to; the program is what the fair publishes.

-- ---------------------------------------------------------------------------
-- WHAT STANDS BETWEEN A PROJECT AND AN OPPORTUNITY. 22.13.
--
-- Three gates, and the reason they are one function is that all three have to
-- answer the same question in the same words wherever it is asked: on the
-- overview that decides whether to draw a form, and in the two functions that
-- would otherwise let a POST through anyway.
--
-- Returns null when the way is clear, and a sentence a student can act on
-- when it is not. **A student told "not allowed" learns nothing; one told to
-- join the club knows what to do.**
--
-- The third gate is the one the model gained with shared programs. A regional
-- fair has a null `org_id` and one row serves every school, so
-- `open_to_cohort` cannot express "Monta Vista's students go through the
-- club" -- naming Monta Vista's club on the shared row would lock Lynbrook
-- and the Open Program out of a fair neither of them runs a club for.
--
-- So it is derived per school, from `prepares_for`, which the club already
-- declares: *if your school runs a cohort that prepares for this, you go
-- through it.* A school with no such cohort has no gate, which is exactly
-- the Open Program -- no club, nobody to ask, and 22.10's point that the
-- absence should be visible rather than papered over.
-- ---------------------------------------------------------------------------
create or replace function app.entry_gate(
  p_program_id uuid,
  p_project_id uuid default null,
  p_user_id    uuid default null
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := coalesce(p_user_id, auth.uid());
  v_org     uuid;
  v_program public.programs%rowtype;
  v_cohort  text;
  v_from    text;
begin
  select * into v_program from public.programs where id = p_program_id;

  if v_program.id is null then
    return 'no such program';
  end if;

  select u.org_id into v_org from public.users u where u.id = v_uid;

  /* 1. Open to one named cohort. The class's own showcase. */
  if v_program.open_to_cohort is not null
     and not exists (
       select 1 from public.memberships m
        where m.user_id = v_uid
          and m.cohort_id = v_program.open_to_cohort
          and m.state = 'member'
     )
  then
    select p.name into v_cohort
      from public.programs p where p.id = v_program.open_to_cohort;

    return format('Only members of %s can enter its showcase. Join it first.',
                  coalesce(v_cohort, 'that class'));
  end if;

  /* 2. A cohort at this school prepares for it, so entry goes through the
        cohort. Any one of them is enough: a school may run two. */
  if exists (
    select 1 from public.programs c
     where c.prepares_for = p_program_id
       and c.program_role = 'cohort'
       and c.org_id = v_org
       and c.status = 'open'
  ) and not exists (
    select 1
      from public.programs c
      join public.memberships m on m.cohort_id = c.id
     where c.prepares_for = p_program_id
       and c.program_role = 'cohort'
       and c.org_id = v_org
       and m.user_id = v_uid
       and m.state = 'member'
  ) then
    select string_agg(c.name, ' or ' order by c.name) into v_cohort
      from public.programs c
     where c.prepares_for = p_program_id
       and c.program_role = 'cohort'
       and c.org_id = v_org
       and c.status = 'open';

    /* Asked and not yet granted is a different sentence from never asked:
       one of them is waiting on somebody else. */
    if exists (
      select 1
        from public.programs c
        join public.memberships m on m.cohort_id = c.id
       where c.prepares_for = p_program_id
         and c.org_id = v_org
         and m.user_id = v_uid
         and m.state = 'requested'
    ) then
      return format('You have asked to join %s. Once they accept, you can enter this.',
                    coalesce(v_cohort, 'the club'));
    end if;

    return format('Your school enters this through %s. Ask to join first.',
                  coalesce(v_cohort, 'a club'));
  end if;

  /* 3. Reached by advancing. Needs a project, because the question is about
        what that project has already done. */
  if v_program.reached_by_advancing then
    if p_project_id is null then
      return 'This fair takes projects that advanced from another one, so it cannot be a project''s first entry.';
    end if;

    if not exists (
      select 1
        from public.participations pa
        join public.programs p on p.id = pa.program_id
       where pa.project_id = p_project_id
         and pa.advanced_to is not null
         and p.advances_to_fairs @> array[v_program.name]
    ) then
      select string_agg(p.name, ' or ') into v_from
        from public.programs p
       where p.advances_to_fairs @> array[v_program.name]
         and (p.org_id is null or p.org_id = v_org);

      return format('This fair takes projects that advanced from %s. It opens once a result says so.',
                    coalesce(v_from, 'another fair'));
    end if;
  end if;

  return null;
end;
$$;

grant execute on function app.entry_gate(uuid, uuid, uuid) to authenticated;

/**
 * Every gate at once, for the page that decides what to draw.
 *
 * One call rather than one per program, and the same function the two write
 * paths call, so a form the overview draws is a form that will be accepted
 * and a form it withholds is one that would have been refused. Drawing a
 * door and then refusing at it is the failure this is here to prevent.
 */
create or replace function public.entry_gates()
returns table (program_id uuid, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, app.entry_gate(p.id, null, auth.uid())
    from public.programs p
   where p.program_role = 'opportunity'
     and p.status = 'open'
     and (p.org_id is null
          or p.org_id = (select u.org_id from public.users u where u.id = auth.uid()))
     and app.entry_gate(p.id, null, auth.uid()) is not null;
$$;

grant execute on function public.entry_gates() to authenticated;


/**
 * THE PROGRAM'S DEADLINES, COPIED ONTO A PARTICIPATION.
 *
 * A copy rather than a reference, because a program that moves a date in
 * February must not silently rewrite what a student was told in September.
 * The copy is what they are held to; the program is what the fair publishes.
 *
 * Extracted because **a class has deadlines too, and nothing was copying
 * them.** `enter_program` did this inline, and `set_project_cohort` attached
 * the project and stopped -- so a project in IRPD had a participation, a
 * supervisor and a page, and an empty calendar. It went unnoticed because
 * the only page a cohort had resolved its dates from the template at render
 * time and never read this table, which also meant a class's deadlines had
 * no state: nothing could be marked done, because there was no row to mark.
 *
 * `org_id is null or org_id = v_org` is the school layer (6.8): the fair's
 * own dates, plus this school's own on top of them.
 *
 * **`satisfied_by` travels, and did not.** Extracting this from
 * `enter_program` copied that function's columns, and the column marking a
 * derived obligation was added to `start_entry`'s own inline copy and to
 * nowhere else. So an obligation that should close when a sponsor is named
 * arrived with a null marker everywhere except the one path that creates a
 * project and enters a fair in a single act: `app.sync_derived` had nothing
 * to find, and `set_milestone_done` -- which refuses to let a derived row be
 * ticked by hand -- had nothing to refuse. The sponsor work of 22.18 was
 * therefore correct and inert for every entry made by adding an existing
 * project, and for every class. Two copies of one statement, four columns
 * apart. 19.11a.
 */
create or replace function app.copy_milestones(
  p_participation_id uuid,
  p_program_id       uuid,
  p_org_id           uuid
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_copied int;
begin
  insert into public.entry_milestones
    (org_id, participation_id, program_milestone_id, name, kind, due_on, required,
     blocks_experimentation, satisfied_by, sort_order, source, phase)
  select p_org_id, p_participation_id, m.id, m.name, m.kind, m.due_on, m.required,
         m.blocks_experimentation, m.satisfied_by, m.sort_order, m.source, m.phase
    from public.program_milestones m
   where m.program_id = p_program_id
     and (m.org_id is null or m.org_id = p_org_id)
     and not exists (
       select 1 from public.entry_milestones e
        where e.participation_id = p_participation_id
          and e.program_milestone_id = m.id
     );

  get diagnostics v_copied = row_count;
  return v_copied;
end;
$$;


-- ---------------------------------------------------------------------------

create or replace function public.enter_program(
  p_project_id uuid,
  p_program_id uuid,
  p_via_id     uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_gate  text;
  v_entry uuid;
  v_via   uuid := p_via_id;
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

  /* **A project enters an opportunity; a person joins a cohort.**

     This guard did not exist before the merge, and its absence was a real
     hole: `enter_program` would happily make an entry out of IRPD, which is
     the 22.1 conflation by another route. The merge does not create the hole
     -- it changes what the correct guard is, because one table now holds
     both kinds and `program_role` is the only thing telling them apart.

     Said here as well as in the trigger because the message is the point: a
     student told "not allowed" learns nothing, and one told to join the
     class knows what to do. */
  if exists (
    select 1 from public.programs p
     where p.id = p_program_id and p.program_role = 'cohort'
  ) then
    raise exception 'that is a class or a club, not something a project is entered into. Join it, then add the project to it.';
  end if;

  /* The same gates the overview drew the form against. Passed the project,
     because a fair reached by advancing is asking what this project has
     already done. */
  v_gate := app.entry_gate(p_program_id, p_project_id, v_uid);

  if v_gate is not null then
    raise exception '%', v_gate;
  end if;

  /* Asked for, or joined. A program that takes a handful of students grants
     places; a fair takes everybody who turns up. The template says which,
     and it is a fact about the program rather than a setting.
   
     `on conflict` restores a withdrawn place to whatever joining that
     program does, so somebody who left and came back does not skip a queue
     they were meant to be in. */
  /* **Which cohort this entry went through.**
  
     22.16 has depended on this column since it was added and nothing has
     ever written it — only the seed — so the officer word, the selection cap
     and the school's own layer of dates could not resolve for anything a
     real person made. The caller may name it; where it does not, this asks
     the data.
  
     The question is not "which cohorts is this student in" but "which of
     *this project's* cohorts prepares for *this* opportunity". A student in
     IRPD and the research club, entering the fair the club prepares for,
     has exactly one answer even though they are in two cohorts, because
     IRPD prepares for nothing.
  
     Exactly one, or nothing. Two cohorts preparing for the same fair is a
     school running two clubs for it, and picking either one would put a
     project on a roster somebody has to answer for. A null here is a fact
     nobody has established, which is the honest state and the one the
     reading code already expects. */
  if v_via is null then
    /* One row or none, expressed as an aggregate rather than a `limit 1`,
       because "the only one" and "the first of several" are different
       answers and a limit cannot tell them apart. */
    select case when count(*) = 1 then (array_agg(c.id))[1] end into v_via
      from public.cohort_participations c
      join public.programs g on g.id = c.program_id
     where c.project_id = p_project_id
       and g.prepares_for = p_program_id
       and g.status = 'open';
  end if;

  insert into public.participations (org_id, project_id, program_id, status, via_id)
  select v_org, p_project_id, p_program_id,
         case when p.joining = 'approval' then 'requested' else 'entered' end,
         v_via
    from public.programs p
   where p.id = p_program_id
  on conflict (project_id, program_id) do update
     set status = case
                    when (select joining from public.programs where id = p_program_id)
                         = 'approval' then 'requested'
                    else 'entered'
                  end,
         /* Re-entering may name the club it went through; it must not erase
            one already recorded by passing null. */
         via_id = coalesce(excluded.via_id, public.participations.via_id)
  returning id into v_entry;

  perform app.copy_milestones(v_entry, p_program_id, v_org);

  perform app.audit(v_org, 'entry.created', 'participations', v_entry, null,
    jsonb_build_object('project_id', p_project_id, 'program_id', p_program_id,
                       'via_id', p_via_id));

  return v_entry;
end;
$$;

grant execute on function public.enter_program(uuid, uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.programs           enable row level security;
alter table public.program_milestones enable row level security;
alter table public.projects           enable row level security;
alter table public.project_authors    enable row level security;
alter table public.memberships        enable row level security;
alter table public.participations     enable row level security;
alter table public.entry_milestones   enable row level security;

grant select, insert, update on public.programs, public.program_milestones,
  public.projects, public.project_authors, public.participations,
  public.entry_milestones to authenticated, service_role;
-- `participations` is deliberately absent: leaving a cohort deletes the row,
-- because a project that was never in a class should leave no trace of having
-- been (22.5). The grant above it stands.
revoke delete on public.programs, public.program_milestones, public.projects,
  public.project_authors, public.entry_milestones
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

-- ===========================================================================
-- PROGRAMS AS EDITIONS, AND ONE VISIBILITY RULE
--
-- Brief 1.44 through 1.47. A school runs several structured research
-- activities; a program is one edition of one of them; roles are held in a
-- program rather than in the school; and where a project is comes from its
-- steps rather than from a column.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- What a program now carries.
--
-- `family` is a key, not an object. There is no parent row and nothing hangs
-- off it: a family with staff would be the seasons model returning through
-- the side door, and high school turnover does not match a durable thing.
-- ---------------------------------------------------------------------------

create index if not exists programs_family_idx
  on public.programs (org_id, family) where current;


-- ---------------------------------------------------------------------------
-- Roles scope to a program.
--
-- `scope_id` has existed since the first migration and nothing has ever set
-- it. This is what it was for. A student role granted against an edition
-- lapses when the edition does, which is not a mechanism built to solve a
-- problem: it corrects one. Roles were granted against the school with no
-- expiry, so a graduated officer held theirs forever unless somebody revoked
-- it by hand, and nobody would.
-- ---------------------------------------------------------------------------
comment on column public.user_roles.scope_id is
  'The program this role is held in. Null for a role held at the school: '
  'student, and the school administrator. 6.4.';


-- ---------------------------------------------------------------------------
-- Participation. `entries` already meant "one project in one program"; what
-- changes is that a program need not be a competition.
--
-- The rename to `participations` is open item 52 and is deliberately not done
-- here: it touches every page and carries no behavior with it, and mixing a
-- rename into a policy rewrite is how a policy rewrite goes wrong unnoticed.
-- ---------------------------------------------------------------------------
comment on table public.participations is
  'One project participating in one program. A competition entry is one kind; '
  'a course enrollment and a journal submission are others. To be renamed to '
  'participations, open item 52.';


-- ---------------------------------------------------------------------------
-- A project has no stage.
--
-- It was a competition lifecycle imposed on everything, and a design research
-- course has different stages while generic research has almost none. Where a
-- project is comes from its steps, which the program declares.
--
-- Kept as a column for one release so nothing breaks mid-refactor, and
-- ignored by everything. Dropped in the next migration.
-- ---------------------------------------------------------------------------


comment on column public.projects.is_private is
  'Set by any author. Keeps the project out of the browsable history for '
  'staff of later editions. Does not hide a running project from the people '
  'responsible for it, and does not unpublish a published record. 6.6.';

-- `app.is_advisor()` is defined with the other authorization helpers, above
-- everything that calls it. It used to be declared here as well, on the
-- reasoning that `create or replace` keeps one oid so a second declaration is
-- free. It is not free to read: it is how twelve functions came to have
-- twenty-eight bodies. One declaration, in the helpers.


-- ---------------------------------------------------------------------------
-- WHO CAN SEE A PROJECT
--
-- One rule, in one place, because forty-eight policies reimplementing a
-- four-table join is how an access model becomes slow and quietly wrong.
--
-- Visible to its authors, to the school administrator, and to staff of any
-- program in the same FAMILY as a program the project participates in.
--
-- Family rather than edition: this year's officers see the club's whole
-- history, which is the institutional knowledge a club runs on. Family rather
-- than school: IRPD's elders have no business in the fair's archive.
--
-- A graduated officer sees nothing, because they hold a role in an edition
-- that has ended and no current edition has granted them anything.
-- ---------------------------------------------------------------------------
create or replace function app.can_see_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    -- Its authors, always. Authorship is independent of every role and
    -- survives graduation.
    exists (
      select 1 from public.project_authors a
       where a.project_id = p_project_id
         and a.user_id = auth.uid()
    )

    -- And whoever created it.
    --
    -- A project is created and its first author row written in the next
    -- statement. Between those two there is no author, and without this the
    -- creator can edit a row they cannot read: `can_edit_project` counts the
    -- creator and this did not. An UPDATE that returns nothing, on a project
    -- you just made, with no route back to it.
    --
    -- Found by running the policies against a real database rather than
    -- reading them, which is the only way this kind of asymmetry shows up.
    or exists (
      select 1 from public.projects p
       where p.id = p_project_id
         and p.created_by = auth.uid()
    )

    -- The advisor and the school administrator. A teacher's duty of care does
    -- not toggle, so this is unaffected by the privacy setting.
    or app.is_advisor()

    -- Officers of any current program in a family this project participates
    -- in. Only officers: this clause is scoped by `scope_id`, and an advisor
    -- is answered in full by `app.is_advisor()` above, scope or none. It read
    -- `('officer', 'mentor')`, and a role the check constraint refuses adds
    -- nothing but the impression that teachers are handled here.
    or exists (
      select 1
        from public.participations e
        join public.programs mine on mine.id = e.program_id
        join public.programs theirs
          on theirs.org_id = mine.org_id
         and theirs.family is not distinct from mine.family
         and theirs.current
        join public.user_roles r
          on r.scope_id = theirs.id
         and r.user_id = auth.uid()
         and r.role = 'officer'
         and r.revoked_at is null
       where e.project_id = p_project_id
         -- A private project leaves the browsable history. It stays visible
         -- to whoever is running it now, because a student cannot be allowed
         -- to conceal a missing approval from the person who signs it.
         and (
           not (select p.is_private from public.projects p where p.id = p_project_id)
           or theirs.id = mine.id
         )
    );
$$;

grant execute on function app.can_see_project(uuid) to authenticated;


-- Can this person change it. Authors and the advisor; staff comment and
-- chase rather than edit.
create or replace function app.can_edit_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1 from public.project_authors a
       where a.project_id = p_project_id
         and a.user_id = auth.uid()
         and a.role = 'author'
    )
    -- The creator, until the author rows exist. A project is created and its
    -- first author written in the next statement, and between those two an
    -- author check is false, which would make creating a project impossible.
    or exists (
      select 1 from public.projects p
       where p.id = p_project_id and p.created_by = auth.uid()
    )
    or app.is_advisor();
$$;

grant execute on function app.can_edit_project(uuid) to authenticated;

create policy projects_read on public.projects
  for select to authenticated
  using ((select app.can_see_project(projects.id)));

create policy projects_create on public.projects
  for insert to authenticated
  -- Not can_edit_project: on INSERT the row does not exist yet, so there is
  -- nothing to look up. What is checkable is the organization and that
  -- somebody is not creating a project in another person's name.
  with check (
    org_id = (select app.org_id())
    and created_by = (select auth.uid())
  );

create policy projects_update on public.projects
  for update to authenticated
  using ((select app.can_edit_project(projects.id)));

create policy project_authors_read on public.project_authors
  for select to authenticated
  using ((select app.can_see_project(project_authors.project_id)));

create policy project_authors_write on public.project_authors
  for insert to authenticated
  with check ((select app.can_edit_project(project_authors.project_id)));

create policy project_authors_update on public.project_authors
  for update to authenticated
  using ((select app.can_edit_project(project_authors.project_id)));

create policy participations_read on public.participations
  for select to authenticated
  using ((select app.can_see_project(participations.project_id)));

create policy participations_write on public.participations
  for update to authenticated
  using ((select app.can_edit_project(participations.project_id)));

-- memberships ---------------------------------------------------------------
--
-- A roster is not a secret inside a school: a club member may see who else is
-- in the club, which is what makes a club a thing rather than a list held by
-- a teacher. Across schools it is nobody's business, so the tenant boundary
-- is the whole of the rule.
create policy memberships_read on public.memberships
  for select to authenticated
  using (org_id = (select app.org_id()));

-- Asking to join is a student's own act, and only their own.
create policy memberships_request on public.memberships
  for insert to authenticated
  with check (
    org_id = (select app.org_id())
    and user_id = (select auth.uid())
    and state = 'requested'
  );

-- Deciding belongs to whoever runs the cohort, and goes through a function
-- rather than a policy: granting a place has to check places remaining and
-- write an audit row, and a policy can do neither.

-- participations ------------------------------------------------------------
--
-- Which cohort a project belongs to is as visible as the project, which is
-- `participations_read` above and not a second policy.
--
-- `project_cohorts_read` used to grant this org-wide. Two permissive select
-- policies on one table are OR-ed, so keeping both would have made every
-- cohort row in the school readable by everyone -- a visibility regression
-- the merge would have introduced silently. Writing still goes through a
-- function, because it has to hold that the person is a member of the cohort
-- they are claiming.

create policy entry_milestones_read on public.entry_milestones
  for select to authenticated
  using ((select app.can_see_project((select e.project_id from public.participations e where e.id = entry_milestones.participation_id))));

create policy entry_milestones_update on public.entry_milestones
  for update to authenticated
  using ((select app.can_edit_project((select e.project_id from public.participations e where e.id = entry_milestones.participation_id))));


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

-- ---------------------------------------------------------------------------
-- The fair and its deadlines used to be written here by hand: one program,
-- twelve milestones, dates typed into an insert.
--
-- They come from `src/config/programs/` now, seeded by
-- `scripts/seed-programs.mjs`, because a fair's calendar is data a person
-- reads off the organizer's page once a year and not something to edit a
-- migration for. A row seeded that way carries `template_id`, which is what
-- marks it as derived and what lets a reset regenerate it.
-- ---------------------------------------------------------------------------




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
/**
 * The research process a project starting in this program should follow.
 *
 * A cohort prescribes it — enrolling in IRPD picks the class's framework —
 * and anything else falls to the column default. Read from the program row
 * rather than passed in, so three call sites that create projects cannot
 * disagree about it (22.4).
 *
 * Null when the program says nothing, which lets the insert fall through to
 * the default rather than writing one process's name over another's.
 */
create or replace function app.process_for(p_program_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.process_id
    from public.programs p
   where p.id = p_program_id
     and (p.program_role = 'cohort' or p.kind = 'grant')
$$;

-- ---------------------------------------------------------------------------

/**
 * JOINING A COHORT.
 *
 * A person enrolls in a class or a club. **No project is created**, which is
 * the whole point: `start_entry` had to invent one in order to have
 * something to hang an enrolment on, and that is how a class and a regional
 * fair came to sit at one level (22.1).
 *
 * A cohort that admits anybody grants the place here; one that decides
 * records the request and waits.
 */
create or replace function public.join_cohort(p_cohort_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_org    uuid;
  v_status text;
  v_role   text;
  v_joining text;
  v_id     uuid;
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

  select p.program_role, p.joining into v_role, v_joining
    from public.programs p
   where p.id = p_cohort_id
     and p.status = 'open'
     and (p.org_id is null or p.org_id = v_org);

  if v_role is null then
    raise exception 'that is not open to this school';
  end if;

  /* The trigger on `memberships` would refuse this too. Saying it here means
     a person reads why rather than reading a constraint's name. */
  if v_role <> 'cohort' then
    raise exception 'a project enters that; a person does not join it';
  end if;

  /* **A second ask is a real ask.**
 
     This wrote `else public.memberships.state` for every state but `left`, so
     a student who had been turned down clicked *Request to join*, the row did
     not move, the function returned an id, and the page said the request had
     been sent. Nothing had been sent. A refusal that the software will not let
     you respond to, while telling you that you have responded, is the worst of
     the three possible behaviors -- worse than a lockout that says so.
 
     `declined` therefore returns to `requested`, and the decision is cleared
     rather than kept, because the queue reads `decided_at` to sort and a row
     carrying an old refusal alongside a new request describes two moments at
     once. The refusal survives in `audit_log`, which is where the history
     belongs.
 
     A student who is already `requested` or a `member` is a no-op and stays
     one -- there is nothing to move and nothing to tell them. */
  insert into public.memberships (org_id, user_id, cohort_id, state)
  values (v_org, v_uid, p_cohort_id,
          case when v_joining = 'approval' then 'requested' else 'member' end)
  on conflict (user_id, cohort_id) do update
    set state = case
                  when public.memberships.state in ('left', 'declined') then excluded.state
                  else public.memberships.state
                end,
        joined_at = case
                      when public.memberships.state in ('left', 'declined') then now()
                      else public.memberships.joined_at
                    end,
        decided_at = case
                       when public.memberships.state in ('left', 'declined') then null
                       else public.memberships.decided_at
                     end,
        decided_by = case
                       when public.memberships.state in ('left', 'declined') then null
                       else public.memberships.decided_by
                     end,
        note = case
                 when public.memberships.state in ('left', 'declined') then null
                 else public.memberships.note
               end
  returning id into v_id;

  perform app.audit(v_org, 'membership.requested', 'memberships', v_id, null,
    jsonb_build_object('cohort_id', p_cohort_id));

  return v_id;
end;
$$;

/**
 * STARTING A PROJECT, WITH NO PROGRAM IN SIGHT.
 *
 * The solo path, and the ordinary one: a project exists because somebody
 * started work, not because they joined something. Where a cohort is named
 * the project is attached to it and takes its process; where none is, the
 * project keeps the default and belongs to nobody, which is the truth about
 * a student with no class and no club (22.10).
 */
/**
 * PUTTING A PROJECT IN A COHORT, OR TAKING IT OUT.
 *
 * The relationship the model needed a name for: *this is my IRPD project*
 * (22.5). Separate from joining, because a person may be in a cohort for a
 * year before starting anything, and separate from entering, because a class
 * is not somewhere work is submitted.
 *
 * **The author has to be a member.** Not the other way round: a partner from
 * another school authors the work without being in anybody's class, and
 * inferring the cohort from the authors is exactly what the third
 * relationship exists to avoid. What is required is that whoever claims the
 * project for a cohort is in it.
 */
/**
 * DECIDING WHETHER SOMEBODY IS IN A COHORT.
 *
 * `decide_place` does this for an entry, and a membership needed its own
 * because the two stopped being one row (22.5). The rule is the same one the
 * approval queue has always used: whoever holds a role on that cohort, or an
 * advisor whose role names no cohort and therefore covers the school.
 */
create or replace function public.decide_membership(
  p_membership_id uuid,
  p_grant         boolean,
  p_note          text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_org    uuid;
  v_cohort uuid;
  v_state  text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select m.org_id, m.cohort_id, m.state
    into v_org, v_cohort, v_state
    from public.memberships m
   where m.id = p_membership_id;

  if v_org is null then
    raise exception 'no such request';
  end if;

  /* A role scoped to a cohort means that cohort; an unscoped advisor covers
     the school. A club officer must not decide who is in the class. */
  if not exists (
    select 1 from public.user_roles r
     where r.user_id = v_uid
       and r.org_id = v_org
       and r.revoked_at is null
       and r.role in ('officer', 'advisor')
       and (r.scope_id = v_cohort or (r.scope_id is null and r.role = 'advisor'))
  ) then
    raise exception 'that is not yours to decide';
  end if;

  if v_state <> 'requested' then
    raise exception 'that has already been decided';
  end if;

  update public.memberships
     set state = case when p_grant then 'member' else 'declined' end,
         decided_at = now(),
         decided_by = v_uid,
         note = p_note
   where id = p_membership_id;

  /* **The person waiting is told.**
 
     A decision is the one event a student is actually waiting on, and until
     now it was silent: they asked, and found out by coming back and looking.
     Written in this transaction, so a decision that commits has a message and
     one that rolls back has none (20.7).
 
     The note travels because a refusal without a reason is the thing that
     sends a student to find a teacher in a corridor. Nothing else does: not
     the cohort's roster, not who else applied. The dedupe key is the
     membership, so re-deciding the same request cannot send twice -- and a
     student who asks again after a refusal gets a new row from `join_cohort`
     with a new id, which is a new decision and rightly a second message. */
  insert into public.notifications
    (org_id, kind, recipient_id, actor_id, subject_kind, subject_id, payload, dedupe_key)
  select v_org,
         case when p_grant then 'membership_granted' else 'membership_declined' end,
         m.user_id, v_uid, 'membership', p_membership_id,
         jsonb_build_object('cohort_id', v_cohort, 'note', p_note),
         case when p_grant then 'membership_granted:' else 'membership_declined:' end
           || p_membership_id || ':' || extract(epoch from m.joined_at)::bigint
    from public.memberships m
   where m.id = p_membership_id
     and m.user_id <> v_uid
  on conflict (recipient_id, dedupe_key) do nothing;

  perform app.audit(v_org, case when p_grant then 'membership.granted' else 'membership.declined' end,
    'memberships', p_membership_id, null, jsonb_build_object('cohort_id', v_cohort));
end;
$$;

create or replace function public.set_project_cohort(
  p_project_id uuid,
  p_cohort_id  uuid,
  p_in         boolean default true
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_participation uuid;
  v_uid uuid := auth.uid();
  v_org uuid;
  v_constraint text;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  if v_org is null then
    raise exception 'no such project';
  end if;

  /* An author of the work, or somebody who runs the school. A club officer
     may put a project in their own club's list; a passing student may not. */
  if not exists (
    select 1 from public.project_authors a
     where a.project_id = p_project_id
       and a.user_id = v_uid
       and a.role = 'author'
       and a.accepted_at is not null
  ) and not app.is_staff() then
    raise exception 'only an author of this project, or the school, can do that';
  end if;

  if not p_in then
    /* **Leaving takes the copies with it.**
    
       22.5: leaving a cohort deletes the row, because a project that was
       never in a class should leave no trace of having been. What that
       sentence did not account for is what hangs off the row by then.
       `app.copy_milestones` writes the class's dates onto the participation
       at the moment of joining, and `entry_milestones.participation_id` is
       `on delete restrict`, so the delete failed on a constraint name --
       *update or delete on table "participations" violates foreign key
       constraint "entry_milestones_participation_id_fkey"* -- which is not a
       sentence anybody can act on.
    
       The copies go, and they go without ceremony, because that is all they
       are: a copy of the class's published calendar plus which of them this
       project had ticked. Rejoining calls `copy_milestones` again and makes
       them afresh. Nothing a student typed lives here.
    
       Anything else that keys to the participation is a thing somebody
       recorded, and those are **refused rather than cascaded**: a teacher's
       signature and an uploaded document are not ours to delete because a
       student clicked Remove.
    
       Read off the constraint rather than by asking each table in turn. Two
       reasons, and the second is the one that matters. Naming
       `project_sponsors` and `deliverables` here would have this function
       read two tables the migration creates a thousand lines further down,
       which `test:sqlorder` refuses and which is a genuine hazard for a
       SQL-language function. And a child table added later is covered by
       this without anybody remembering to add a branch -- it degrades to a
       plain sentence rather than to the raw constraint text. */
    delete from public.entry_milestones em
     using public.participations pa
     where pa.id = em.participation_id
       and pa.project_id = p_project_id
       and pa.program_id = p_cohort_id;

    begin
      delete from public.participations
       where project_id = p_project_id and program_id = p_cohort_id;
    exception when foreign_key_violation then
      get stacked diagnostics v_constraint = constraint_name;

      if v_constraint like 'project_sponsors%' then
        raise exception
          'a teacher is recorded as sponsoring this project here. Ask them, or an officer, to take that off first.';
      elsif v_constraint like 'deliverables%' then
        raise exception
          'there are documents recorded against this class. Removing it would delete them, so it is not done from here.';
      else
        raise exception
          'something recorded against this class is still attached to it, so it cannot be removed yet.';
      end if;
    end;

    perform app.audit(v_org, 'project.left_cohort', 'projects', p_project_id, null,
      jsonb_build_object('cohort_id', p_cohort_id));
    return;
  end if;

  /* Claiming a project for a cohort you are not in would let somebody put
     work into a class they never joined, and the roster is what a teacher
     reads. Staff are exempt: an advisor tidying up is the ordinary case. */
  if not exists (
    select 1 from public.memberships m
     where m.user_id = v_uid
       and m.cohort_id = p_cohort_id
       and m.state = 'member'
  ) and not app.is_staff() then
    raise exception 'join that first. A project belongs to a cohort you are in.';
  end if;

  insert into public.participations (org_id, project_id, program_id, added_by)
  values (v_org, p_project_id, p_cohort_id, v_uid)
  on conflict (project_id, program_id) do nothing
  returning id into v_participation;

  /* Re-attaching after leaving finds the row already there and returns
     nothing, so the id is looked up rather than assumed. */
  if v_participation is null then
    select pa.id into v_participation
      from public.participations pa
     where pa.project_id = p_project_id and pa.program_id = p_cohort_id;
  end if;

  /* **The class's deadlines, frozen at the moment of joining**, exactly as
     an entry's are. Without this the page for a class was a page with a
     calendar and nothing in it. */
  perform app.copy_milestones(v_participation, p_cohort_id, v_org);

  perform app.audit(v_org, 'project.joined_cohort', 'projects', p_project_id, null,
    jsonb_build_object('cohort_id', p_cohort_id));
end;
$$;

create or replace function public.start_project(
  p_title      text,
  p_started_on date,
  p_cohort_id  uuid default null
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

  /* A cohort may prescribe the process; anything else takes the default,
     which is what stops a fourteen year old's first screen being a question
     about research methodology (22.4). */
  insert into public.projects (org_id, title, started_on, created_by, process_id)
  values (v_org, trim(p_title), p_started_on, v_uid,
          coalesce(app.process_for(p_cohort_id), 'process-science'))
  returning id into v_project;

  insert into public.project_authors
    (org_id, project_id, user_id, role, accepted_at)
  values (v_org, v_project, v_uid, 'author', now());

  if p_cohort_id is not null then
    /* **One way in, called from both directions.**
    
       This inserted the participation itself and, until the fix that
       preceded this one, forgot to copy the class's calendar -- so a project
       *started* in a class had no deadlines while one *added* to the same
       class had them, and the two paths disagreed for as long as nobody
       tried both. That is the same fault as the twenty-eight function
       bodies of 19.11a wearing different clothes: two pieces of code doing
       one job, drifting apart quietly because nothing forced them to agree.
    
       Making them agree was not enough. They are one now: attaching a
       project to a cohort happens in `set_project_cohort` and nowhere else,
       so the calendar, the membership rule and the audit line are decided
       once.
    
       **Which also closes a hole.** `set_project_cohort` refuses a cohort
       the caller has not joined -- claiming a project for a class you are
       not in would put work on a teacher's roster -- and this path never
       asked. The picker only offers cohorts you are in, so nothing
       legitimate changes; a request that did not come from the picker is
       now refused. The author row is written above, which is what that
       function checks. */
    perform public.set_project_cohort(v_project, p_cohort_id, true);
  end if;

  perform app.audit(v_org, 'project.created', 'projects', v_project, null,
    jsonb_build_object('cohort_id', p_cohort_id));

  return v_project;
end;
$$;





grant execute on function public.join_cohort(uuid) to authenticated;
grant execute on function public.decide_membership(uuid, boolean, text) to authenticated;
grant execute on function public.set_project_cohort(uuid, uuid, boolean) to authenticated;
grant execute on function public.start_project(text, date, uuid) to authenticated;

-- PostgREST caches the schema. A function added by a migration is invisible
-- to the API until it reloads, which presents as "could not find the
-- function ... in the schema cache" even though it exists.
notify pgrst, 'reload schema';

-- Creating a project no longer requires the student role. An officer running
-- a demonstration, and a staff account helping a student set one up, both
-- have legitimate reason to, and the author link is what actually confers
-- editing rights.


-- INSERT ... RETURNING needs SELECT to pass on the new row, whose author
-- link is written in the next statement. The creator can always read it.



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



grant execute on function app.authors_project(uuid) to authenticated;

notify pgrst, 'reload schema';


-- ---------------------------------------------------------------------------
-- Attaching a mentor or an officer to a project.
--
-- **Superseded, and left standing pending a decision.** Three things are true
-- of it now. `p_role` admits `mentor`, and `project_authors.role` permits only
-- `author` and `officer`, so that half of it cannot insert a row and fails on
-- the constraint rather than on the message below. Its sponsor branch clears
-- every approval on the project, which is the pre-22.18 scoping that
-- `record_sponsor` and `app.sync_derived` replaced. And nothing reaches it:
-- `src/pages/app/index.astro` still handles `action === 'attach'`, and no form
-- in the file posts that action.
--
-- What follows is what it was for, and is kept because the reasoning about
-- sponsorship is still the design even though this is no longer where it
-- happens.
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
      from public.participations e
     where e.id = em.participation_id
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


grant execute on function public.attach_to_project(uuid, uuid, text, date) to authenticated;

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
  participation_id     uuid not null references public.participations on delete restrict,
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

  /* **Superseded, never edited**, as a sponsor is (22.18). A student who
     recorded the wrong link, or recorded a draft and then finished it, is
     ordinary; overwriting the row would erase the date the first one carried,
     and `checkDateOrder` reads those dates against a signature. So the old
     row stays and points at the one that replaced it.

     Until this existed `record_deliverable` inserted unconditionally, and the
     only thing preventing two rows for one obligation was that the page hid
     the form once anything was recorded. A protection that lives in the
     markup is a protection that ends the moment the markup moves, which is
     exactly what folding the form into the deadline rows does. */
  superseded_at timestamptz,
  superseded_by uuid references public.deliverables on delete restrict,

  created_by   uuid not null references public.users on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

/* One current deliverable of a kind per place. The partial index is the
   constraint: superseded rows are outside it, so a history of four accumulates
   under one live row. */
create unique index deliverables_one_current
  on public.deliverables (participation_id, type)
  where superseded_at is null;

create index deliverables_entry_idx on public.deliverables (participation_id);
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
end;
$$;


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
  using ((select app.can_see_project((select e.project_id from public.participations e where e.id = deliverables.participation_id))));

create policy deliverables_write on public.deliverables
  for insert to authenticated
  with check ((select app.can_edit_project((select e.project_id from public.participations e where e.id = deliverables.participation_id))));

create policy deliverables_update on public.deliverables
  for update to authenticated
  using ((select app.can_edit_project((select e.project_id from public.participations e where e.id = deliverables.participation_id))));

create policy field_notes_read on public.field_notes
  for select to authenticated
  using ((select app.can_see_project(field_notes.project_id)));

create policy note_media_read on public.note_media
  for select to authenticated
  using ((select app.can_see_project((select n.project_id from public.field_notes n where n.id = note_media.note_id))));

create policy project_links_read on public.project_links
  for select to authenticated
  using ((select app.can_see_project(project_links.project_id)));

create policy project_links_write on public.project_links
  for insert to authenticated
  with check ((select app.can_edit_project(project_links.project_id)));


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
-- Verifying a deliverable, recording one, storing a link, and writing in the
-- notebook.
--
-- Each of these is defined once, at the point of its last revision, so they
-- no longer read in the order this heading lists them. `add_field_note` is
-- furthest down because it was the last of the four to change.
-- ---------------------------------------------------------------------------

create or replace function public.verify_deliverable(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not app.is_staff() then
    raise exception 'only an officer or the club advisor may verify a deliverable';
  end if;

  update public.deliverables
     set verified_by = auth.uid(), verified_at = now()
   where id = p_id and org_id = app.org_id();

  perform app.audit(app.org_id(), 'deliverable.verified', 'deliverables', p_id,
    null, null);
end;
$$;


grant execute on function public.verify_deliverable(uuid) to authenticated;

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
  p_participation_id     uuid,
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
  v_previous uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select e.org_id, e.project_id into v_org, v_project
    from public.participations e where e.id = p_participation_id;

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

  /* **The one it replaces, if there is one.**
  
     Recording the same kind twice used to insert a second row, and both were
     live: the page read whichever came back first, the count of what had been
     recorded could exceed what was asked for, and the earlier date -- the one
     the ordering check reads -- was still sitting there to be found. Nothing
     stopped it but the form being hidden once anything existed.
  
     A correction is ordinary. A student records a link, then finishes the
     document and records the finished one; a form is signed again after the
     first was rejected. So the old row is kept and marked, exactly as a
     sponsor is (22.18), and the unique index makes this the only way. */
  select d.id into v_previous
    from public.deliverables d
   where d.participation_id = p_participation_id
     and d.type = p_type
     and d.superseded_at is null
   limit 1;

  /* Stood down first, because `deliverables_one_current` is a real index and
     two live rows do not exist even for the length of a statement. The row it
     was replaced by is written back afterwards, once there is one to name. */
  if v_previous is not null then
    update public.deliverables
       set superseded_at = now()
     where id = v_previous;
  end if;

  insert into public.deliverables
    (org_id, participation_id, milestone_id, type, label, signed_on,
     external_url, storage_path, submitted_at, created_by)
  values
    (v_org, p_participation_id, p_milestone_id, p_type, trim(p_label), p_signed_on,
     nullif(trim(coalesce(p_external_url, '')), ''),
     nullif(trim(coalesce(p_storage_path, '')), ''),
     now(), auth.uid())
  returning id into v_id;

  if v_previous is not null then
    update public.deliverables
       set superseded_by = v_id
     where id = v_previous;
  end if;

  /* The milestone follows the current row. `completed_on is null` is kept:
     a replacement should not move a date that a first recording already
     set, because the obligation was met when it was first met. */
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


-- Attaching an image follows the same rule as writing the note it hangs off,
-- which `add_field_note` states in full where it is defined.
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

  -- **Which participation this sponsor is for.**
  --
  -- It was `project_id`, and that was the bug: recording a sponsoring teacher
  -- for IRPD attached them to the project, so they showed on every cohort and
  -- every entry the project had. A sponsor is a fact about one participation
  -- -- the teacher who signed for *this* fair, in *this* class -- and the
  -- approval obligation it clears belongs to that participation's calendar.
  --
  -- This is one of the four tables that wanted a single participation id and
  -- could not have one while `entries` and `project_cohorts` were separate
  -- tables (22.5).
  participation_id uuid not null references public.participations on delete restrict,

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

create index project_sponsors_participation_idx
  on public.project_sponsors (participation_id) where superseded_at is null;

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



update public.programs
   set selection_cap = 50
 where slug = 'scvsefa-science-fair' and selection_cap is null;


-- ---------------------------------------------------------------------------
-- Helpers, restated for the two-axis model.
-- ---------------------------------------------------------------------------



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
      join public.participations pa on pa.id = s.participation_id
      join public.identities i
        on lower(i.email) = lower(s.teacher_email)
     where pa.project_id = p_project_id
       and s.superseded_at is null
       and i.user_id = auth.uid()
       and i.revoked_at is null
  );
$$;

grant execute on function app.is_advisor(), app.sponsors_project(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Recording a sponsor. The student does this.
-- ---------------------------------------------------------------------------


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
  select pa.project_id into v_project
    from public.project_sponsors s
    join public.participations pa on pa.id = s.participation_id
   where s.id = p_sponsor_id;

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


create or replace function public.set_selection(
  p_participation_id uuid,
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

  select e.org_id into v_org from public.participations e where e.id = p_participation_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such entry at this school';
  end if;

  update public.participations
     set selection_state = p_state,
         selection_decided_at = case when p_state = 'candidate' then null else now() end,
         selection_decided_by = case when p_state = 'candidate' then null else auth.uid() end,
         selection_note = p_note
   where id = p_participation_id;

  perform app.audit(v_org, 'selection.' || p_state, 'entries', p_participation_id,
    null, jsonb_build_object('note', p_note));
end;
$$;

grant execute on function public.confirm_sponsorship(uuid) to authenticated;
grant execute on function public.set_selection(uuid, text, text) to authenticated;

grant select, insert, update on public.project_sponsors to authenticated, service_role;
revoke delete on public.project_sponsors from authenticated, service_role;
alter table public.project_sponsors enable row level security;


-- ---------------------------------------------------------------------------
-- Reading, restated. Four ways to see a project:
--   you author it, you are the officer on it, you run the club, or your
--   address is the sponsor's.
-- ---------------------------------------------------------------------------









create policy project_sponsors_read on public.project_sponsors
  for select to authenticated
  using ((select app.can_see_project(
    (select pa.project_id from public.participations pa
      where pa.id = project_sponsors.participation_id))));

-- ---------------------------------------------------------------------------
-- Whoever may read a project may add an observation to it.
--
-- An earlier version required attachment, which quietly assumed that seeing a
-- project and being attached to it are the same thing. They are not: an
-- officer reads every project at the school by role, and is attached to only
-- the ones somebody attached them to. So an officer could open a notebook,
-- be invited to add an observation, and be told they were not attached.
--
-- The rule that matches the design: reading is decided by role or
-- attachment, and writing an attributed observation follows reading. Editing
-- the work still follows authorship, which is enforced separately.
--
-- A sponsor writes an observation like anyone else who can read the project,
-- which is the third clause below: `add_field_note` already asks the reading
-- question, so it only has to ask the new one too.
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



comment on column public.entry_milestones.satisfied_by is
  'The fact that closes this obligation, or null when a person reports it. '
  'A derived obligation is never hand ticked; it follows the fact.';

-- The copy at entry time carries it across.

grant execute on function public.join_cohort(uuid) to authenticated;
grant execute on function public.decide_membership(uuid, boolean, text) to authenticated;
grant execute on function public.set_project_cohort(uuid, uuid, boolean) to authenticated;
grant execute on function public.start_project(text, date, uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- The date a derived obligation follows from, for one obligation.
--
-- Written once and called twice, by the update below and by the guard that
-- decides whether the update has anything to do. Those two have to give the
-- same answer, and the way to guarantee that is to have one of them.
--
-- Null is a real answer and means the fact has not happened: no sponsor at
-- this participation, no officer, no start date. `sync_derived` writes it
-- back, which is how an obligation reopens when the fact that closed it
-- stops being true.
-- ---------------------------------------------------------------------------

create or replace function app.derived_date(
  p_satisfied_by     text,
  p_participation_id uuid,
  p_start            date
)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select case p_satisfied_by
           when 'sponsor' then (
             /* This participation's sponsor and no other (22.18). A sponsor
                with no signature date still counts as named, so the date it
                was recorded is what we have. */
             select coalesce(s.signed_on, s.recorded_at::date)
               from public.project_sponsors s
              where s.participation_id = p_participation_id
                and s.superseded_at is null
              order by s.recorded_at desc
              limit 1)
           when 'officer' then (
             /* This participation's officer, for the same reason as the
                sponsor above. Oversight belongs to the place now, so an
                obligation reading "somebody is looking after this" is
                answered by whoever is looking after it *here* — the club's
                officer accepting must not close the class's row. */
             select a.accepted_at::date
               from public.project_authors a
              where a.participation_id = p_participation_id
                and a.role = 'officer'
              order by a.accepted_at
              limit 1)
           when 'start_date' then p_start
         end;
$$;


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
  v_start   date;
  v_touched int := 0;
begin
  /* **One of the three facts belongs to the project and two belong to the
     place.**
 
     `projects.started_on` is project level, so the start date is the same
     answer at every venue and fans out across all of them.
 
     The officer used to be counted with it, and stopped being when oversight
     moved to the participation: the class's Elder and the club's officer are
     two people, so "somebody is looking after this" has a different answer
     in each place and is resolved there.
 
     A sponsor is not. 22.18: a student in the class, the club and a fair has
     three sponsors and they are three different people, so the sponsor is
     resolved per participation, correlated on `em.participation_id`.
 
     An earlier version of this function took any current sponsor on any of
     the project's participations and wrote it onto every obligation, on the
     reasoning that the ordering check asks a question about the project
     rather than about one venue. It reintroduced the exact bug 22.18 records
     as fixed: naming the teacher who runs IRPD closed the fair's approval as
     well, and stamped it with a signature date the fair had never been given.
     That is worse than a wrong tick, because `checkDateOrder` reads
     `signedOn ?? completedOn` per obligation -- so a borrowed date reads as a
     sponsor found before work began, and suppresses the disqualifying finding
     the ordering check exists to raise. The check is per obligation, which
     means the per-participation answer is also the more accurate one. */
  select p.started_on into v_start
    from public.projects p where p.id = p_project_id;

  update public.entry_milestones em
     set completed_on = app.derived_date(
           em.satisfied_by, em.participation_id, v_start),
         completed_by = null
    from public.participations e
   where e.id = em.participation_id
     and e.project_id = p_project_id
     and em.satisfied_by is not null
     and em.completed_on is distinct from app.derived_date(
           em.satisfied_by, em.participation_id, v_start);

  get diagnostics v_touched = row_count;
  return v_touched;
end;
$$;

grant execute on function app.sync_derived(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Every write that could change a derived fact reconciles afterwards.
-- ---------------------------------------------------------------------------

create or replace function public.record_sponsor(
  p_participation_id uuid,
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
  v_project  uuid;
  v_previous uuid;
  v_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  /* The participation names the project; the project is what authorship is
     checked against. Resolved first because everything below needs it. */
  select pa.project_id, pa.org_id into v_project, v_org
    from public.participations pa
   where pa.id = p_participation_id;

  if v_project is null then
    raise exception 'no such participation';
  end if;

  if not (app.authors_project(v_project) or app.is_staff()) then
    raise exception 'only an author on this project may record its sponsor';
  end if;

  if coalesce(trim(p_teacher_name), '') = '' then
    raise exception 'give the teacher''s name';
  end if;

  if p_teacher_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'that does not look like an email address';
  end if;

  select s.id into v_previous
    from public.project_sponsors s
   where s.participation_id = p_participation_id and s.superseded_at is null
   limit 1;

  insert into public.project_sponsors
    (org_id, participation_id, teacher_name, teacher_email, signed_on, recorded_by)
  values
    (v_org, p_participation_id, trim(p_teacher_name), lower(trim(p_teacher_email)),
     p_signed_on, auth.uid())
  returning id into v_id;

  if v_previous is not null then
    update public.project_sponsors
       set superseded_at = now(), superseded_by = v_id
     where id = v_previous;
  end if;

  perform app.sync_derived(v_project);

  /* Named on the strength of a teacher's signature, not by the student, so
     the self-edit guard is told this is the software acting. Raised for one
     statement and lowered immediately: see `app.guard_users_update`. */
  perform set_config('app.system_grant', 'on', true);

  update public.users u
     set affiliation_state = 'mentor_verified',
         affiliation_verified_at = now(),
         status = case when u.status = 'unaffiliated' then 'active' else u.status end
    from public.project_authors a
   where a.project_id = v_project
     and a.role = 'author'
     and a.user_id = u.id
     and u.affiliation_state = 'unverified';

  perform set_config('app.system_grant', 'off', true);

  perform app.audit(v_org, 'sponsor.recorded', 'participations', p_participation_id,
    case when v_previous is null then null
         else jsonb_build_object('superseded', v_previous) end,
    jsonb_build_object('teacher', trim(p_teacher_name),
                       'email', lower(trim(p_teacher_email)),
                       'signed_on', p_signed_on));

  return v_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- Granting or refusing a place.
--
-- Staff of the program decide, which is the point of scoping roles to
-- programs: the fair's officers do not decide who is in the class.
--
-- A refusal carries a note and a name. "Declined" with nobody attached is a
-- door closing with no way to ask why, and the student most likely to accept
-- that silently is the one this software exists for.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- WHAT GOES WRONG HERE.
--
-- A club that has run five seasons knows things nobody else can tell a
-- student: which teacher takes two weeks to sign, what the SRC sends back,
-- which measurement everybody forgets. That knowledge currently lives in the
-- head of whoever is graduating.
--
-- Written against a template step, so it surfaces where the work happens
-- rather than on a page of tips nobody opens. The universal ones are in the
-- process templates and the institution's are in its own; these are the
-- third layer, and they are the only one a school can write for itself.
--
-- Three things keep this from turning into folklore:
--
--   a name and a date, shown, because anonymous institutional advice is how
--   folklore forms;
--
--   `confirmed_at`, set at handover, so last year's warnings are re-read by
--   somebody rather than inherited;
--
--   `retired_at` rather than deletion, because a warning that stopped being
--   true is a record of something that used to be.
--
-- No cap on how many. A club has to be allowed to accumulate before anybody
-- can say what is worth keeping, and a limit set before that is a guess.
-- ---------------------------------------------------------------------------

create table public.step_warnings (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations on delete restrict,

  -- The program whose students see it. A club's warning is the club's; the
  -- class next door has its own.
  program_id  uuid not null references public.programs on delete restrict,

  -- The template step it attaches to, by id. Not a foreign key: steps come
  -- from YAML and a warning against a step that has been renamed should go
  -- quiet rather than break the page.
  step_id     text not null,

  body        text not null check (char_length(trim(body)) between 10 and 600),

  -- What made somebody write it. A specific project that hit it, kept as
  -- evidence: "this happened" is a better argument than "be careful".
  from_project uuid references public.projects on delete restrict,

  written_by  uuid not null references public.users on delete restrict,
  created_at  timestamptz not null default now(),

  -- Re-read at handover. Null means nobody has confirmed it this season.
  confirmed_at timestamptz,
  confirmed_by uuid references public.users on delete restrict,

  -- Stopped being true. Kept, not deleted.
  retired_at  timestamptz,
  retired_by  uuid references public.users on delete restrict,

  updated_at  timestamptz not null default now()
);

create index step_warnings_program on public.step_warnings (program_id, step_id)
  where retired_at is null;

alter table public.step_warnings enable row level security;

-- Everybody at the school reads them. That is the point: a warning only the
-- officers can see is a warning that has not been written.
create policy step_warnings_read on public.step_warnings
  for select to authenticated
  using (org_id = app.org_id());

-- Officers of that program write them, and the advisor. An officer of the
-- fair does not write the class's warnings.
create policy step_warnings_write on public.step_warnings
  for insert to authenticated
  with check (
    org_id = app.org_id()
    and (app.is_advisor() or app.has_role('officer', program_id))
  );

create policy step_warnings_edit on public.step_warnings
  for update to authenticated
  using (
    org_id = app.org_id()
    and (app.is_advisor() or app.has_role('officer', program_id))
  );

/* `service_role` alongside `authenticated`, which this line omitted.
 
   Every other table declared below the blanket grant at 12.14a names both;
   this one named only `authenticated`, so a script holding the secret key
   could not so much as count the rows. It surfaced as `Could not count
   step_warnings` with an empty message from a reset tool, which is a long way
   from the line that caused it.
 
   The blanket grant covers everything above it and nothing below, which the
   comment there says plainly — and a single table drifting off the pattern
   eighteen tables later is exactly the shape that warning describes.
   `tests/scripts.mjs` now refuses a table declared below the blanket grant
   that does not name `service_role`.
 
   **Still one migration.** 11.7 splits the file at the first push, and a
   deployment being tested is not that: nothing depends on this database that
   cannot be rebuilt, so there is no history worth preserving and a second
   file would only be a correction nobody needs to read. `0001` splits when
   the first real work is in it. Until then a cloud project is rebuilt rather
   than migrated, which is what `scripts/reset-cloud.mjs` prints the
   statements for. */
grant select, insert, update on public.step_warnings
  to authenticated, service_role;

/* The trigger comes from the list below rather than being written here.
   One list, so a table added without one is visible. */
do $$
begin
  execute
    'create trigger step_warnings_set_updated_at before update on public.step_warnings
       for each row execute function app.set_updated_at()';
end;
$$;

create or replace function public.decide_place(
  p_participation_id uuid,
  p_grant    boolean,
  p_note     text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org     uuid;
  v_program uuid;
  v_places  int;
  v_taken   int;
begin
  select e.org_id, e.program_id into v_org, v_program
    from public.participations e
   where e.id = p_participation_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such request at this school';
  end if;

  /* Staff of this program.
   
     `has_role` treats a role with no scope as matching any program, so a
     school-wide advisor passes here and a teacher who advises one class does
     not decide who is in the club. Which is what a school with two advisors
     wants, and the reason not to use `is_advisor()`, which ignores scope
     entirely because duty of care does. */
  if not (app.has_role('advisor', v_program) or app.has_role('officer', v_program)) then
    raise exception 'only this program''s staff may decide a place';
  end if;

  if p_grant then
    select p.places into v_places from public.programs p where p.id = v_program;

    if v_places is not null then
      select count(*) into v_taken
        from public.participations e
       where e.program_id = v_program
         and e.status in ('entered', 'competed');

      /* A warning rather than a refusal. A teacher who wants a
         twenty-first student knows something the number does not, and
         software that overrules them will simply be worked around. */
      if v_taken >= v_places then
        raise warning 'this program has % places and % are taken', v_places, v_taken;
      end if;
    end if;
  end if;

  update public.participations
     set status = case when p_grant then 'entered' else 'declined' end,
         decided_by = auth.uid(),
         decided_at = now(),
         decided_note = nullif(trim(coalesce(p_note, '')), '')
   where id = p_participation_id;

  /* Every author, because a project may have two and the one who submitted
     it is not necessarily the one who reads mail. The decider is excluded by
     `actor_id`, so a teacher who is also an author is not told about their
     own click (20.7). */
  insert into public.notifications
    (org_id, kind, recipient_id, actor_id, subject_kind, subject_id, payload, dedupe_key)
  select v_org,
         case when p_grant then 'place_granted' else 'place_declined' end,
         a.user_id, auth.uid(), 'participation', p_participation_id,
         jsonb_build_object('program_id', v_program, 'note',
           nullif(trim(coalesce(p_note, '')), '')),
         case when p_grant then 'place_granted:' else 'place_declined:' end
           || p_participation_id
    from public.participations e
    join public.project_authors a
      on a.project_id = e.project_id and a.role = 'author'
   where e.id = p_participation_id
     and a.user_id is distinct from auth.uid()
  on conflict (recipient_id, dedupe_key) do nothing;

  perform app.audit(
    v_org,
    case when p_grant then 'place.granted' else 'place.declined' end,
    'entries',
    p_participation_id,
    null,
    jsonb_build_object('note', p_note)
  );
end;
$$;

grant execute on function public.decide_place(uuid, boolean, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Assigning an officer.
--
-- An officer is a student, and runs projects of their own.
--
-- An earlier rule refused to let an author be the officer on their own
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
  p_participation_id uuid,
  p_user_id          uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org        uuid;
  v_project    uuid;
  v_program    uuid;
  v_self       boolean;
begin
  if not app.is_staff() then
    raise exception 'only an officer or the club advisor may assign an officer';
  end if;

  /* **A place, not a project.** Oversight belongs to the participation, for
     the reason a sponsor does (22.18): the class has an Elder and the club
     has an officer and they are two people. Taking a project here meant one
     assignment covered every program the project was in. */
  select pa.org_id, pa.project_id, pa.program_id
    into v_org, v_project, v_program
    from public.participations pa
   where pa.id = p_participation_id;

  if v_org is null or v_org is distinct from app.org_id() then
    raise exception 'no such place at this school';
  end if;

  /* The people who run this program, and nobody else. An officer of the fair
     has no business being made answerable for a project in a class they have
     nothing to do with; an unscoped role runs the school's research and fits
     anything. The queue already offers only these, and a rule the interface
     applies and the database does not is not a rule (19.9). */
  if not exists (
    select 1 from public.user_roles r
     where r.user_id = p_user_id
       and r.role = 'officer'
       and r.revoked_at is null
       and r.org_id = v_org
       and (r.scope_id is null or r.scope_id = v_program)
  ) and not exists (
    select 1 from public.user_roles r
     where r.user_id = p_user_id
       and r.role = 'advisor'
       and r.revoked_at is null
       and r.org_id = v_org
  ) then
    raise exception 'that person does not run this program';
  end if;

  /* An officer does not appoint the officer for their own project.
   
     Officers are assigned by other officers, and somebody who is both an
     author here and an officer of the club has an obvious interest in who
     oversees their work. Hiding the button is not enough: this is the rule,
     and the page merely reflects it.
   
     The advisor is the exception. They oversee the club rather than compete
     in it, and somebody has to be able to act when a project is stuck. */
  if (select not app.is_advisor()) and exists (
    select 1 from public.project_authors a
     where a.project_id = v_project
       and a.user_id = auth.uid()
       and a.role = 'author'
  ) then
    raise exception
      'an author does not assign the officer for their own project. Another officer or the advisor does.';
  end if;

  select exists (
    select 1 from public.project_authors a
     where a.project_id = v_project and a.user_id = p_user_id and a.role = 'author'
  ) into v_self;

  /* **An author looking after their own work is an oversight row like any
     other**, marked as self managed.

     It used to be recorded by setting a flag on the authorship row, because
     `unique (project_id, user_id)` refused the same person twice on one
     project and there was nowhere else to put it. That made self management
     project wide while every other assignment became per place — so a
     student self managing in the class was self managing at the fair too.
     The unique is now per place, so the ordinary row works and the flag says
     which kind of row it is. */
  insert into public.project_authors
    (org_id, project_id, participation_id, user_id, role, accepted_at, self_managed_at)
  values
    (v_org, v_project, p_participation_id, p_user_id, 'officer', now(),
     case when v_self then now() end)
  on conflict (participation_id, user_id) where role = 'officer' do update
    set accepted_at = now(),
        self_managed_at = case when v_self then now() end;

  perform app.sync_derived(v_project);

  perform app.audit(v_org, 'officer.assigned', 'entries', p_participation_id,
    null, jsonb_build_object('officer', p_user_id, 'self_managed', v_self));
end;
$$;

create or replace function public.detach_from_project(
  p_participation_id uuid,
  p_user_id          uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
begin
  if not app.is_staff() then
    raise exception 'only an officer or the club advisor may detach someone';
  end if;

  select pa.project_id into v_project
    from public.participations pa where pa.id = p_participation_id;

  if v_project is null then
    raise exception 'no such place';
  end if;

  /* **One place.** This took a project and removed oversight everywhere, so
     taking somebody off the club also took them off the class. The row it
     deletes now names the place, and authorship is untouched either way:
     they are still the author, they are no longer the one looking after it
     here. */
  delete from public.project_authors
   where participation_id = p_participation_id
     and user_id = p_user_id
     and role = 'officer';

  /* Reopens the obligation. A fact that stops being true has to stop
     closing the row that depends on it. */
  perform app.sync_derived(v_project);

  perform app.audit(app.org_id(), 'project.detached', 'entries', p_participation_id,
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
    join public.participations e on e.id = m.participation_id
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
  /* **Opportunities only, and the view is how that is said. 22.5.**

     One student may not enter the same fair with two projects: they would
     compete against themselves for one place, which is the rule this
     expresses and the reason the message says "in this fair".

     A class is not a fair. Somebody may be in IRPD and the club with a
     different project in each, and nothing says a class holds only one
     piece of a student's work.

     This read `entries`, which excluded cohorts by construction. Once
     `entries` and `project_cohorts` became one table the same query started
     counting IRPD as a fair -- the conflation 22.5 predicted would return
     through the data-access layer, arriving through a trigger rather than a
     page. It refused a student a second project in their own class. */
  select e.project_id
    from public.opportunity_participations e
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

drop trigger if exists entries_one_per_student on public.participations;

create trigger entries_one_per_student
  before insert on public.participations
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

  /* Through the view, for the reason given on `app.entry_conflict`: adding
     an author to a project in a class is not adding them to a fair. */
  select app.entry_conflict(e.project_id, e.program_id, new.user_id)
    into v_clash
    from public.opportunity_participations e
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
  v_gate    text;
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

  /* The program is either open to every school or belongs to this one. A null
     `org_id` is the shared row a regional fair seeds once (22.19). */
  if not exists (
    select 1 from public.programs p
     where p.id = p_program_id
       and p.status = 'open'
       and (p.org_id is null or p.org_id = v_org)
  ) then
    raise exception 'that fair is not open to this school';
  end if;

  /* Every gate, in one place, in the words the page uses. `start_entry`
     makes the project as it goes, so there is nothing yet to have advanced:
     a fair reached by advancing refuses this path by construction. */
  v_gate := app.entry_gate(p_program_id, null, v_uid);

  if v_gate is not null then
    raise exception '%', v_gate;
  end if;

  v_clash := app.entry_conflict(gen_random_uuid(), p_program_id, v_uid);

  if v_clash is not null then
    raise exception
      'you are already entered in this fair with "%". A student may enter one project per fair each season.',
      (select p.title from public.projects p where p.id = v_clash);
  end if;

  /* Coalesced rather than assumed: a program that prescribes nothing leaves
     the column default in place. */
  insert into public.projects (org_id, title, started_on, created_by, process_id)
  values (v_org, trim(p_title), p_started_on, v_uid,
          coalesce(app.process_for(p_program_id), 'process-science'))
  returning id into v_project;

  insert into public.project_authors
    (org_id, project_id, user_id, role, accepted_at)
  values (v_org, v_project, v_uid, 'author', now());

  /* **The entry is made in one place, and this is not it.**
  
     This inserted the participation and copied the milestones itself, beside
     `enter_program` doing the same job for a project that already exists.
     Two paths for one act, and they had already drifted: this copy carried
     `satisfied_by` and the shared one did not, so whether a sponsor could
     ever close an approval depended on which of the two had made the entry.
     See `app.copy_milestones` and 19.11a.
  
     So the project is made here -- that part is genuinely this function's
     own -- and entering is delegated. The gate is checked twice as a result,
     once above against no project and once inside against this one, which is
     not waste: the second is stricter, and a fair reached by advancing is
     refused there on the facts rather than by construction. */
  perform public.enter_program(v_project, p_program_id);

  select pa.id into v_entry
    from public.participations pa
   where pa.project_id = v_project and pa.program_id = p_program_id;

  perform app.audit(v_org, 'entry.created', 'entries', v_entry, null,
    jsonb_build_object('project_id', v_project, 'program_id', p_program_id));

  return v_entry;
end;
$$;

grant execute on function public.join_cohort(uuid) to authenticated;
grant execute on function public.decide_membership(uuid, boolean, text) to authenticated;
grant execute on function public.set_project_cohort(uuid, uuid, boolean) to authenticated;
grant execute on function public.start_project(text, date, uuid) to authenticated;
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

  -- Lifted out of the PDF for search. Never rendered: the extraction is rough
  -- and a reader should see the file rather than a flattened approximation.
  pdf_text      text,

  created_by    uuid not null references public.users on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Research at a glance: the four things somebody deciding whether to read
  -- further actually wants. 8.1b.
  methods       text[] not null default '{}',
  data_sources  text[] not null default '{}',
  outputs       text[] not null default '{}',

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
  using ((select app.can_see_project(manuscripts.project_id)));

create policy manuscripts_write on public.manuscripts
  for insert to authenticated
  with check ((select app.can_edit_project(manuscripts.project_id)));

create policy manuscripts_update on public.manuscripts
  for update to authenticated
  using ((select app.can_edit_project(manuscripts.project_id)));

create policy manuscript_sections_read on public.manuscript_sections
  for select to authenticated
  using ((select app.can_see_project((select m.project_id from public.manuscripts m where m.id = manuscript_sections.manuscript_id))));

create policy manuscript_sections_write on public.manuscript_sections
  for insert to authenticated
  with check ((select app.can_edit_project((select m.project_id from public.manuscripts m where m.id = manuscript_sections.manuscript_id))));

create policy manuscript_sections_update on public.manuscript_sections
  for update to authenticated
  using ((select app.can_edit_project((select m.project_id from public.manuscripts m where m.id = manuscript_sections.manuscript_id))));

create policy manuscript_figures_read on public.manuscript_figures
  for select to authenticated
  using ((select app.can_see_project((select m.project_id from public.manuscripts m where m.id = manuscript_figures.manuscript_id))));

create policy manuscript_figures_write on public.manuscript_figures
  for insert to authenticated
  with check ((select app.can_edit_project((select m.project_id from public.manuscripts m where m.id = manuscript_figures.manuscript_id))));

create policy manuscript_figures_update on public.manuscript_figures
  for update to authenticated
  using ((select app.can_edit_project((select m.project_id from public.manuscripts m where m.id = manuscript_figures.manuscript_id))));

create policy manuscript_references_read on public.manuscript_references
  for select to authenticated
  using ((select app.can_see_project((select m.project_id from public.manuscripts m where m.id = manuscript_references.manuscript_id))));

create policy manuscript_references_write on public.manuscript_references
  for insert to authenticated
  with check ((select app.can_edit_project((select m.project_id from public.manuscripts m where m.id = manuscript_references.manuscript_id))));

create policy manuscript_references_update on public.manuscript_references
  for update to authenticated
  using ((select app.can_edit_project((select m.project_id from public.manuscripts m where m.id = manuscript_references.manuscript_id))));


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
  using ((select app.can_edit_project((select m.project_id from public.manuscripts m where m.id = manuscript_references.manuscript_id))));


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
  p_participation_id    uuid,
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
  v_gate    text;
  v_project uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select e.org_id, e.project_id into v_org, v_project
    from public.participations e where e.id = p_participation_id;

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

  update public.participations
     set category    = nullif(btrim(coalesce(p_category, '')), ''),
         entry_code  = nullif(btrim(coalesce(p_entry_code, '')), ''),
         placement   = nullif(btrim(coalesce(p_placement, '')), ''),
         awards      = coalesce(p_awards, '{}'),
         advanced_to = nullif(btrim(coalesce(p_advanced_to, '')), ''),
         result_recorded_at = now(),
         result_recorded_by = v_uid
   where id = p_participation_id;

  perform app.audit(v_org, 'entry.result_recorded', 'entries', p_participation_id, null,
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
  using ((select app.can_see_project(submissions.project_id)));

create policy state_events_read on public.state_events
  for select to authenticated
  using ((select app.can_see_project((select s.project_id from public.submissions s where s.id = state_events.submission_id))));


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
  p_storage_path  text,
  p_text          text default null
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
     set pdf_path = nullif(btrim(coalesce(p_storage_path, '')), ''),
         pdf_text = nullif(btrim(coalesce(p_text, '')), '')
   where id = p_manuscript_id;
end;
$$;

drop function if exists public.set_manuscript_pdf(uuid, text);
grant execute on function public.set_manuscript_pdf(uuid, text, text) to authenticated;

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

  perform app.move_submission(p_submission_id, 'screening', 'With the editor');
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
  /* There was a 'return' outcome here. `request_revisions` now works from
     screening as well and does the same thing, with the option of a list
     attached, so this became a second route to one place. */
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

  /* The values the sentence needs, not the sentence. A rendered message
     stored now is a message composed before the facts it describes can
     change (20.2). The wording lives in src/lib/notify/platform.ts. */
  insert into public.notifications
    (org_id, kind, recipient_id, actor_id, subject_kind, subject_id, payload, dedupe_key)
  values (v_org, 'reviewer_assigned', p_reviewer_id, auth.uid(),
    'submission', p_submission_id,
    jsonb_build_object('due_at', p_due_at),
    'reviewer_assigned:' || v_id)
  on conflict (recipient_id, dedupe_key) do nothing;

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
      (org_id, kind, recipient_id, actor_id, subject_kind, subject_id, dedupe_key)
    values (v_org, 'review_returned', v_editor, auth.uid(),
      'submission', v_sub, 'review_returned:' || p_review_id)
    on conflict (recipient_id, dedupe_key) do nothing;
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

  /* Checked here rather than left to the column constraint, because the two
     buttons on that form share one set of fields and pressing the wrong one
     with an empty box should say so in words. */
  if coalesce(btrim(coalesce(p_finding, '')), '') = '' then
    raise exception 'write the change first, then add it to the list';
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
      (org_id, kind, recipient_id, actor_id, subject_kind, subject_id, payload, dedupe_key)
    values (v_org, 'revisions_requested', v_author.user_id, auth.uid(),
      'submission', p_submission_id,
      jsonb_build_object('changes', v_count),
      /* The round, so a second time round is a second message rather than
         a duplicate suppressed by the constraint. */
      'revisions_requested:' || p_submission_id || ':' || v_round)
    on conflict (recipient_id, dedupe_key) do nothing;
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

  v_label := case when p_decision = 'accepted'
                  then 'Accepted for publication'
                  else 'Not accepted' end;
  perform app.move_submission(p_submission_id, p_decision, v_label, p_note);

  for v_author in
    select a.user_id from public.project_authors a
     join public.submissions s on s.project_id = a.project_id
     where s.id = p_submission_id and a.role = 'author'
  loop
    insert into public.notifications
      (org_id, kind, recipient_id, actor_id, subject_kind, subject_id, payload, dedupe_key)
    values (v_org, 'decision_made', v_author.user_id, auth.uid(),
      'submission', p_submission_id,
      jsonb_build_object('decision', p_decision),
      'decision_made:' || p_submission_id)
    on conflict (recipient_id, dedupe_key) do nothing;
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


-- ===========================================================================
-- PUBLICATION
--
-- The archive builds from files in the repository and a prerendered route may
-- never touch the database, so publishing is an export followed by a commit,
-- and a person performs both. That is the design rather than an interim
-- measure: nothing in this path should be able to fail because a token
-- expired or an API changed under a club that has not looked at this code in
-- eight months.
--
-- Two steps, because the halves fail differently. Generating allocates an
-- identifier, which is permanent. Committing can be forgotten, botched, or
-- reverted. Collapsing them would produce records marked published that
-- resolve to nothing, which is worse than an unpublished record and invisible
-- until somebody follows a link.
-- ===========================================================================

create table public.record_sequences (
  org_id   uuid not null references public.organizations on delete restrict,
  year     int  not null,
  next_seq int  not null default 1,
  primary key (org_id, year)
);

alter table public.record_sequences enable row level security;
grant select, insert, update on public.record_sequences to authenticated, service_role;


create table public.records (
  id             text primary key,             -- MVRJ-2027-0003
  org_id         uuid not null references public.organizations on delete restrict,
  record_kind    text not null check (record_kind in ('article', 'project')),

  submission_id  uuid references public.submissions on delete restrict,
  project_id     uuid references public.projects on delete restrict,
  manuscript_id  uuid references public.manuscripts on delete restrict,

  -- Which participation this record came out of. 22.8.
  --
  -- A fair record used to name only the project, which was right while a
  -- project entered one thing. It does not: OsmoFlux went to Synopsys, MTFC
  -- and Genius Olympiad in different forms, and each is a separate outcome
  -- with its own board, its own deadlines and its own judging.
  --
  -- Advancement is the same shape: SCVSEFA then CSEF is two entries, so it
  -- is two records rather than one with a field appended.
  --
  -- Nullable, because an article's record comes from a submission and a
  -- migrated record predates entries entirely. A check below holds that a
  -- project record made from here on names one.
  participation_id       uuid references public.participations on delete restrict,

  slug           text not null,
  year           int  not null,

  title          text not null,
  abstract       text,                          -- two migrated articles have none
  keywords       text[] not null default '{}',
  discipline     text not null,
  contributions  text,

  published_on   date not null,
  date_precision text not null default 'month',

  source         text not null default 'workbench',
  reviewed       boolean not null default false,
  body_format    text not null,
  external_url   text,
  pdf_path       text,

  -- A DOI issued elsewhere, by a fair, a preprint server, or an institution.
  -- We mint none. This is a place to record one so a record that has one can
  -- be cited by it rather than by a URL that depends on us existing.
  doi            text,
  pdf_text       text,

  version        int not null default 1,
  supersedes     text references public.records on delete restrict,
  superseded_by  text references public.records on delete restrict,
  prior_venue    text,
  license        text not null,

  status         text not null default 'published'
                   check (status in ('published', 'archived', 'retracted')),
  retracted_on   date,
  retraction_reason text,

  generated_by   uuid references public.users on delete restrict,
  generated_at   timestamptz not null default now(),
  confirmed_by   uuid references public.users on delete restrict,
  confirmed_at   timestamptz,

  unique (org_id, year, slug)
);

create index records_org_idx on public.records (org_id, published_on desc);

/**
 * A record comes out of an opportunity, never out of a cohort. 22.8.
 *
 * Being in IRPD is not something a project carries afterwards; presenting at
 * the IRPD Community Showcase is, which is why the showcase is an opportunity
 * by 22.2's test and the class is not.
 *
 * Before the merge this was structural: `records.entry_id` pointed at
 * `entries`, and a cohort had no row there to point at. One table means one
 * id, so the guarantee has to be written down. This mirrors
 * `app.membership_is_cohort()` in the opposite direction.
 */
create or replace function app.record_is_opportunity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  if new.participation_id is null then
    return new;
  end if;

  select pr.program_role into v_role
    from public.participations pa
    join public.programs pr on pr.id = pa.program_id
   where pa.id = new.participation_id;

  if v_role is distinct from 'opportunity' then
    raise exception 'a record comes out of an opportunity, not out of a %',
      coalesce(v_role, 'unknown thing');
  end if;

  return new;
end;
$$;

create trigger records_opportunity_only
  before insert or update on public.records
  for each row execute function app.record_is_opportunity();


create table public.record_authors (
  record_id     text not null references public.records on delete restrict,
  display_order int  not null,

  -- Stored, never joined. A byline is a historical fact and must not change
  -- because somebody later edited their display name.
  display_name  text not null,
  user_id       uuid references public.users on delete restrict,
  school        text,
  grad_year     int,
  affiliation_verified boolean not null default false,

  -- No author page. For every co-author outside the organization, who never
  -- agreed to a permanent indexed page and has no way to control one.
  byline_only   boolean not null default false,

  primary key (record_id, display_order)
);

alter table public.records        enable row level security;
alter table public.record_authors enable row level security;

grant select, insert, update on public.records, public.record_authors
  to authenticated, service_role;
revoke delete on public.records, public.record_authors
  from authenticated, anon, service_role;

create policy records_read on public.records
  for select to authenticated using (org_id = (select app.org_id()));

create policy records_write on public.records
  for insert to authenticated
  with check (org_id = (select app.org_id()) and (select app.is_editor()));

create policy records_update on public.records
  for update to authenticated
  using (org_id = (select app.org_id()) and (select app.is_editor()));

create policy record_authors_read on public.record_authors
  for select to authenticated
  using (
    exists (select 1 from public.records r
             where r.id = record_authors.record_id
               and r.org_id = (select app.org_id()))
  );

create policy record_authors_write on public.record_authors
  for insert to authenticated with check ((select app.is_editor()));


-- ---------------------------------------------------------------------------
-- Step one: generate.
--
-- One transaction. The identifier comes from a counter rather than from a
-- count of existing rows, which produces a duplicate the first time two
-- officers publish in the same minute.
-- ---------------------------------------------------------------------------

create or replace function public.generate_record(
  p_submission_id uuid,
  p_slug          text,
  /* The prefix is a field on the organization in src/config/orgs.ts, which is
     the one place org specific strings live. Copying it into the database
     would make two, and rule 4 exists because two is how they diverge. */
  p_prefix        text,
  p_published_on  date default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_state  text;
  v_mid    uuid;
  v_pid    uuid;
  v_kind   text;
  v_year   int;
  v_seq    int;
  v_id     text;
  v_slug   text;
  v_n      int := 1;
  m        record;
  a        record;
  v_order  int := 0;
begin
  perform app.require_editor();

  select s.org_id, s.state, s.manuscript_id, s.project_id, s.record_kind
    into v_org, v_state, v_mid, v_pid, v_kind
    from public.submissions s where s.id = p_submission_id;

  if v_org is null then
    raise exception 'no such submission';
  end if;

  if v_state not in ('accepted', 'scheduled') then
    raise exception 'only an accepted submission is published';
  end if;

  if exists (select 1 from public.records r where r.submission_id = p_submission_id) then
    raise exception
      'this already has a record. Regenerating the files is safe; allocating a second identifier is not.';
  end if;

  select m2.* into m from public.manuscripts m2 where m2.id = v_mid;

  v_year := extract(year from coalesce(p_published_on, current_date));

  /* Take the number under a row lock so two officers publishing at once get
     two numbers rather than one. */
  insert into public.record_sequences (org_id, year, next_seq)
  values (v_org, v_year, 1)
  on conflict (org_id, year) do nothing;

  update public.record_sequences
     set next_seq = next_seq + 1
   where org_id = v_org and year = v_year
  returning next_seq - 1 into v_seq;

  if coalesce(btrim(coalesce(p_prefix, '')), '') = '' then
    raise exception 'no record prefix for this organization';
  end if;

  v_id := upper(btrim(p_prefix)) || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  /* The slug arrives derived. Collisions are resolved here, where the
     uniqueness lives. */
  v_slug := p_slug;
  while exists (
    select 1 from public.records r
     where r.org_id = v_org and r.year = v_year and r.slug = v_slug
  ) loop
    v_n := v_n + 1;
    v_slug := p_slug || '-' || v_n;
  end loop;

  insert into public.records (
    id, org_id, record_kind, submission_id, project_id, participation_id, manuscript_id,
    slug, year, title, abstract, keywords, discipline, contributions,
    published_on, date_precision, source, reviewed, body_format,
    external_url, pdf_path, pdf_text, license, generated_by
  ) values (
    /* An article's record comes from a submission rather than from a
       participation, so it names no entry (22.8). */
    v_id, v_org, v_kind, p_submission_id, v_pid, null, v_mid,
    v_slug, v_year, m.title, m.abstract, m.keywords,
    coalesce(m.discipline, 'unclassified'), m.contributions,
    coalesce(p_published_on, current_date), m.date_precision,
    m.source, true, m.body_format,
    m.external_url, m.pdf_path, m.pdf_text, m.license, auth.uid()
  );

  /* Freeze the byline. Display names are copied rather than referenced. */
  for a in
    select pa.user_id, u.display_name, u.grad_year, u.affiliation_state, pa.created_at
      from public.project_authors pa
      join public.users u on u.id = pa.user_id
     where pa.project_id = v_pid and pa.role = 'author'
     order by pa.created_at
  loop
    v_order := v_order + 1;
    insert into public.record_authors
      (record_id, display_order, display_name, user_id, grad_year,
       affiliation_verified, byline_only)
    values (v_id, v_order, a.display_name, a.user_id, a.grad_year,
            a.affiliation_state = 'verified', false);
  end loop;

  update public.submissions set state = 'exported' where id = p_submission_id;

  insert into public.state_events
    (org_id, submission_id, from_state, to_state, actor_id, public_label)
  values (v_org, p_submission_id, v_state, 'exported', auth.uid(), 'Being published');

  perform app.audit(v_org, 'record.generated', 'records', null, null,
    jsonb_build_object('record_id', v_id, 'slug', v_slug));

  return v_id;
end;
$$;

grant execute on function public.generate_record(uuid, text, text, date) to authenticated;


-- ---------------------------------------------------------------------------
-- Step two: confirm it is live.
--
-- After the commit and the deploy. This is what fires the notification, so
-- the authors are never told about a page that does not exist yet.
-- ---------------------------------------------------------------------------

create or replace function public.confirm_published(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org    uuid;
  v_state  text;
  v_id     text;
  v_author record;
begin
  perform app.require_editor();

  select s.org_id, s.state into v_org, v_state
    from public.submissions s where s.id = p_submission_id;

  if v_state <> 'exported' then
    raise exception 'generate the files first';
  end if;

  select r.id into v_id
    from public.records r where r.submission_id = p_submission_id;

  update public.records
     set confirmed_by = auth.uid(), confirmed_at = now()
   where submission_id = p_submission_id;

  update public.submissions set state = 'published' where id = p_submission_id;

  insert into public.state_events
    (org_id, submission_id, from_state, to_state, actor_id, public_label)
  values (v_org, p_submission_id, 'exported', 'published', auth.uid(), 'Published');

  for v_author in
    select a.user_id from public.project_authors a
     join public.submissions s on s.project_id = a.project_id
     where s.id = p_submission_id and a.role = 'author'
  loop
    insert into public.notifications
      (org_id, kind, recipient_id, actor_id, subject_kind, subject_id, payload, dedupe_key)
    values (v_org, 'record_published', v_author.user_id, auth.uid(),
      'submission', p_submission_id,
      jsonb_build_object('record_id', v_id),
      'record_published:' || v_id)
    on conflict (recipient_id, dedupe_key) do nothing;
  end loop;

  perform app.audit(v_org, 'record.published', 'records', null, null,
    jsonb_build_object('record_id', v_id));
end;
$$;

grant execute on function public.confirm_published(uuid) to authenticated;


-- A DOI usually arrives after publication, from whoever issued it, so this is
-- separate from generating the record and can be done at any time.
create or replace function public.set_record_doi(p_record_id text, p_doi text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  perform app.require_editor();

  select r.org_id into v_org from public.records r where r.id = p_record_id;
  if v_org is null then
    raise exception 'no such record';
  end if;

  update public.records
     set doi = nullif(btrim(regexp_replace(coalesce(p_doi, ''), '^https?://doi\.org/', '')), '')
   where id = p_record_id;

  perform app.audit(v_org, 'record.doi', 'records', null, null,
    jsonb_build_object('record_id', p_record_id, 'doi', p_doi));
end;
$$;

grant execute on function public.set_record_doi(text, text) to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- PROJECT ENTRIES ARE SIBLINGS OF PAPERS, NOT ALTERNATIVES TO THEM
--
-- `record_kind` was a choice on the manuscript, which quietly turned two
-- record kinds into one decision: a project could have a paper or a showcase
-- page and not both. 8.1 says otherwise and always did. Two records sharing a
-- `project_id` are companions and each page links to the other, and
-- `supersedes` is deliberately not that relationship, because it would tell a
-- reader the entry had been replaced when it had not.
--
-- So a project entry is generated from the project rather than from a
-- manuscript, and it does not pass through editorial review. **A fair result
-- is a fact to record, not a claim to review.** What review exists for it is
-- an officer verifying the result, which already happens.
--
-- Its metadata comes from the manuscript anyway, because that is where a
-- project's title, abstract, discipline, and keywords live whether or not the
-- paper was ever written or submitted. A project entry needs those four and
-- nothing else: no sections, no references, no submission.
-- ===========================================================================

create or replace function public.generate_project_record(
  p_project_id   uuid,
  p_slug         text,
  p_prefix       text,
  p_published_on date default null,
  /* Which participation this is the record of. Optional while older callers
     catch up; where it is absent the single entry with a result is used,
     which is the one project one fair case (22.8). */
  p_participation_id     uuid default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry  uuid;
  v_org    uuid;
  v_year   int;
  v_seq    int;
  v_id     text;
  v_slug   text;
  v_n      int := 1;
  m        record;
  a        record;
  v_order  int := 0;
  v_result int;
begin
  perform app.require_editor();

  select p.org_id into v_org from public.projects p where p.id = p_project_id;
  if v_org is null then
    raise exception 'no such project';
  end if;

  /* Which entry this record is of. Named, or the only one with a result.
  
     A project used to have one, so the record named the project and a second
     identifier was refused outright. It does not: one piece of work goes to
     Synopsys, MTFC and Genius Olympiad in different forms, and advancing
     from SCVSEFA to CSEF is a second entry with its own judging. Each is its
     own outcome and its own record (22.8). */
  if p_participation_id is not null then
    v_entry := p_participation_id;
  else
    select e.id into v_entry
      from public.participations e
     where e.project_id = p_project_id
       and e.result_recorded_at is not null
     order by e.result_recorded_at
     limit 1;
  end if;

  /* One record per participation, still. Regenerating the files is safe;
     allocating a second identifier for the same entry is not. */
  if exists (
    select 1 from public.records r
     where r.record_kind = 'project'
       and (
         (v_entry is not null and r.participation_id = v_entry)
         or (v_entry is null and r.project_id = p_project_id and r.participation_id is null)
       )
  ) then
    raise exception
      'that entry already has a record. Regenerating the files is safe; allocating a second identifier is not.';
  end if;

  /* Something to show. A page with no result on it is the project page with
     a permanent URL, which is not worth minting an identifier for. */
  select count(*) into v_result
    from public.participations e
   where e.project_id = p_project_id and e.result_recorded_at is not null;

  if v_result = 0 then
    raise exception
      'record a fair result first. A project entry exists to publish what happened at the fair.';
  end if;

  select m2.* into m
    from public.manuscripts m2 where m2.project_id = p_project_id;

  if m is null then
    raise exception 'this project has no record details yet';
  end if;

  if coalesce(btrim(coalesce(m.abstract, '')), '') = '' then
    raise exception
      'the abstract is empty. A project entry is mostly its abstract, so there is nothing to publish without one.';
  end if;

  if coalesce(btrim(coalesce(m.discipline, '')), '') = '' then
    raise exception 'set a discipline first';
  end if;

  v_year := extract(year from coalesce(p_published_on, current_date));

  insert into public.record_sequences (org_id, year, next_seq)
  values (v_org, v_year, 1)
  on conflict (org_id, year) do nothing;

  update public.record_sequences
     set next_seq = next_seq + 1
   where org_id = v_org and year = v_year
  returning next_seq - 1 into v_seq;

  v_id := upper(btrim(p_prefix)) || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');

  v_slug := p_slug;
  while exists (
    select 1 from public.records r
     where r.org_id = v_org and r.year = v_year and r.slug = v_slug
  ) loop
    v_n := v_n + 1;
    v_slug := p_slug || '-' || v_n;
  end loop;

  insert into public.records (
    id, org_id, record_kind, submission_id, project_id, participation_id, manuscript_id,
    slug, year, title, abstract, keywords, discipline, contributions,
    published_on, date_precision, source, reviewed, body_format,
    external_url, pdf_path, pdf_text, license, generated_by
  ) values (
    v_id, v_org, 'project', null, p_project_id, v_entry, m.id,
    v_slug, v_year, m.title, m.abstract, m.keywords,
    m.discipline, m.contributions,
    coalesce(p_published_on, current_date), 'day',
    'workbench',
    /* Not reviewed, and the page must not claim otherwise: somebody verified
       a placement and nobody read the work. */
    false,
    'none',
    null, null, null, m.license, auth.uid()
  );

  for a in
    select pa.user_id, u.display_name, u.grad_year, u.affiliation_state, pa.created_at
      from public.project_authors pa
      join public.users u on u.id = pa.user_id
     where pa.project_id = p_project_id and pa.role = 'author'
     order by pa.created_at
  loop
    v_order := v_order + 1;
    insert into public.record_authors
      (record_id, display_order, display_name, user_id, grad_year,
       affiliation_verified, byline_only)
    values (v_id, v_order, a.display_name, a.user_id, a.grad_year,
            a.affiliation_state = 'verified', false);
  end loop;

  perform app.audit(v_org, 'record.generated', 'records', null, null,
    jsonb_build_object('record_id', v_id, 'kind', 'project'));

  return v_id;
end;
$$;

grant execute on function public.generate_project_record(uuid, text, text, date, uuid) to authenticated;

/* The manuscript is the paper. It was carrying a kind, which is a property of
   a record rather than of the writing. */

notify pgrst, 'reload schema';


-- A project entry has no submission, so `confirm_published` cannot mark it
-- live: that function moves a submission through its states and notifies from
-- them. There is also no ceremony to observe here. Nobody is waiting on a
-- decision, so writing the files and marking it live are one act.
create or replace function public.mark_record_live(p_record_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  perform app.require_editor();

  select r.org_id into v_org from public.records r where r.id = p_record_id;
  if v_org is null then
    raise exception 'no such record';
  end if;

  update public.records
     set confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_record_id;

  perform app.audit(v_org, 'record.published', 'records', null, null,
    jsonb_build_object('record_id', p_record_id));
end;
$$;

grant execute on function public.mark_record_live(text) to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- WHAT A RECORD PAGE NEEDS AND THE WORKING SURFACE NEVER ASKED FOR
--
-- A published page that opens with a title and an abstract is a page a reader
-- has to work at. The question the project asked, the methods it used, where
-- the data came from, and what it produced are the four things somebody
-- deciding whether to read further actually wants, and three of them had
-- nowhere to live.
--
-- The fourth, `projects.question`, has existed since the first migration and
-- was editable on no screen and rendered on no page. A column nobody can fill
-- is the same as a column that is not there.
-- ===========================================================================


create or replace function public.save_project_question(
  p_project_id uuid,
  p_question   text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select p.org_id into v_org from public.projects p where p.id = p_project_id;
  if v_org is null then
    raise exception 'no such project';
  end if;

  perform app.require_author(p_project_id);

  update public.projects
     set question = nullif(btrim(coalesce(p_question, '')), ''),
         updated_at = now()
   where id = p_project_id;
end;
$$;

grant execute on function public.save_project_question(uuid, text) to authenticated;

notify pgrst, 'reload schema';


-- Saving the three list fields. A separate function rather than three more
-- arguments on `save_manuscript`, which already takes thirteen and is called
-- from a form that does not touch these.
create or replace function public.save_at_a_glance(
  p_manuscript_id uuid,
  p_methods       text[],
  p_data_sources  text[],
  p_outputs       text[]
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
     set methods      = coalesce(p_methods, '{}'),
         data_sources = coalesce(p_data_sources, '{}'),
         outputs      = coalesce(p_outputs, '{}'),
         updated_at   = now()
   where id = p_manuscript_id;
end;
$$;

grant execute on function public.save_at_a_glance(uuid, text[], text[], text[]) to authenticated;

notify pgrst, 'reload schema';


-- ===========================================================================
-- SHOWCASE IMAGES AND ONE VIDEO
--
-- A figure is evidence: numbered, captioned, referred to from the text. A
-- showcase image is not. It is the apparatus on a bench, the board at the
-- fair, the organism being measured, and it exists so somebody arriving at
-- the page can see what the work looked like before reading a word of it.
--
-- Separate from `manuscript_figures` deliberately. Conflating them would put
-- a photograph of a workbench into the numbered figure sequence of a paper,
-- and there is no caption that makes "Figure 3" mean both things.
--
-- Four, because a cap forces a choice. A gallery of twenty photographs is a
-- scroll, and the point of these is the first impression.
-- ===========================================================================

create table public.project_images (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations on delete restrict,
  project_id   uuid not null references public.projects on delete restrict,

  position     int  not null check (position between 1 and 4),
  storage_path text not null,

  -- Both required, as everywhere else images appear here. An image with no
  -- alt text is invisible to part of the audience, and a published page is
  -- permanent.
  alt          text not null check (length(btrim(alt)) > 0),
  caption      text not null check (length(btrim(caption)) > 0),

  uploaded_by  uuid not null references public.users on delete restrict,
  created_at   timestamptz not null default now(),
  withdrawn_at timestamptz,

  unique (project_id, position) deferrable initially deferred
);

create index project_images_project_idx
  on public.project_images (project_id, position) where withdrawn_at is null;

alter table public.project_images enable row level security;
grant select, insert, update on public.project_images to authenticated, service_role;

create policy project_images_read on public.project_images
  for select to authenticated
  using ((select app.can_see_project(project_images.project_id)));

create policy project_images_write on public.project_images
  for insert to authenticated
  with check ((select app.can_edit_project(project_images.project_id)));

create policy project_images_update on public.project_images
  for update to authenticated
  using ((select app.can_edit_project(project_images.project_id)));


-- One video, held as a string and never fetched by us. 7.4's rule, and the
-- reason it is one field rather than a list: a page with four videos on it is
-- a channel, and nobody watches the fourth.


create or replace function public.add_project_image(
  p_project_id   uuid,
  p_storage_path text,
  p_alt          text,
  p_caption      text
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org  uuid;
  v_next int;
begin
  perform app.require_author(p_project_id);

  select p.org_id into v_org from public.projects p where p.id = p_project_id;

  select coalesce(max(i.position), 0) + 1 into v_next
    from public.project_images i
   where i.project_id = p_project_id and i.withdrawn_at is null;

  if v_next > 4 then
    raise exception
      'four is the limit. Remove one first: a gallery of twenty is a scroll, and these exist to be the first thing somebody sees.';
  end if;

  if coalesce(btrim(coalesce(p_alt, '')), '') = '' then
    raise exception 'describe the image for somebody who cannot see it';
  end if;

  if coalesce(btrim(coalesce(p_caption, '')), '') = '' then
    raise exception 'say what the image shows';
  end if;

  insert into public.project_images
    (org_id, project_id, position, storage_path, alt, caption, uploaded_by)
  values (v_org, p_project_id, v_next, p_storage_path, btrim(p_alt), btrim(p_caption), auth.uid());

  return v_next;
end;
$$;

grant execute on function public.add_project_image(uuid, text, text, text) to authenticated;


create or replace function public.remove_project_image(p_image_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  r         record;
  v_n       int := 0;
begin
  select i.project_id into v_project
    from public.project_images i where i.id = p_image_id;

  if v_project is null then
    raise exception 'no such image';
  end if;

  perform app.require_author(v_project);

  update public.project_images set withdrawn_at = now() where id = p_image_id;

  /* Renumber, in two passes, because the unique index would collide halfway
     through a single one. Same shape as the figure renumbering. */
  for r in
    select i.id from public.project_images i
     where i.project_id = v_project and i.withdrawn_at is null
     order by i.position
  loop
    v_n := v_n + 1;
    update public.project_images set position = -v_n where id = r.id;
  end loop;

  update public.project_images
     set position = -position
   where project_id = v_project and position < 0;
end;
$$;

grant execute on function public.remove_project_image(uuid) to authenticated;


create or replace function public.save_project_video(p_project_id uuid, p_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  perform app.require_author(p_project_id);

  v_url := nullif(btrim(coalesce(p_url, '')), '');

  /* An allowlist rather than validation. We render this inside a frame, so
     the set of hosts we will frame has to be closed: anything else is an
     arbitrary page of somebody else's choosing embedded in ours. */
  if v_url is not null and v_url !~* '^https://(www\.)?(youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|vimeo\.com/)[A-Za-z0-9_\-/?=&.]+$' then
    raise exception 'YouTube and Vimeo only, and the address has to start with https';
  end if;

  update public.projects
     set video_url = v_url, updated_at = now()
   where id = p_project_id;
end;
$$;

grant execute on function public.save_project_video(uuid, text) to authenticated;

notify pgrst, 'reload schema';





notify pgrst, 'reload schema';
