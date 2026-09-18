# Phase 1 report

Date: 2026-09-18  
Status: **IMPLEMENTATION IN PROGRESS — code reviewed and verified locally; source deployment and production Calendar acceptance smoke remain**

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
