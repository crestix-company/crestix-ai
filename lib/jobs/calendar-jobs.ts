import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureCalendarWatch,
  safeCalendarErrorCode,
  syncGoogleCalendarConnection,
} from "@/lib/google/calendar-sync";
import { runAutoPreparationForMeeting } from "@/lib/preparation/auto-generate";

export { enqueueCalendarSyncJob, enqueueMeetingPreparationJob } from "@/lib/jobs/queue";

const MAX_ATTEMPTS = 5;
const PREPARATION_JOB_TYPES = ["MEETING_PREPARATION"] as const;
const CALENDAR_JOB_TYPES = ["CALENDAR_SYNC", "WATCH_RENEWAL"] as const;

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

export async function processCalendarJob(
  jobId: string,
  appOrigin: string,
): Promise<"done" | "skipped" | "retry" | "failed"> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: pending, error: lookupError } = await admin
    .from("jobs")
    .select("id,job_type,google_connection_id,meeting_id,status,attempts,run_after")
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
      await syncGoogleCalendarConnection(pending.google_connection_id);
    } else if (pending.job_type === "WATCH_RENEWAL") {
      if (!pending.google_connection_id) throw new Error("calendar_job_connection_missing");
      await ensureCalendarWatch(pending.google_connection_id, appOrigin, { force: true });
    } else if (pending.job_type === "MEETING_PREPARATION") {
      if (!pending.meeting_id) throw new Error("meeting_preparation_job_meeting_missing");
      await runAutoPreparationForMeeting(pending.meeting_id);
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
    if (nextAttempts >= MAX_ATTEMPTS) {
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
      }

      return "failed";
    }

    const delayMinutes = Math.min(60, 2 ** nextAttempts);
    await admin
      .from("jobs")
      .update({
        status: "PENDING",
        locked_at: null,
        last_error_safe: safeError,
        run_after: new Date(Date.now() + delayMinutes * 60_000).toISOString(),
      })
      .eq("id", jobId);

    return "retry";
  }
}

async function runDueJobsOfTypes(
  appOrigin: string,
  jobTypes: readonly string[],
  limit: number,
): Promise<{ attempted: number; done: number; retry: number; failed: number }> {
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

  let done = 0;
  let retry = 0;
  let failed = 0;
  for (const row of data ?? []) {
    const result = await processCalendarJob(row.id, appOrigin);
    if (result === "done") done += 1;
    if (result === "retry") retry += 1;
    if (result === "failed") failed += 1;
  }

  return { attempted: data?.length ?? 0, done, retry, failed };
}

/** Cron fallback - recovers CALENDAR_SYNC/WATCH_RENEWAL/MEETING_PREPARATION jobs left PENDING after a failed webhook-triggered attempt. */
export async function runDueCalendarJobs(
  appOrigin: string,
  limit = 10,
): Promise<{ attempted: number; done: number; retry: number; failed: number }> {
  return runDueJobsOfTypes(appOrigin, [...CALENDAR_JOB_TYPES, ...PREPARATION_JOB_TYPES], limit);
}

/** Called right after a webhook-triggered CALENDAR_SYNC job succeeds, so a newly detected E1 meeting gets prepared immediately rather than waiting for the next cron sweep. */
export async function runDuePreparationJobs(
  appOrigin: string,
  limit = 3,
): Promise<{ attempted: number; done: number; retry: number; failed: number }> {
  return runDueJobsOfTypes(appOrigin, PREPARATION_JOB_TYPES, limit);
}
