begin;

-- Fix: the initial medical_fs_job_sweep schedule used net.http_post, but
-- /api/cron/jobs only exports a GET handler (matching the existing
-- /api/cron/calendar-maintenance convention) - confirmed live via
-- net._http_response returning 405 Method Not Allowed on every run since
-- the previous migration. cron.schedule with the same job name updates
-- the existing job in place rather than creating a duplicate.
select cron.schedule(
  'medical_fs_job_sweep',
  '*/2 * * * *',
  $cron$
  select net.http_get(
    url := 'https://crestix-ai.vercel.app/api/cron/jobs',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_cron_bridge_secret'
      )
    ),
    timeout_milliseconds := 55000
  );
  $cron$
);

commit;
