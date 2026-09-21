begin;

-- Medical FS MVP scope: clinic_name (normalized display name extracted
-- from the Calendar title) and is_handoff (structured IS handoff notes
-- parsed from the Calendar description - see lib/preparation/is-handoff.ts)
-- persisted per meeting for reuse across Research/Preparation/UI without
-- re-parsing the raw Calendar description every time.
alter table public.meetings
  add column if not exists clinic_name text,
  add column if not exists is_handoff jsonb;

-- E1 Preparation output additions: 想定OUT (assumed_outs), E2進行条件
-- (e2_conditions), and a short meeting-day headline (today_conclusion) -
-- see lib/preparation/schema.ts's PreparationResultSchema. All optional /
-- defaulted so the existing manual ChatGPT-paste fallback (whose output
-- may not include these newer fields) still validates.
alter table public.meeting_preparations
  add column if not exists assumed_outs jsonb not null default '[]'::jsonb,
  add column if not exists e2_conditions jsonb not null default '[]'::jsonb,
  add column if not exists today_conclusion text;

-- Live Assist Lite (section 13/14 of the FS scope spec): lets an FS user
-- record which of the predicted assumed_outs (or a free-text one) actually
-- came up during the live meeting, and what response they used - without
-- needing full real-time transcript/STT analysis yet.
create table if not exists public.meeting_out_actuals (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  actual_out text not null,
  occurred_at timestamptz not null default now(),
  response_used text,
  resolved boolean not null default false,
  memo text,
  created_by_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_out_actuals_actual_out_not_blank check (btrim(actual_out) <> '')
);

create index if not exists meeting_out_actuals_meeting_idx
  on public.meeting_out_actuals (meeting_id, occurred_at);

alter table public.meeting_out_actuals enable row level security;
revoke all on public.meeting_out_actuals from anon;
revoke all on public.meeting_out_actuals from authenticated;
grant select on public.meeting_out_actuals to authenticated;

drop policy if exists meeting_out_actuals_select_visible_meeting on public.meeting_out_actuals;
create policy meeting_out_actuals_select_visible_meeting
on public.meeting_out_actuals for select
to authenticated
using (
  exists (
    select 1
    from public.meetings m
    where m.id = meeting_out_actuals.meeting_id
  )
);

commit;
