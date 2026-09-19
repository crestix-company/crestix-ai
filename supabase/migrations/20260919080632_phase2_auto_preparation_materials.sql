
begin;

create table if not exists public.user_feature_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  feature_key text not null,
  enabled boolean not null default false,
  automation_start_at timestamptz,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_feature_flags_feature_key_not_blank check (btrim(feature_key) <> ''),
  unique (user_id, feature_key)
);

alter table public.user_feature_flags enable row level security;
revoke all on public.user_feature_flags from anon, authenticated;

alter table public.meeting_preparations
  add column if not exists source_mode text not null default 'MANUAL',
  add column if not exists research_summary text,
  add column if not exists research_sources jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'meeting_preparations_source_mode_check'
  ) then
    alter table public.meeting_preparations
      add constraint meeting_preparations_source_mode_check
      check (source_mode in ('MANUAL','GEMINI_AUTO'));
  end if;
end $$;

alter table public.agent_runs
  add column if not exists initiated_by_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists search_call_count integer,
  add column if not exists estimated_cost_usd numeric(12,6),
  add column if not exists trigger_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_runs_search_call_count_check'
  ) then
    alter table public.agent_runs
      add constraint agent_runs_search_call_count_check
      check (search_call_count is null or search_call_count >= 0);
  end if;
end $$;

create table if not exists public.meeting_materials (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null unique references public.meetings(id) on delete cascade,
  preparation_id uuid references public.meeting_preparations(id) on delete cascade,
  status text not null default 'PENDING',
  title text,
  executive_summary text,
  slides jsonb not null default '[]'::jsonb,
  document_markdown text,
  google_slides_id text,
  google_slides_url text,
  generated_at timestamptz,
  error_safe text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_materials_status_check check (status in ('PENDING','GENERATING','READY','FAILED'))
);

create index if not exists user_feature_flags_user_feature_idx
  on public.user_feature_flags (user_id, feature_key);

create index if not exists agent_runs_initiated_by_user_idx
  on public.agent_runs (initiated_by_user_id);

create index if not exists meeting_materials_preparation_idx
  on public.meeting_materials (preparation_id);

alter table public.meeting_materials enable row level security;
revoke all on public.meeting_materials from anon;
revoke all on public.meeting_materials from authenticated;
grant select on public.meeting_materials to authenticated;

drop policy if exists meeting_materials_select_visible_meeting on public.meeting_materials;
create policy meeting_materials_select_visible_meeting
on public.meeting_materials for select
to authenticated
using (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_materials.meeting_id
  )
);

insert into public.user_feature_flags (
  user_id,
  feature_key,
  enabled,
  automation_start_at,
  config,
  updated_at
)
values (
  'c839d55a-85fa-4f8b-b48d-1ee11ceb4663',
  'FS_AUTO_PREPARATION',
  true,
  timestamptz '2026-09-19 00:00:00+09',
  '{"provider":"gemini","model":"gemini-2.5-flash","generate_materials":true}'::jsonb,
  now()
)
on conflict (user_id, feature_key)
do update set
  enabled = excluded.enabled,
  automation_start_at = excluded.automation_start_at,
  config = excluded.config,
  updated_at = now();

commit;
