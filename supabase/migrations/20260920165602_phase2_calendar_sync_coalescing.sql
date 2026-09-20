begin;

-- Coalesce CALENDAR_SYNC jobs accumulated before this fix existed (repeated
-- webhook deliveries each enqueued their own job instead of reusing an
-- already-active one). Progress lives on calendar_watch_channels
-- (sync_token / pending_page_token), not on the job row itself, so keeping
-- only the most-recently-created active job per connection loses no
-- progress. Older ones are marked SKIPPED, not deleted, to preserve the
-- audit trail.
with ranked as (
  select id,
         row_number() over (
           partition by google_connection_id
           order by created_at desc
         ) as rn
  from public.jobs
  where job_type = 'CALENDAR_SYNC'
    and status in ('PENDING', 'RUNNING')
)
update public.jobs
set status = 'SKIPPED',
    last_error_safe = 'coalesced_superseded_by_newer_active_job'
where id in (select id from ranked where rn > 1);

-- From now on: at most one active (PENDING/RUNNING) CALENDAR_SYNC job per
-- connection. enqueueCalendarSyncJob's upsert already tolerates unique
-- violations (23505) the same way it tolerates a dedupe_key collision, so a
-- burst of webhook deliveries coalesces onto the single active job instead
-- of piling up duplicates.
create unique index if not exists jobs_calendar_sync_active_unique
  on public.jobs (google_connection_id)
  where job_type = 'CALENDAR_SYNC' and status in ('PENDING', 'RUNNING');

commit;
