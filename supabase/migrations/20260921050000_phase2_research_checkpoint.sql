begin;

-- Stage checkpointing: a successful Research stage must survive a later
-- Preparation-stage failure so a retry doesn't re-run (and re-bill) Research
-- from scratch. research_status is tracked independently from the row's
-- overall `status` (PREPARING/READY/FAILED), which reflects the Preparation
-- stage. research_source_updated_at pins the checkpoint to the exact
-- calendar_events.source_updated_at it was computed against, so an edited
-- Calendar event correctly invalidates a stale Research result instead of
-- being reused.
alter table public.meeting_preparations
  add column if not exists research_status text,
  add column if not exists research_generated_at timestamptz,
  add column if not exists research_source_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'meeting_preparations_research_status_check'
  ) then
    alter table public.meeting_preparations
      add constraint meeting_preparations_research_status_check
      check (research_status is null or research_status in ('PENDING', 'READY', 'FAILED'));
  end if;
end $$;

commit;
