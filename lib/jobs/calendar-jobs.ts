import "server-only";

import { after } from "next/server";
import { resolveStableOrigin } from "@/lib/auth/app-origin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureCalendarWatch,
  safeCalendarErrorCode,
  syncGoogleCalendarConnection,
  SYNC_TIME_BUDGET_MS,
} from "@/lib/google/calendar-sync";
import { GeminiApiError } from "@/lib/gemini/client";
import { runAutoPreparationForMeeting } from "@/lib/preparation/auto-generate";
import { runMaterialGenerationForMeeting } from "@/lib/preparation/material-generate";
import { getCronSecret } from "@/lib/security/server-secrets";

export {
  enqueueCalendarSyncJob,
  enqueueMeetingPreparationJob,
  enqueueMaterialGenerationJob,
} from "@/lib/jobs/queue";

const MAX_ATTEMPTS = 5;
const PREPARATION_JOB_TYPES = ["MEETING_PREPARATION", "MATERIAL_GENERATION"] as const;
const CALENDAR_JOB_TYPES = ["CALENDAR_SYNC", "WATCH_RENEWAL"] as const;
const STALE_RUNNING_THRESHOLD_MS = 5 * 60 * 1000;
/**
 * Safety cap on self-triggered checkpoint continuations for a single
 * CALENDAR_SYNC job (see triggerCalendarSyncContinuation). Each continuation
 * is a full ~45s time-budget cycle, so 200 is a generous ~2.5h ceiling for a
 * one-time large initial backfill - well beyond what any real backfill
 * should need - while still guaranteeing a broken/looping sync can't
 * self-trigger forever and run up compute cost unnoticed.
 */
const MAX_SYNC_CONTINUATIONS = 200;

/**
 * A job stays RUNNING once claimed until its own try/catch writes DONE/
 * PENDING/FAILED. A hard platform timeout (function killed mid-run, no JS
 * exception) skips that write entirely, so without this the job is stuck
 * RUNNING forever - nothing else re-claims it, since claiming only looks at
 * PENDING rows. Reclaiming anything RUNNING for longer than any plausible
 * invocation (well past the 60s maxDuration ceiling) makes it retryable
 * again through the normal PENDING path.
 */
async function reclaimStaleRunningJobs(): Promise<void> {
  const admin = createAdminClient();
  const threshold = new Date(Date.now() - STALE_RUNNING_THRESHOLD_MS).toISOString();
  await admin
    .from("jobs")
    .update({ status: "PENDING", locked_at: null, last_error_safe: "stale_running_reclaimed" })
    .eq("status", "RUNNING")
    .lt("locked_at", threshold);
}

async function markPreparationFailed(meetingId: string): Promise<void> {
  const admin = createAdminClient();
  try {
    await admin.from("meeting_preparations").update({ status: "FAILED" }).eq("meeting_id", meetingId);
    await admin.from("meetings").update({ status: "FAILED" }).eq("id", meetingId).neq("status", "CANCELLED");
  } catch (error) {
    console.error("meeting_preparation_failure_flag_failed", {
      meeting_id: meetingId,
      code: safeCalendarErrorCode(error),
    });
  }
}

/**
 * Unlike markPreparationFailed, this never touches meeting_preparations or
 * meetings: a Material failure must not revert an already-READY
 * Preparation or the meeting's READY status (per the auto-preparation
 * hardening spec) - only meeting_materials reflects the failure.
 */
async function markMaterialFailed(meetingId: string, errorSafe: string): Promise<void> {
  const admin = createAdminClient();
  try {
    await admin.from("meeting_materials").update({ status: "FAILED", error_safe: errorSafe }).eq("meeting_id", meetingId);
  } catch (error) {
    console.error("meeting_material_failure_flag_failed", {
      meeting_id: meetingId,
      code: safeCalendarErrorCode(error),
    });
  }
}

