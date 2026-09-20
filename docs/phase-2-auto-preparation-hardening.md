# Phase 2 auto-preparation — production hardening

Date: 2026-09-20
Status: **IMPLEMENTATION COMPLETE, deployed to Production — final zero-touch E2E acceptance (Section 20/21 of the hardening spec) still pending real-world verification**

This documents the hardening pass applied on top of the original Gemini
auto-preparation feature (`docs/phase-1-report.md` covers Calendar sync;
the original auto-preparation build predates this doc). Scope: make the
whole pipeline self-sustaining with zero human intervention beyond adding
a Calendar event, add independent retry for Material generation, close a
job-duplication gap, and fix a pre-existing over-broad grant.

## Architecture

```
Google Calendar event created/edited
  -> Google push notification -> POST /api/webhooks/google-calendar
  -> enqueue CALENDAR_SYNC job (coalesced: at most one active job per
     google_connection_id - see "Job coalescing" below)
  -> processCalendarJob -> syncGoogleCalendarConnection
       - bounded initial query (now-1day .. now+365days) OR incremental
         syncToken query OR resumed pageToken query
       - upserts calendar_events, detects E1/E2/HD/OTHER meetings
       - if E1 + FS_AUTO_PREPARATION flag enabled + not CANCELLED +
         scheduled_start_at >= automation_start_at:
           enqueue MEETING_PREPARATION job (dedupe_key includes the
           Calendar event's etag/updated - a new event version gets a
           fresh job, not a duplicate)
  -> webhook's after() calls runDuePreparationJobs (MEETING_PREPARATION +
     MATERIAL_GENERATION), looped a few rounds so a Preparation success's
     freshly-enqueued Material job starts immediately instead of waiting
     for the next cron tick
  -> runAutoPreparationForMeeting (lib/preparation/auto-generate.ts):
       STEP A - Research Agent (Gemini + Google Search grounding, public
                web only, no Calendar description, no patient data)
       STEP B - Preparation Agent (Research output + Master Skill
                skills/fs/medical-fs-e1-complete/SKILL.md) -> saves
                meeting_preparations (status=READY, source_mode=API),
                meetings -> READY
       -> enqueues MATERIAL_GENERATION job (independent from here on)
  -> runMaterialGenerationForMeeting (lib/preparation/material-generate.ts):
       STEP C - Material Agent (Preparation output only, no new facts)
                -> meeting_materials (status=READY)
  -> UI: /fs/meetings, /fs/meetings/[id], /fs/meetings/[id]/material
```

Manual ChatGPT paste flow (`docs/e1-manual-preparation.md`) is untouched
and remains the fallback with no AI provider API key required
(`source_mode=MANUAL_CHATGPT`).

## Job types and their retry lifecycles

| job_type | Enqueued by | Retries on | Never retries on | Terminal failure effect |
|---|---|---|---|---|
| `CALENDAR_SYNC` | webhook, cron | Google/DB errors (bounded exponential backoff, `MAX_ATTEMPTS=5`) | A checkpoint (time-budget hit mid-page) - `attempts` is explicitly reverted, see "Checkpoint vs retry" | None (job stays retryable; a genuinely broken sync eventually hits `MAX_ATTEMPTS` and is `FAILED`, or hits `MAX_SYNC_CONTINUATIONS` if it never stops checkpointing) |
| `WATCH_RENEWAL` | cron | Same as above | - | - |
| `MEETING_PREPARATION` | `calendar-sync.ts` on E1 detection | Gemini/DB errors | - | `meeting_preparations` and `meetings` both flip to `FAILED` |
| `MATERIAL_GENERATION` | `auto-generate.ts` after Preparation READY, or the manual retry action | Gemini/DB errors, **independent of Preparation's own attempts** | - | Only `meeting_materials` flips to `FAILED` - Preparation and `meetings.status=READY` are untouched |

