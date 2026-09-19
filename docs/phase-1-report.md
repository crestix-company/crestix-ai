# Phase 1 report

Date: 2026-09-19  
Status: **IMPLEMENTATION IN PROGRESS — deployed to Production; live Google OAuth + Calendar bootstrap exercised once, one concurrency bug found and fixed, re-verifying before GO**

## Production bootstrap finding (this pass)

The first real production OAuth login (`hiroyuki.maekawa@crestix-inc.com`, ADMIN) was completed and exercised the full bootstrap path against a real, busy Google Calendar. Result: `calendar_events` populated to 1671 rows and `meetings` correctly detected 5 real `HD` meetings (including two title-level cancellations via `キャンセル`/`アポキャンセル` prefixes) — the detection and upsert logic is correct on real data. However `calendar_watch_channels.last_synced_at` / `sync_token` were never persisted, and a `CALENDAR_SYNC` job ended in `PENDING` with `last_error_safe: "Error"`.

Root cause: `ensureCalendarWatch()` (called from the OAuth callback's `after()` bootstrap) called `syncGoogleCalendarConnection()` **directly**, while Google's own automatic "sync" webhook notification — sent immediately after `events.watch` registration, confirmed firing in production logs 4ms after the watch row was created — independently triggered the *same* sync through the job queue. Both ran concurrently against the same 1671-event initial backfill with no shared lock, and one lost a race on an upsert (data itself stayed correct because upserts are idempotent; only the trailing `sync_token`/`last_synced_at` write was lost).

Fix: `ensureCalendarWatch()` no longer calls `syncGoogleCalendarConnection()` itself. It only manages the Google push-channel lifecycle (create/renew); the initial and all subsequent syncs are driven exclusively through the job queue's single-claim path (Google's automatic "sync" notification for bootstrap, real notifications afterward, and the maintenance cron as a fallback). Also fixed `safeCalendarErrorCode()`, which was discarding the actual error identifier (`error.name`, always the generic string `"Error"` for plain `throw new Error("...")` call sites) instead of `error.message` (the deliberately-chosen safe identifier, e.g. `"calendar_event_upsert_failed"`) — this is what made the original failure hard to diagnose from `jobs.last_error_safe` alone. Added `lib/google/calendar-sync.test.ts` (3 tests) asserting `ensureCalendarWatch()` never calls `listCalendarEventsPage` in any branch.

Residual, accepted for Phase 1 MVP scope (6-person company): two *different* job rows for the same connection (e.g. a webhook notification and a cron sweep landing at nearly the same instant) can still process concurrently, since only a single job row's own claim is atomic, not per-connection. Idempotent upserts bound the damage to the same cosmetic `last_synced_at` non-update, not data corruption. A per-connection advisory lock would close this but is not justified at current volume; revisit if real concurrent-notification collisions are observed.

## Code review findings (this pass)

The Phase 1 source bundle was reviewed against the acceptance criteria before being trusted. Two defects were found and fixed:

- `app/auth/callback/route.test.ts` mocked `google_connections.upsert()` as directly resolving, but the route now chains `.select("id").single()` on the upsert to read back the connection id for the new `ensureCalendarWatch` bootstrap. The outdated mock made 3 of 8 tests fail with `upsert(...).select is not a function`. Fixed by chaining the mock and adding a `connectionSingle`/`connectionSelect` fixture.
- The same test file called the route's `GET` handler directly, which now calls `after()` (from `next/server`) to bootstrap the Calendar watch post-response. `after()` throws `` `after` was called outside a request scope `` when invoked outside Next's real per-request async-storage context, which only exists in tests, not in the deployed Vercel runtime. Fixed by mocking `next/server`'s `after` to fire-and-forget invoke the task, and mocking `@/lib/google/calendar-sync` so the bootstrap doesn't hit real network/DB in unit tests.