export async function processCalendarJob(
  jobId: string,
  appOrigin: string,
  /** Absolute epoch ms this (and any chained) call should finish syncing by. */
  deadline: number = Date.now() + SYNC_TIME_BUDGET_MS,
): Promise<"done" | "skipped" | "retry" | "failed" | "continuing"> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  /**
   * Reclaiming here (not only in the cron/prep sweep) matters: the webhook
   * path calls processCalendarJob directly for the one job it just
   * enqueued and never goes through runDueJobsOfTypes at all, so a stale
   * job from an earlier timed-out invocation was never being reclaimed by
   * anything until the once-daily cron sweep. Confirmed in production:
   * several CALENDAR_SYNC jobs accumulated stuck at RUNNING across repeated
   * webhook-triggered retries because this call was previously missing here.
   */
  await reclaimStaleRunningJobs();

  const { data: pending, error: lookupError } = await admin
    .from("jobs")
    .select("id,job_type,google_connection_id,meeting_id,status,attempts,run_after,payload")
    .eq("id", jobId)
    .maybeSingle();

  if (lookupError || !pending || pending.status !== "PENDING") return "skipped";
  if (new Date(pending.run_after).getTime() > Date.now()) return "skipped";

  const nextAttempts = pending.attempts + 1;
  const { data: claimed, error: claimError } = await admin
    .from("jobs")
    .update({
      status: "RUNNING",
      attempts: nextAttempts,
      locked_at: now,
      last_error_safe: null,
    })
    .eq("id", jobId)
    .eq("status", "PENDING")
    .select("id")
    .maybeSingle();

  if (claimError || !claimed) return "skipped";

  try {
    if (pending.job_type === "CALENDAR_SYNC") {
      if (!pending.google_connection_id) throw new Error("calendar_job_connection_missing");
      const result = await syncGoogleCalendarConnection(pending.google_connection_id, { deadline });

      if (!result.completed) {
        /**
         * A graceful time-budget checkpoint, not a failure: pending_page_token
         * already durably reflects every page finished so far. Reverting
         * attempts back to its pre-claim value means paging through a large
         * backfill never counts against MAX_ATTEMPTS - only genuine errors
         * (thrown from the sync itself) do. run_after is "now" so the next
         * sweep, webhook-triggered call, or self-continuation (see
         * runJobToCompletionOrBudget) can continue immediately.
         */
        const existingPayload = (pending.payload ?? {}) as Record<string, unknown>;
        const continuationCount = (typeof existingPayload["continuation_count"] === "number"
          ? existingPayload["continuation_count"]
          : 0) + 1;

        if (continuationCount > MAX_SYNC_CONTINUATIONS) {
          await admin
            .from("jobs")
            .update({
              status: "FAILED",
              locked_at: null,
              last_error_safe: "calendar_sync_continuation_limit_exceeded",
            })
            .eq("id", jobId);

          return "failed";
        }

        await admin
          .from("jobs")
          .update({
            status: "PENDING",
            attempts: pending.attempts,
            locked_at: null,
            last_error_safe: null,
            run_after: new Date().toISOString(),
            payload: { ...existingPayload, continuation_count: continuationCount },
          })
          .eq("id", jobId);

        return "continuing";
      }
    } else if (pending.job_type === "WATCH_RENEWAL") {
      if (!pending.google_connection_id) throw new Error("calendar_job_connection_missing");
      await ensureCalendarWatch(pending.google_connection_id, appOrigin, { force: true });
    } else if (pending.job_type === "MEETING_PREPARATION") {
      if (!pending.meeting_id) throw new Error("meeting_preparation_job_meeting_missing");
      await runAutoPreparationForMeeting(pending.meeting_id, nextAttempts);
    } else if (pending.job_type === "MATERIAL_GENERATION") {
      if (!pending.meeting_id) throw new Error("material_generation_job_meeting_missing");
      await runMaterialGenerationForMeeting(pending.meeting_id, nextAttempts);
    } else {
      throw new Error("unsupported_job_type");
    }

    await admin
      .from("jobs")
      .update({
        status: "DONE",
        locked_at: null,
        last_error_safe: null,
      })
      .eq("id", jobId);

    return "done";
  } catch (error) {
    const safeError = safeCalendarErrorCode(error);
    // A retired/nonexistent Gemini model (404) is a configuration problem,
    // not a transient failure - exponential-backoff retrying it would just
    // repeat the identical failure MAX_ATTEMPTS times before ever
    // surfacing that the real fix is a model name, not "try again".
    const isConfigurationError = error instanceof GeminiApiError && error.isConfigurationError;
    if (nextAttempts >= MAX_ATTEMPTS || isConfigurationError) {
      await admin
        .from("jobs")
        .update({
          status: "FAILED",
          locked_at: null,
          last_error_safe: safeError,
        })
        .eq("id", jobId);

      if (pending.job_type === "MEETING_PREPARATION" && pending.meeting_id) {
        await markPreparationFailed(pending.meeting_id);
      } else if (pending.job_type === "MATERIAL_GENERATION" && pending.meeting_id) {
        await markMaterialFailed(pending.meeting_id, safeError);
      }

      return "failed";
    }

    // Equal jitter (half fixed + half random): spreads out retries enough
    // to avoid every job in a batch re-hitting a transient upstream outage
    // (e.g. Gemini 503 "high demand") at the exact same instant, while
    // still guaranteeing at least half of the base exponential delay.
    const baseDelayMinutes = Math.min(60, 2 ** nextAttempts);
    const jitteredDelayMinutes = baseDelayMinutes / 2 + Math.random() * (baseDelayMinutes / 2);
    await admin
      .from("jobs")
      .update({
        status: "PENDING",
        locked_at: null,
        last_error_safe: safeError,
        run_after: new Date(Date.now() + jitteredDelayMinutes * 60_000).toISOString(),
      })
      .eq("id", jobId);

    return "retry";
  }
}

