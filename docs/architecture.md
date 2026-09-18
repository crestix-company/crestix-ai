# Architecture

The web runtime is Next.js 16 on Vercel Node.js Functions in `icn1`, backed by Supabase Auth/Postgres/RLS.

```text
Browser
  -> Vercel / Next.js
     -> Supabase Auth
     -> Supabase Postgres (RLS)
     -> Google Calendar API
```

## Phase 1 Calendar flow

```text
Google Calendar
  -> events.watch
  -> POST /api/webhooks/google-calendar
     -> validate channel id + SHA-256 token + resource id
     -> enqueue deduplicated CALENDAR_SYNC job
     -> return 204
     -> Next.js after() attempts immediate processing

Vercel Cron
  -> /api/cron/calendar-maintenance
     -> retry due Calendar jobs
     -> renew watches before expiration

Calendar sync
  -> decrypt stored Google provider refresh token server-side
  -> refresh short-lived Google access token
  -> events.list with syncToken
  -> calendar_events upsert
  -> deterministic FS meeting detection
  -> meetings upsert
```

The webhook never infers event changes from notification headers; it always reads current state from the Calendar API. Google push channels are renewable and default to a seven-day TTL.

## Trust boundaries

- Browser receives only Supabase publishable configuration.
- Google refresh token is AES-256-GCM ciphertext in Postgres.
- `SUPABASE_SECRET_KEY` / service-role fallback is server-only and used only by trusted background Calendar code.
- Google OAuth client secret is server-only and is required because Supabase Auth does not refresh the Google provider access token for background Calendar calls.
- `jobs` has RLS enabled and explicit direct deny for authenticated users.
- Meeting reads are enforced by RLS: FS_MEMBER own meetings; FS_MANAGER same-org FS; ADMIN same-org FS.
- Cloudflare remains reserved for a later Realtime Gateway; it is not on the Phase 1 web path.