No other compile, type, or security issues were found in the bundle. `lib/google/meeting-detection.ts`, `lib/google/calendar-sync.ts`, `lib/google/webhook.ts`, the webhook route, and the cron route were read in full and matched the required behavior in `CLAUDE_HANDOFF.md` sections 7–14 (idempotent upsert by `google_connection_id + google_event_id` / `calendar_event_id`, SHA-256 channel token validation, syncToken + 410 full-resync, deterministic title rules with no bare `商談` match, RLS-scoped meeting visibility).

`supabase/tests/phase1_rls.sql` was extended with an explicit same-organization ADMIN fixture/assertion (Acceptance H had only an implicit code-path check via FS_MANAGER before). `npx supabase test db` could not be executed in this environment — no local Docker runtime is available — so the RLS policies were verified by static read-through against `20260918084247_phase1_calendar_sync.sql` and `20260918084333_phase1_jobs_explicit_deny.sql` instead of an executed pgTAP run.

## Local verification (this pass)

- `npx supabase migration list` — 4/4 local migrations match remote exactly (`20260916000000`, `20260916061455`, `20260918084247`, `20260918084333`). No drift, nothing re-applied.
- `npm run lint` — clean
- `npx tsc --noEmit` — clean
- `npm test` — 33/33 passing (8 files)
- `npm run build` — succeeds, all Phase 1 routes compile (`/admin`, `/api/cron/calendar-maintenance`, `/api/webhooks/google-calendar`, `/auth/callback`, `/fs/meetings`, `/fs/meetings/[id]`, `/settings/connections`)
- `npm audit --audit-level=high` — 0 vulnerabilities
- Secret scan for `TOKEN_ENCRYPTION_KEY=`, `GOOGLE_OAUTH_CLIENT_SECRET=`, `SUPABASE_SERVICE_ROLE_KEY=`, `SUPABASE_SECRET_KEY=`, `BEGIN PRIVATE KEY`, `PRIVATE_KEY=` across tracked source/docs/config — only placeholder values in `.env.example`; `.env.local` is git-ignored and was not read or displayed.

## Implemented in this change set

- `calendar_watch_channels`, `calendar_events`, `clinics`, `meetings`, and `jobs`
- RLS for FS_MEMBER / FS_MANAGER / ADMIN meeting visibility
- explicit deny for authenticated direct access to `jobs`
- Google Calendar `events.watch`
- webhook token hashing and notification validation
- notification dedupe through `jobs.dedupe_key`
- syncToken incremental sync and 410 full-resync recovery
- event / meeting upsert
- reschedule preservation by `calendar_event_id`
- Google cancellation and title-level cancellation handling
- watch renewal
- Vercel maintenance cron
- connection health UI
- meeting list and protected meeting detail
- masked deterministic current Calendar naming rules

## Runtime secrets

Server-only:

- `TOKEN_ENCRYPTION_KEY` — existing value, unchanged
- `TOKEN_KEY_VERSION=1`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `CRON_SECRET`

The Google client secret is needed in Phase 1 because Supabase does not refresh the Google provider access token for background Calendar API calls. It must remain server-only.

## Acceptance still required

1. Deploy source to Vercel Production.
2. Confirm OAuth bootstrap creates an ACTIVE Calendar watch.
3. Add one masked FS meeting event in Google Calendar.
4. Without another human action, confirm exactly one `calendar_events` row and one `meetings` row.
5. Confirm `/fs/meetings` shows the event.
6. Reschedule the same Google event and confirm the same meeting UUID changes time.
7. Cancel the event and confirm the same meeting becomes `CANCELLED`.
8. Add a normal internal `商談動画...` event and confirm no meeting is created.
9. Replay/duplicate webhook notification and confirm no duplicate meeting.
10. Verify FS_MEMBER cannot read another user's meeting UUID while FS_MANAGER and same-org ADMIN can.

Do not declare Phase 1 complete until these production acceptance checks pass.
