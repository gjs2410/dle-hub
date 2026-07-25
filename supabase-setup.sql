-- DLE Hub — cloud sync schema.
-- Paste this into your Supabase dashboard → SQL Editor → New query → Run.
--
-- Creates one row per user holding their favorites + completion history, locked
-- down with Row-Level Security so each person can only read/write their own row.

create table if not exists public.user_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  favorites  jsonb not null default '[]'::jsonb,
  history    jsonb not null default '{}'::jsonb,
  fails      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- If you created the table before the "failed games" feature, add the column:
alter table public.user_state add column if not exists fails jsonb not null default '{}'::jsonb;

alter table public.user_state enable row level security;

drop policy if exists "read own state"   on public.user_state;
drop policy if exists "insert own state" on public.user_state;
drop policy if exists "update own state" on public.user_state;

create policy "read own state"   on public.user_state
  for select using (auth.uid() = user_id);
create policy "insert own state" on public.user_state
  for insert with check (auth.uid() = user_id);
create policy "update own state" on public.user_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
