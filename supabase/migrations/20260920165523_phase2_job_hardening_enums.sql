begin;

-- Independent retry lifecycle for material generation (see the next
-- migration and lib/jobs/material-jobs.ts): a Preparation READY must not be
-- reverted just because Material generation failed afterwards.
alter type public.job_type add value if not exists 'MATERIAL_GENERATION';

-- Used to mark a CALENDAR_SYNC job that was made redundant by coalescing
-- (an active job already existed for the same connection) - distinct from
-- DONE (it never ran) and FAILED (no error occurred), so audit history
-- stays accurate.
alter type public.job_status add value if not exists 'SKIPPED';

commit;