### Checkpoint vs retry (point C/D/5 of the hardening spec)

A `CALENDAR_SYNC` job hitting its own time budget mid-backfill is **not**
a retry - `processCalendarJob` explicitly resets `attempts` back to its
pre-claim value before returning the job to `PENDING`. Only a thrown
error (a real Google API/DB failure) consumes `MAX_ATTEMPTS`. This
distinction exists because a large first-time backfill can legitimately
need many checkpoints and must never be treated the same as something
actually failing.

### Self-continuation (point 2/4 of the hardening spec)

`runJobToCompletionOrBudget` (`lib/jobs/calendar-jobs.ts`) loops
`processCalendarJob` internally until either the job finishes or the
shared deadline (`SYNC_TIME_BUDGET_MS`, 45s) is reached. If it's still
checkpointing at that point, it fires a background self-request (via
Next's `after()`) to `POST /api/internal/calendar-sync-continue` - an
internal, `CRON_SECRET`-gated route that resumes the same job with a
fresh budget. This chains across serverless invocations automatically,
without a human re-editing the Calendar event or waiting for the next
cron tick. A per-job `continuation_count` (stored in `jobs.payload`) caps
this at `MAX_SYNC_CONTINUATIONS = 200` (~2.5h of continuous 45s cycles) -
a genuinely stuck sync fails loudly (`calendar_sync_continuation_limit_exceeded`)
instead of self-triggering forever.

`after()` throws synchronously if called outside a real Next.js request
execution context - the call to `after()` itself (not just the work
inside its callback) is wrapped in try/catch so a failure to *schedule*
the continuation can never corrupt an otherwise-successful job result.

### Job coalescing (point 3 of the hardening spec)

A partial unique index (`jobs_calendar_sync_active_unique`, migration
`20260920165602`) allows at most one active (`PENDING`/`RUNNING`)
`CALENDAR_SYNC` job per `google_connection_id`. `enqueueCalendarSyncJob`
already tolerated a unique-constraint conflict the same way it tolerates
a `dedupe_key` collision (returns `null`, no throw), so a burst of
webhook deliveries for the same connection coalesces onto the single
active job instead of piling up duplicates. Google's `last_message_number`
tracking and `sync_token`/`pending_page_token` state live on
`calendar_watch_channels`, not on the job row, so which specific job row
happens to be the "active" one doesn't affect correctness - any of them
resuming reads the same connection-level state.

24 CALENDAR_SYNC jobs that had accumulated on one connection before this
fix (from repeated webhook deliveries during earlier live testing) were
marked `SKIPPED` (a new `job_status` value distinct from `DONE`/`FAILED` -
they never ran and no error occurred) rather than deleted, preserving the
audit trail.

### Material's independent retry (point 8/9 of the hardening spec)

Before this pass, Material generation ran inline at the end of
`runAutoPreparationForMeeting` and swallowed its own errors - a Material
failure after a successful Preparation left the parent job `DONE` with no
automatic recovery path. `MATERIAL_GENERATION` is now its own job type
with its own `dedupe_key` (`material-gen:<meetingId>:<preparationId>:<timestamp>`,
so a regenerated Preparation gets a fresh Material job rather than
colliding with a stale one), its own `attempts`/backoff, and re-throws on
failure instead of swallowing. A permanent Material failure never reverts
`meeting_preparations.status` or `meetings.status` - only
`meeting_materials.status` reflects it.

**Manual fallback**: `/fs/meetings/[id]/material` shows a "資料を再生成"
button when `meeting_materials.status = FAILED`
(`app/fs/meetings/[id]/material/actions.ts`). Scoped to the authenticated
FS user's own RLS-visible meeting; re-checks Preparation is still
`READY`; never creates a duplicate active job (an existing
`PENDING`/`RUNNING` job is left alone and just re-run in place, a
`FAILED` one is reset).

### Cancellation (point 16 of the hardening spec)

`isEligibleForAutoPreparation` already excludes `meetingStatus === "CANCELLED"`
and is re-checked at the top of `runAutoPreparationForMeeting` on every
run (not just at enqueue time). `runMaterialGenerationForMeeting`
performs the equivalent check (`meeting.status === "CANCELLED"` -> skip)
plus a Preparation-readiness check (`preparation.status !== "READY"` ->
skip), so a job that was PENDING when the meeting got cancelled, or whose
Preparation later failed, silently no-ops instead of generating stale
output.

## Privacy (unchanged from the original build, verified this pass)

`user_feature_flags.config.include_private_calendar_notes` defaults to
`false`. When false, the Calendar event's `description` is never sent to
Gemini in either the Research or Preparation prompt. No patient-specific
health information is ever collected (Research Agent prompt explicitly
scopes to public clinic/business information). Public web content
returned by the Research Agent is treated as data, not instructions
(prompt-injection resistance instructions embedded in
`lib/preparation/auto-prompt.ts`, covered by
`lib/preparation/auto-prompt.test.ts`).

## Feature flag

`user_feature_flags` (`feature_key='FS_AUTO_PREPARATION'`): `enabled`,
`automation_start_at` (meetings scheduled before this are never
auto-prepared, even if the flag is on), and `config` (`generate_materials`,
`include_private_calendar_notes`, `material_mode`). RLS denies all
`authenticated` access - only the admin (service-role) client reads it,
and it's provisioned per-user by migration, not through any UI (no
self-service flag toggling exists, by design).

