"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAppOrigin } from "@/lib/auth/app-origin";
import { requireAuthorizedUser } from "@/lib/auth/authorization";
import { processCalendarJob } from "@/lib/jobs/calendar-jobs";
import { enqueueMaterialGenerationJob } from "@/lib/jobs/queue";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Fallback for a permanently-FAILED MATERIAL_GENERATION job, not the
 * primary flow (that's the automatic Gemini pipeline). Scoped to the
 * authenticated FS user's own visible meeting via the RLS-respecting
 * client first - only once that confirms visibility does anything touch
 * the (authenticated-denied) jobs table via the admin client. Never
 * creates a duplicate active job: an existing PENDING/RUNNING
 * MATERIAL_GENERATION job is left alone and just re-run in place.
 */
export async function retryMaterialGeneration(meetingId: string) {
  await requireAuthorizedUser();

  const supabase = await createClient();
  const { data: meeting, error: meetingError } = await supabase
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .maybeSingle();
  if (meetingError || !meeting) redirect(`/fs/meetings/${meetingId}/material?status=not_found`);

  const admin = createAdminClient();

  const { data: preparation } = await admin
    .from("meeting_preparations")
    .select("id,status")
    .eq("meeting_id", meetingId)
    .maybeSingle();
  if (!preparation || preparation.status !== "READY") {
    redirect(`/fs/meetings/${meetingId}/material?status=preparation_not_ready`);
  }

  const { data: existingJob } = await admin
    .from("jobs")
    .select("id,status")
    .eq("job_type", "MATERIAL_GENERATION")
    .eq("meeting_id", meetingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingJob && (existingJob.status === "PENDING" || existingJob.status === "RUNNING")) {
    redirect(`/fs/meetings/${meetingId}/material?status=already_in_progress`);
  }

  let jobId: string | null = null;

  if (existingJob) {
    const { data: reset, error: resetError } = await admin
      .from("jobs")
      .update({
        status: "PENDING",
        attempts: 0,
        run_after: new Date().toISOString(),
        locked_at: null,
        last_error_safe: null,
      })
      .eq("id", existingJob.id)
      .select("id")
      .maybeSingle();
    if (resetError || !reset) redirect(`/fs/meetings/${meetingId}/material?status=retry_failed`);
    jobId = reset.id;
  } else {
    jobId = await enqueueMaterialGenerationJob({
      meetingId,
      preparationId: preparation.id,
      dedupeKey: `material-gen:${meetingId}:${preparation.id}:manual-retry:${Date.now()}`,
    });
  }

  if (!jobId) redirect(`/fs/meetings/${meetingId}/material?status=retry_failed`);

  const requestHeaders = await headers();
  let appOrigin: string;
  try {
    appOrigin = getAppOrigin(requestHeaders);
  } catch {
    redirect(`/fs/meetings/${meetingId}/material?status=retry_queued`);
  }

  try {
    await processCalendarJob(jobId, appOrigin);
  } catch (error) {
    console.error("material_manual_retry_run_failed", {
      meeting_id: meetingId,
      code: error instanceof Error ? error.message : "unknown",
    });
  }

  redirect(`/fs/meetings/${meetingId}/material?status=retry_started`);
}
