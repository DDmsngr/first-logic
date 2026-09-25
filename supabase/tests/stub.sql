-- Заглушки того, что в Supabase есть «из коробки», а в голом Postgres нет.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema extensions;
create extension if not exists pgcrypto with schema extensions;

create schema auth;
create table auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text unique, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now(),
  confirmation_token text, recovery_token text, email_change text, email_change_token_new text
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;

create schema cron;
create function cron.schedule(p_name text, p_sched text, p_cmd text) returns bigint language sql as $$ select 1::bigint $$;

create type extensions.http_response as (status int, content_type text, headers jsonb, content text);
create function extensions.http_get(uri text) returns extensions.http_response language plpgsql as $$
begin raise exception 'нет сети в тестовом стенде'; end $$;

create publication supabase_realtime;
