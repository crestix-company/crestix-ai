begin;

-- Delayed-retry scheduler: Supabase's own pg_cron + pg_net call this app's
-- /api/cron/jobs endpoint every 2 minutes so a MEETING_PREPARATION/
-- MATERIAL_GENERATION job whose run_after has arrived (e.g. after a
-- Gemini 503 exponential-backoff wait) resumes automatically. Vercel's
-- Hobby plan cannot run a Cron more than once per day (confirmed via
-- Vercel's own docs - "Hobby accounts are limited to cron jobs that run
-- once per day"), so without this, a delayed retry only ever resumed when
-- a human manually ran `vercel crons run` - violating the Human
-- Intervention = 0 acceptance requirement. This closes that gap without
-- upgrading to a paid Vercel plan or contracting any new paid service -
-- pg_cron/pg_net/Vault are extensions already bundled with this Supabase
-- project at no extra cost.
create extension if not exists pg_cron;
create extension if not exists pg_net;

revoke all on schema cron from anon, authenticated;
revoke all on all functions in schema cron from anon, authenticated;
revoke all on schema net from anon, authenticated;
revoke all on all functions in schema net from anon, authenticated;

-- A dedicated bearer token for this Supabase -> Vercel call, separate from
-- CRON_SECRET (which gates Vercel's own daily cron and this app's
-- self-continuation calls, and which pg_cron has no access to). Generated
-- entirely inside Postgres - nobody types or supplies this value - and
-- stored only in Supabase Vault (encrypted at rest; plaintext is readable
-- only via vault.decrypted_secrets, which is restricted to postgres/
-- service_role, never anon/authenticated). The same value is also set as
-- a Vercel Production "secret"-type env var (SUPABASE_CRON_BRIDGE_SECRET)
-- so /api/cron/jobs can verify the caller - see
-- lib/security/internal-auth.ts's isValidSupabaseCronBridgeToken.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'supabase_cron_bridge_secret') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'supabase_cron_bridge_secret',
      'Bearer token Supabase pg_cron uses to call this app''s /api/cron/jobs delayed-retry sweep endpoint.'
    );
  end if;
end $$;

select cron.schedule(
  'medical_fs_job_sweep',
  '*/2 * * * *',
  $cron$
  select net.http_post(
    url := 'https://crestix-ai.vercel.app/api/cron/jobs',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'supabase_cron_bridge_secret'
      ),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $cron$
);

commit;
