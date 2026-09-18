begin;

create table public.google_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  google_email text not null,
  calendar_id text not null default 'primary',
  encrypted_refresh_token text not null,
  token_key_version integer not null default 1 check (token_key_version > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint google_connections_email_not_blank check (btrim(google_email) <> ''),
  constraint google_connections_token_not_blank check (btrim(encrypted_refresh_token) <> '')
);

alter table public.google_connections enable row level security;

create policy profiles_insert_self
on public.profiles for insert
to authenticated
with check (id = (select auth.uid()));

create policy profiles_update_self
on public.profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy google_connections_select_self
on public.google_connections for select
to authenticated
using (user_id = (select auth.uid()));

create policy google_connections_insert_self
on public.google_connections for insert
to authenticated
with check (user_id = (select auth.uid()));

create policy google_connections_update_self
on public.google_connections for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

revoke all on public.google_connections from anon;
grant select, insert, update on public.google_connections to authenticated;
grant insert, update on public.profiles to authenticated;

commit;
