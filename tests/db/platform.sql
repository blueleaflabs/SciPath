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