## Observability

`agent_runs` now has one row per pipeline **stage** (`mode` = `RESEARCH`,
`PREPARATION`, or `MATERIAL`) instead of one combined row per pipeline
run, each with its own `input_tokens`/`output_tokens`/`search_call_count`/
`status`/`started_at`/`completed_at`. Token/search-call usage is always
either the real value from Gemini's response or `NULL` - never faked as
`0`. `estimated_cost_usd` is computed by `lib/gemini/pricing.ts` only when
`GEMINI_PRICE_INPUT_PER_MILLION_TOKENS_USD` /
`GEMINI_PRICE_OUTPUT_PER_MILLION_TOKENS_USD` (and optionally
`GEMINI_PRICE_SEARCH_PER_CALL_USD`) are explicitly set in the
environment; left unset (the current Production state - no pricing env
vars are configured), it's always `NULL`, never a guessed figure
presented as confirmed.

## Security review (point 18 of the hardening spec)

A manual review (RLS coverage, `anon`/`authenticated` grants,
`SECURITY DEFINER` function `search_path` safety - no Supabase Advisor
MCP tool was available, so this was done via direct SQL against
`pg_class`/`information_schema.role_table_grants`/`pg_proc`) found all 15
`public` tables have RLS enabled, and all `SECURITY DEFINER` functions
(`app_private.can_access_fs_user`, `has_org_role`, `is_active_member`)
have `search_path=""` set. It also found a **pre-existing** issue
predating this round: `phase0_foundation.sql` and
`phase1_calendar_sync.sql` revoked `ALL` from `anon` before granting the
intended `SELECT` to `authenticated`, but never ran the equivalent revoke
for `authenticated` - leaving `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/
`REFERENCES`/`TRIGGER` grants in place on `calendar_events`,
`calendar_watch_channels`, `clinics`, `meetings`, `organizations`,
`profiles`, and `google_connections`. RLS was already blocking every one
of those operations (no matching write policy existed except
`profiles`/`google_connections`' genuine self-service policies), and no
application code used the RLS-respecting client to write to the affected
tables (verified by grep - all writes go through the service-role admin
client). Fixed in migration `20260920172000` with zero functional impact.

`organization_memberships` still has a broader-than-SELECT grant to
`authenticated` with no matching write policy either - this predates
Phase 1/2, was an explicit (not copy-paste-oversight) grant in
`phase0_foundation.sql`, and was left untouched since its intent (a
planned self-service membership feature?) isn't established by this
round's scope. **Known limitation** - worth a follow-up decision, not
fixed here.

## Operational runbook

- **Daily cron** (`vercel.json`, `0 18 * * *`, `/api/cron/calendar-maintenance`):
  renews Calendar watch channels nearing expiry and sweeps up to 10 due
  `CALENDAR_SYNC`/`WATCH_RENEWAL`/`MEETING_PREPARATION`/`MATERIAL_GENERATION`
  jobs. This is the fallback path if a webhook delivery was somehow
  missed entirely (self-continuation, above, covers the common case of a
  large backfill needing more than one invocation).
- **Stale RUNNING reclaim**: any job stuck `RUNNING` for more than 5
  minutes (well past the 60s platform ceiling) is reclaimed to `PENDING`
  with `last_error_safe='stale_running_reclaimed'`. Runs both at the top
  of every `processCalendarJob` call and at the top of every sweep - this
  should only ever fire after a genuine platform crash, not as the normal
  checkpoint path (see "Checkpoint vs retry" above).
- **Checking a specific connection's sync state**:
  ```sql
  select sync_token is not null as done, pending_page_token, last_synced_at, updated_at, last_message_number
  from calendar_watch_channels where google_connection_id = '<id>' order by created_at desc limit 1;
  ```
- **Checking for stuck/failed jobs**:
  ```sql
  select job_type, status, count(*) from jobs group by job_type, status order by job_type, status;
  ```
- **CRON_SECRET** gates both the daily cron and the internal
  continuation route. It is never logged, never requested from a human
  in chat, and never printed by any script in this repo.

## Failure investigation procedure

1. Check `jobs.last_error_safe` for the specific job - this is always a
   short, non-sensitive code, never a raw error message that could leak
   secrets.
2. Check Vercel runtime logs for the relevant route
   (`/api/webhooks/google-calendar`, `/api/cron/calendar-maintenance`,
   `/api/internal/calendar-sync-continue`) around the job's
   `created_at`/`locked_at` timestamps.
3. For a `CALENDAR_SYNC` job: check `calendar_watch_channels.pending_page_token`
   - if it's non-null and changing across invocations, the sync is
     making real progress, not stuck (large backfills can legitimately
     take many checkpoint cycles).
4. For a `MEETING_PREPARATION`/`MATERIAL_GENERATION` job: check the
   corresponding `agent_runs` row (`mode` = `RESEARCH`/`PREPARATION`/`MATERIAL`)
   for `error_safe` and whether it's a schema-validation failure (Gemini
   returned malformed JSON) vs. a transient API error (times out /
   retries) vs. a genuine `GEMINI_API_KEY` misconfiguration.
5. Never resolve a stuck job by writing directly to the database in
   Production without going through the job's own retry/reset path (the
   manual Material retry action is the one sanctioned exception, and even
   that only resets `status`/`attempts`/`run_after`/`locked_at` on the
   existing row - it never bypasses eligibility/cancellation checks).

## Known limitations

- `organization_memberships` retains a broader-than-SELECT grant to
  `authenticated` predating this round - see "Security review" above.
- Self-continuation requires at least one real trigger (webhook or cron)
  to start a chain; it cannot spontaneously resume a job that's been idle
  with nothing invoking `runJobToCompletionOrBudget` at all. This only
  matters for an already-idle job from *before* self-continuation
  existed - a fresh, normal Calendar event always arrives via webhook,
  which starts the chain itself.
- `estimated_cost_usd` is `NULL` in Production today (no
  `GEMINI_PRICE_*` env vars configured) - cost tracking exists but isn't
  populated until pricing is explicitly configured with real, current
  Gemini rates.
- Google Slides API integration is out of scope (per the original spec) -
  `meeting_materials` are internal Markdown/JSON documents, not exported
  Slides decks.
