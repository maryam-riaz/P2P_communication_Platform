-- =============================================================
-- SOSIFY — Supabase Postgres Migration 001: Initial Schema
-- Apply this via Supabase SQL Editor or a migration tool.
-- =============================================================

-- 0. Extensions
create extension if not exists "pgcrypto";

-- 1. Custom types
create type public.user_role as enum ('user', 'rescuer', 'admin');
create type public.message_type as enum ('text', 'image', 'video_chunk', 'audio', 'sos', 'role_credential');
create type public.message_status as enum ('pending', 'sent', 'received', 'read');
create type public.sos_severity as enum ('low', 'medium', 'high', 'critical');
create type public.sos_status as enum ('open', 'acknowledged', 'resolved');
create type public.sync_operation as enum ('create', 'update', 'delete');
create type public.sync_status as enum ('pending', 'syncing', 'synced', 'failed');

-- 2. Profiles (extends Supabase auth.users)
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null default '',
  role          public.user_role not null default 'user',
  public_key    text not null default '',
  public_key_hash text not null default '',
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 3. Messages
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  sender_id       uuid not null references public.profiles(id),
  receiver_id     uuid references public.profiles(id),
  conversation_id uuid not null,
  type            public.message_type not null,
  payload         text not null,
  nonce           text,
  ttl             int not null default 10,
  status          public.message_status not null default 'pending',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- 4. SOS Reports
create table public.sos_reports (
  id          uuid primary key default gen_random_uuid(),
  sender_id   uuid not null references public.profiles(id),
  title       text not null,
  description text not null default '',
  latitude    double precision,
  longitude   double precision,
  severity    public.sos_severity not null default 'high',
  status      public.sos_status not null default 'open',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 5. Media Chunks (polymorphic reference to any parent record)
create table public.media_chunks (
  id          uuid primary key default gen_random_uuid(),
  record_id   uuid not null,
  record_type text not null check (record_type in ('message', 'sos_report')),
  chunk_index int not null,
  chunk_total int not null,
  data        text not null,
  nonce       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 6. Sync Outbox (tracks which local records need cloud sync)
create table public.sync_outbox (
  id          uuid primary key default gen_random_uuid(),
  record_id   uuid not null,
  record_type text not null,
  operation   public.sync_operation not null,
  status      public.sync_status not null default 'pending',
  retry_count int not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 7. Indexes
create index idx_messages_conversation on public.messages(conversation_id);
create index idx_messages_sender on public.messages(sender_id);
create index idx_messages_receiver on public.messages(receiver_id);
create index idx_sos_reports_sender on public.sos_reports(sender_id);
create index idx_sos_reports_status on public.sos_reports(status);
create index idx_media_chunks_record on public.media_chunks(record_id, record_type);
create index idx_sync_outbox_status on public.sync_outbox(status);

-- 8. Row Level Security
alter table public.profiles enable row level security;
alter table public.messages enable row level security;
alter table public.sos_reports enable row level security;
alter table public.media_chunks enable row level security;
alter table public.sync_outbox enable row level security;

-- Profiles: users can read all profiles, update only their own
create policy "profiles_select_authenticated"
  on public.profiles for select
  using (auth.role() = 'authenticated');

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

-- Messages: participants can read; sender can insert
create policy "messages_select_participant"
  on public.messages for select
  using (auth.uid() = sender_id or auth.uid() = receiver_id or receiver_id is null);

create policy "messages_insert_own"
  on public.messages for insert
  with check (auth.uid() = sender_id);

-- SOS reports: rescuer and admin can read all; any authenticated can insert
create policy "sos_reports_select_rescuer_admin"
  on public.sos_reports for select
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('rescuer', 'admin')
    )
  );

create policy "sos_reports_insert_own"
  on public.sos_reports for insert
  with check (auth.uid() = sender_id);

create policy "sos_reports_update_rescuer_admin"
  on public.sos_reports for update
  using (
    exists (
      select 1 from public.profiles
      where id = auth.uid() and role in ('rescuer', 'admin')
    )
  );

-- 9. Storage buckets (created via Supabase dashboard / API)
-- Buckets: sos-media (public read for authenticated, insert own)
--          user-avatars (public read, update own)

-- Trigger for updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger set_messages_updated_at
  before update on public.messages
  for each row execute function public.set_updated_at();

create trigger set_sos_reports_updated_at
  before update on public.sos_reports
  for each row execute function public.set_updated_at();

create trigger set_media_chunks_updated_at
  before update on public.media_chunks
  for each row execute function public.set_updated_at();

create trigger set_sync_outbox_updated_at
  before update on public.sync_outbox
  for each row execute function public.set_updated_at();

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''), 'user');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
