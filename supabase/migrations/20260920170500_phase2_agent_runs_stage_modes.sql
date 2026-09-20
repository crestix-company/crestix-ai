begin;

-- Splits the single combined "PREPARATION" agent_run into distinct stage
-- rows (RESEARCH / PREPARATION / MATERIAL) so token usage, Google Search
-- call count, latency, and status can be tracked per pipeline stage
-- instead of conflated into one row.
alter table public.agent_runs drop constraint agent_runs_mode_check;
alter table public.agent_runs add constraint agent_runs_mode_check
  check (mode in ('PREPARATION', 'RESEARCH', 'MATERIAL'));

commit;
