begin;

-- Explicit Degraded Research Mode: Free Tier Gemini 3.x cannot use Google
-- Search Grounding for this account (confirmed live: 429 RESOURCE_EXHAUSTED
-- on the grounding-capable model). Rather than silently treating an
-- ungrounded generation as if it were verified web research, the
-- Research Agent now records which mode actually produced this result.
alter table public.meeting_preparations
  add column if not exists research_mode text,
  add column if not exists grounding_status text,
  add column if not exists research_model text,
  add column if not exists grounding_error_safe text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'meeting_preparations_research_mode_check'
  ) then
    alter table public.meeting_preparations
      add constraint meeting_preparations_research_mode_check
      check (research_mode is null or research_mode in ('GROUNDED', 'DEGRADED'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'meeting_preparations_grounding_status_check'
  ) then
    alter table public.meeting_preparations
      add constraint meeting_preparations_grounding_status_check
      check (grounding_status is null or grounding_status in ('SUCCESS', 'UNAVAILABLE', 'FAILED'));
  end if;
end $$;

commit;
