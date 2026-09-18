begin;

create type public.calendar_watch_status as enum ('ACTIVE', 'REPLACED', 'STOPPED', 'EXPIRED', 'ERROR');
create type public.meeting_type as enum ('E1', 'E2', 'HD', 'OTHER');
create type public.meeting_status as enum (
  'DETECTED',
  'PREPARING',
  'READY',
  'NEEDS_REVIEW',
  'FAILED',
  'LIVE',
  'COMPLETED',
  'CANCELLED'
);
create type public.job_type as enum ('CALENDAR_SYNC', 'MEETING_PREPARATION', 'WATCH_RENEWAL');
create type public.job_status as enum ('PENDING', 'RUNNING', 'DONE', 'FAILED');

create table public.calendar_watch_channels (
  id uuid primary key default gen_random_uuid(),
  google_connection_id uuid not null references public.google_connections(id) on delete cascade,
  channel_id text not null unique,
  resource_id text not null,
  token_hash text not null,
  sync_token text,
  expiration_at timestamptz not null,
  status public.calendar_watch_status not null default 'ACTIVE',
  last_message_number bigint,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_watch_channel_id_not_blank check (btrim(channel_id) <> ''),
  constraint calendar_watch_resource_id_not_blank check (btrim(resource_id) <> ''),
  constraint calendar_watch_token_hash_sha256 check (token_hash ~ '^[0-9a-f]{64}$')
);

create index calendar_watch_channels_connection_status_idx
  on public.calendar_watch_channels (google_connection_id, status, expiration_at desc);

create table public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  google_connection_id uuid not null references public.google_connections(id) on delete cascade,
  google_event_id text not null,
  ical_uid text,
  etag text,
  title text not null default '',
  description text,
  location text,
  start_at timestamptz,
  end_at timestamptz,
  is_all_day boolean not null default false,
  event_status text not null default 'confirmed',
  organizer_email text,
  html_link text,
  conference_url text,
  raw_payload jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint calendar_events_google_event_id_not_blank check (btrim(google_event_id) <> ''),
  constraint calendar_events_status_allowed check (event_status in ('confirmed', 'tentative', 'cancelled')),
  unique (google_connection_id, google_event_id)
);

create index calendar_events_connection_start_idx
  on public.calendar_events (google_connection_id, start_at);
create index calendar_events_source_updated_idx
  on public.calendar_events (source_updated_at);

create table public.clinics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  normalized_name text,
  website_url text,
  phone text,
  email text,
  address text,
  doctor_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clinics_name_not_blank check (btrim(name) <> '')
);

create index clinics_organization_name_idx
  on public.clinics (organization_id, name);

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid references public.clinics(id) on delete set null,
  calendar_event_id uuid not null unique references public.calendar_events(id) on delete cascade,
  fs_user_id uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  meeting_type public.meeting_type not null,
  status public.meeting_status not null default 'DETECTED',
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  source text not null default 'GOOGLE_CALENDAR',
  detection_rule text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meetings_source_not_blank check (btrim(source) <> '')
);

create index meetings_org_start_idx
  on public.meetings (organization_id, scheduled_start_at);
create index meetings_user_start_idx
  on public.meetings (fs_user_id, scheduled_start_at);
create index meetings_status_idx
  on public.meetings (status);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  job_type public.job_type not null,
  google_connection_id uuid references public.google_connections(id) on delete cascade,
  meeting_id uuid references public.meetings(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text unique,
  status public.job_status not null default 'PENDING',
  attempts integer not null default 0 check (attempts >= 0),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  last_error_safe text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jobs_due_idx
  on public.jobs (status, run_after)
  where status = 'PENDING';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger google_connections_set_updated_at
before update on public.google_connections
for each row execute function public.set_updated_at();

create trigger calendar_watch_channels_set_updated_at
before update on public.calendar_watch_channels
for each row execute function public.set_updated_at();

create trigger calendar_events_set_updated_at
before update on public.calendar_events
for each row execute function public.set_updated_at();

create trigger clinics_set_updated_at
before update on public.clinics
for each row execute function public.set_updated_at();

create trigger meetings_set_updated_at
before update on public.meetings
for each row execute function public.set_updated_at();

create trigger jobs_set_updated_at
before update on public.jobs
for each row execute function public.set_updated_at();

create or replace function app_private.can_access_fs_user(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (
      select 1
      from public.organization_memberships actor
      join public.organization_memberships target
        on target.organization_id = actor.organization_id
       and target.user_id = target_user_id
       and target.department = 'FIRST_DIVISION'::public.organization_department
       and target.team = 'FS'::public.organization_team
       and target.is_active
      where actor.user_id = (select auth.uid())
        and actor.department = 'FIRST_DIVISION'::public.organization_department
        and actor.team = 'FS'::public.organization_team
        and actor.is_active
        and (
          actor.user_id = target_user_id
          or actor.role = any(array['ADMIN','FS_MANAGER']::public.organization_role[])
        )
    );
$$;

revoke all on function app_private.can_access_fs_user(uuid) from public;
grant execute on function app_private.can_access_fs_user(uuid) to authenticated;

alter table public.calendar_watch_channels enable row level security;
alter table public.calendar_events enable row level security;
alter table public.clinics enable row level security;
alter table public.meetings enable row level security;
alter table public.jobs enable row level security;

create policy google_connections_select_admin_same_organization
on public.google_connections for select
to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1
    from public.organization_memberships actor
    join public.organization_memberships target
      on target.organization_id = actor.organization_id
     and target.user_id = google_connections.user_id
     and target.is_active
    where actor.user_id = (select auth.uid())
      and actor.is_active
      and actor.department = 'FIRST_DIVISION'::public.organization_department
      and actor.team = 'FS'::public.organization_team
      and actor.role = 'ADMIN'::public.organization_role
  )
);

create policy calendar_watch_channels_select_authorized
on public.calendar_watch_channels for select
to authenticated
using (
  exists (
    select 1
    from public.google_connections connection
    where connection.id = calendar_watch_channels.google_connection_id
      and app_private.can_access_fs_user(connection.user_id)
  )
);

create policy calendar_events_select_authorized
on public.calendar_events for select
to authenticated
using (
  exists (
    select 1
    from public.google_connections connection
    where connection.id = calendar_events.google_connection_id
      and app_private.can_access_fs_user(connection.user_id)
  )
);

create policy clinics_select_same_organization
on public.clinics for select
to authenticated
using (
  exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = clinics.organization_id
      and membership.user_id = (select auth.uid())
      and membership.is_active
  )
);

create policy meetings_select_authorized
on public.meetings for select
to authenticated
using (
  app_private.can_access_fs_user(fs_user_id)
);

revoke all on public.calendar_watch_channels from anon;
revoke all on public.calendar_events from anon;
revoke all on public.clinics from anon;
revoke all on public.meetings from anon;
revoke all on public.jobs from anon;

grant select on public.calendar_watch_channels to authenticated;
grant select on public.calendar_events to authenticated;
grant select on public.clinics to authenticated;
grant select on public.meetings to authenticated;

revoke all on public.jobs from authenticated;

commit;
