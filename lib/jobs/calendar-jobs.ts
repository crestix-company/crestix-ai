import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  ensureCalendarWatch,
  safeCalendarErrorCode,
  syncGoogleCalendarConnection,
} from "@/lib/google/calendar-sync";

const MAX_ATTEMPTS = 5;

export async function enqueueCalendarSyncJob(input: {
  connectionId: string;
  dedupeKey: string;
  payload?: Record<string, unknown>;
}): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("jobs")
    .upsert({
      job_type: "CALENDAR_SYNC",
      google_connection_id: input.connectionId,
      payload: input.payload ?? {},
      dedupe_key: input.dedupeKey,
      status: "PENDING",
      run_after: new Date().toISOString(),
    }, {
      onConflict: "dedupe_key",
      ignoreDuplicates: true,
    })
    .select("id")
    .maybeSingle();

  if (error && error.code !== "23505") throw new Error("calendar_job_enqueue_failed");
  return data?.id ?? null;
}

export async function processCalendarJob(
  jobId: string,
  appOrigin: string,
): Promise<"done" | "skipped" | "retry" | "failed"> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: pending, error: lookupError } = await admin
    .from("jobs")
    .select("id,job_type,google_connection_id,status,attempts,run_after")
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
    if (!pending.google_connection_id) throw new Error("calendar_job_connection_missing");

    if (pending.job_type === "CALENDAR_SYNC") {
      await syncGoogleCalendarConnection(pending.google_connection_id);
    } else if (pending.job_type === "WATCH_RENEWAL") {
      await ensureCalendarWatch(pending.google_connection_id, appOrigin, { force: true });
    } else {
      throw new Error("unsupported_phase1_job_type");
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

export async function runDueCalendarJobs(
  appOrigin: string,
  limit = 10,
): Promise<{ attempted: number; done: number; retry: number; failed: number }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("jobs")
    .select("id")
    .eq("status", "PENDING")
    .lte("run_after", new Date().toISOString())
    .in("job_type", ["CALENDAR_SYNC", "WATCH_RENEWAL"])
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
