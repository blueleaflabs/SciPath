-- ===========================================================================
-- WHAT THE PLATFORM PROVIDES.
--
-- Supabase creates these before any migration runs: the roles PostgREST
-- switches into, the `auth` schema, and `auth.uid()`, which every policy in
-- the migration depends on.
--
-- This is the smallest thing that lets the migration run and the policies
-- mean what they mean. It is not a reimplementation of Supabase and must not
-- become one: anything the migration does not touch does not belong here.
-- ===========================================================================

-- What the Supabase platform provides before any migration runs. Enough to
-- exercise the migration, not a reimplementation of Supabase.
drop role if exists anon;
create role anon nologin noinherit;
drop role if exists authenticated;
create role authenticated nologin noinherit;
drop role if exists service_role;
create role service_role nologin noinherit bypassrls;
drop role if exists supabase_auth_admin;
create role supabase_auth_admin nologin noinherit createrole;
drop role if exists authenticator;
create role authenticator noinherit login password 'x';
grant anon, authenticated, service_role to authenticator;

create extension if not exists pgcrypto;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create or replace function auth.uid() returns uuid
  language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;

create or replace function auth.role() returns text
  language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

-- Realtime (2.8). The platform's broadcast table, the function a trigger
-- sends through, and the one a policy reads the topic from. Enough for
-- the migration's policies and triggers to run and to be asserted
-- against; the real service partitions the table and delivers the rows.
create schema if not exists realtime;
grant usage on schema realtime to anon, authenticated, service_role;

create table realtime.messages (
  id          uuid primary key default gen_random_uuid(),
  topic       text not null,
  extension   text not null,
  payload     jsonb,
  event       text,
  private     boolean default false,
  inserted_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to authenticated;

create or replace function realtime.topic() returns text
  language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;

create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
returns void
language plpgsql
as $$
begin
  insert into realtime.messages (topic, extension, payload, event, private)
  values (topic, 'broadcast', payload, event, private);
end;
$$;
