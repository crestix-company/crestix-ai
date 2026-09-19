
begin;

create table public.skills (
  id text primary key,
  name text not null,
  file_path text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint skills_name_not_blank check (btrim(name) <> ''),
  constraint skills_file_path_not_blank check (btrim(file_path) <> '')
);

create table public.skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id text not null references public.skills(id) on delete restrict,
  version_label text not null,
  sha256 text not null,
  content text not null,
  created_at timestamptz not null default now(),
  constraint skill_versions_version_not_blank check (btrim(version_label) <> ''),
  constraint skill_versions_sha256_format check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint skill_versions_content_not_blank check (btrim(content) <> ''),
  unique (skill_id, sha256)
);

create table public.meeting_preparations (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null unique references public.meetings(id) on delete cascade,
  skill_version_id uuid references public.skill_versions(id) on delete restrict,
  status text not null default 'PENDING',
  facts jsonb not null default '[]'::jsonb,
  hypotheses jsonb not null default '[]'::jsonb,
  needs_confirmation jsonb not null default '[]'::jsonb,
  clinic_summary text,
  current_measures jsonb not null default '[]'::jsonb,
  medical_services jsonb not null default '[]'::jsonb,
  doctor jsonb not null default '{}'::jsonb,
  area jsonb not null default '{}'::jsonb,
  competitors jsonb not null default '[]'::jsonb,
  seo jsonb not null default '{}'::jsonb,
  meo jsonb not null default '{}'::jsonb,
  portals jsonb not null default '[]'::jsonb,
  sales_hypotheses jsonb not null default '[]'::jsonb,
  proposal_candidates jsonb not null default '[]'::jsonb,
  objections jsonb not null default '[]'::jsonb,
  recommended_responses jsonb not null default '[]'::jsonb,
  must_ask jsonb not null default '[]'::jsonb,
  withdrawal_conditions jsonb not null default '[]'::jsonb,
  key_points jsonb not null default '[]'::jsonb,
  talk_script_markdown text,
  sources jsonb not null default '[]'::jsonb,
  attempt_count integer not null default 0,
  error_safe text,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_preparations_status_check check (status in ('PENDING','PREPARING','READY','NEEDS_REVIEW','FAILED')),
  constraint meeting_preparations_attempt_count_check check (attempt_count >= 0)
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  skill_version_id uuid references public.skill_versions(id) on delete restrict,
  mode text not null default 'PREPARATION',
  provider text not null,
  model text not null,
  status text not null default 'RUNNING',
  input_meta jsonb not null default '{}'::jsonb,
  output_meta jsonb not null default '{}'::jsonb,
  input_tokens integer,
  output_tokens integer,
  error_safe text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint agent_runs_mode_check check (mode in ('PREPARATION')),
  constraint agent_runs_status_check check (status in ('RUNNING','DONE','FAILED')),
  constraint agent_runs_provider_not_blank check (btrim(provider) <> ''),
  constraint agent_runs_model_not_blank check (btrim(model) <> '')
);

create index skill_versions_skill_created_idx on public.skill_versions (skill_id, created_at desc);
create index meeting_preparations_status_idx on public.meeting_preparations (status, updated_at desc);
create index agent_runs_meeting_created_idx on public.agent_runs (meeting_id, created_at desc);

alter table public.skills enable row level security;
alter table public.skill_versions enable row level security;
alter table public.meeting_preparations enable row level security;
alter table public.agent_runs enable row level security;

revoke all on public.skills from anon, authenticated;
revoke all on public.skill_versions from anon, authenticated;
revoke all on public.agent_runs from anon, authenticated;
revoke all on public.meeting_preparations from anon;
revoke all on public.meeting_preparations from authenticated;
grant select on public.meeting_preparations to authenticated;

create policy meeting_preparations_select_visible_meeting
on public.meeting_preparations for select
to authenticated
using (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_preparations.meeting_id
  )
);

commit;
