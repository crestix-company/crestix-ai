import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Deliberately has zero dependency on calendar-sync.ts / auto-generate.ts.
 * Those modules enqueue jobs (calendar-sync.ts enqueues MEETING_PREPARATION
 * jobs from inside its own sync loop); if this file imported the job
 * processor instead, that would create an import cycle.
 */

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

export async function enqueueMeetingPreparationJob(input: {
  meetingId: string;
  dedupeKey: string;
}): Promise<string | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("jobs")
    .upsert({
      job_type: "MEETING_PREPARATION",
      meeting_id: input.meetingId,
      payload: {},
      dedupe_key: input.dedupeKey,
      status: "PENDING",
      run_after: new Date().toISOString(),
    }, {
      onConflict: "dedupe_key",
      ignoreDuplicates: true,
    })
    .select("id")
    .maybeSingle();

  if (error && error.code !== "23505") throw new Error("meeting_preparation_job_enqueue_failed");
  return data?.id ?? null;
}