/**
 * Fires a background HTTP call back into this same deployment to resume a
 * checkpointed CALENDAR_SYNC job, so draining a large initial backfill
 * doesn't depend on a human re-editing the Calendar event or waiting for the
 * next cron tick. Wrapped in after() since it's invoked from inside a
 * request's execution (webhook, cron, or the continuation route itself);
 * after() keeps the invocation alive long enough for the fetch to be sent
 * even though nothing awaits its response. Gated by the same CRON_SECRET
 * used for the cron route - a trusted server-to-server trigger, not a
 * user-facing credential, and never logged.
 *
 * after() itself throws synchronously if called outside a real request
 * execution context - this must never propagate out of here and corrupt an
 * otherwise-successful job-processing result, so the call to after() is
 * itself guarded, not just the work inside it.
 */
function triggerCalendarSyncContinuation(jobId: string, appOrigin: string): void {
  try {
    after(async () => {
      try {
        const secret = getCronSecret();
        const url = new URL("/api/internal/calendar-sync-continue", resolveStableOrigin(appOrigin)).toString();
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify({ jobId }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          // fetch() only throws on network-level failure, never on a
          // non-2xx HTTP response - a protected/blocked/misrouted target
          // must still be loud, not fail silently like this did before.
          console.error("calendar_sync_continuation_trigger_non_ok", {
            job_id: jobId,
            status: response.status,
          });
        }
      } catch (error) {
        console.error("calendar_sync_continuation_trigger_failed", {
          job_id: jobId,
          code: safeCalendarErrorCode(error),
        });
      }
    });
  } catch (error) {
    console.error("calendar_sync_continuation_schedule_failed", {
      job_id: jobId,
      code: safeCalendarErrorCode(error),
    });
  }
}

/**
 * Keeps re-invoking processCalendarJob for the same job while it reports
 * "continuing" (a graceful time-budget checkpoint, not a failure), sharing
 * one deadline across every round so the loop itself never runs the job
 * past the true remaining budget. Used by both the sweep below and the
 * webhook route, so a large CALENDAR_SYNC backfill makes as much durable
 * progress as fits in one invocation instead of stopping after one page. If
 * the job still isn't done once the shared deadline is reached, triggers a
 * self-continuation so a fresh invocation picks up where this one left off
 * without needing another external event.
 */
export async function runJobToCompletionOrBudget(
  jobId: string,
  appOrigin: string,
  deadline: number,
): Promise<"done" | "skipped" | "retry" | "failed" | "continuing"> {
  let result = await processCalendarJob(jobId, appOrigin, deadline);
  while (result === "continuing" && Date.now() < deadline) {
    result = await processCalendarJob(jobId, appOrigin, deadline);
  }
  if (result === "continuing") {
    triggerCalendarSyncContinuation(jobId, appOrigin);
  }
  return result;
}

async function runDueJobsOfTypes(
  appOrigin: string,
  jobTypes: readonly string[],
  limit: number,
): Promise<{ attempted: number; done: number; retry: number; failed: number; continuing: number }> {
  await reclaimStaleRunningJobs();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("jobs")
    .select("id")
    .eq("status", "PENDING")
    .lte("run_after", new Date().toISOString())
    .in("job_type", jobTypes)
    .order("run_after", { ascending: true })
    .limit(limit);

  if (error) throw new Error("calendar_jobs_lookup_failed");

  // Shared across every job in this sweep, not reset per row: bounds the
  // whole sweep call to a safe margin below the platform's 60s ceiling
  // regardless of how many jobs are due.
  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;

  let done = 0;
  let retry = 0;
  let failed = 0;
  let continuing = 0;
  for (const row of data ?? []) {
    if (Date.now() >= deadline) break;
    const result = await runJobToCompletionOrBudget(row.id, appOrigin, deadline);
    if (result === "done") done += 1;
    if (result === "retry") retry += 1;
    if (result === "failed") failed += 1;
    if (result === "continuing") continuing += 1;
  }

  return { attempted: data?.length ?? 0, done, retry, failed, continuing };
}

/** Cron fallback - recovers CALENDAR_SYNC/WATCH_RENEWAL/MEETING_PREPARATION/MATERIAL_GENERATION jobs left PENDING after a failed webhook-triggered attempt. */
export async function runDueCalendarJobs(
  appOrigin: string,
  limit = 10,
): Promise<{ attempted: number; done: number; retry: number; failed: number; continuing: number }> {
  return runDueJobsOfTypes(appOrigin, [...CALENDAR_JOB_TYPES, ...PREPARATION_JOB_TYPES], limit);
}

/** Called right after a webhook-triggered CALENDAR_SYNC job succeeds, so a newly detected E1 meeting gets prepared immediately rather than waiting for the next cron sweep. */
export async function runDuePreparationJobs(
  appOrigin: string,
  limit = 3,
): Promise<{ attempted: number; done: number; retry: number; failed: number; continuing: number }> {
  return runDueJobsOfTypes(appOrigin, PREPARATION_JOB_TYPES, limit);
}
