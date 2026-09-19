import { after } from "next/server";
import { getAppOrigin } from "@/lib/auth/app-origin";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  hashCalendarChannelToken,
  parseGoogleCalendarWebhookHeaders,
} from "@/lib/google/webhook";
import { enqueueCalendarSyncJob, processCalendarJob, runDuePreparationJobs } from "@/lib/jobs/calendar-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The webhook responds 204 immediately, but after() keeps running in the
// background to sync Calendar and then run any newly queued Gemini
// preparation - both can take longer than the platform's short default.
export const maxDuration = 60;

export async function POST(request: Request) {
  const notification = parseGoogleCalendarWebhookHeaders(request.headers);
  if (!notification) return new Response(null, { status: 204 });

  const admin = createAdminClient();
  const tokenHash = hashCalendarChannelToken(notification.channelToken);

  const { data: channel, error } = await admin
    .from("calendar_watch_channels")
    .select("id,google_connection_id,resource_id,last_message_number,status")
    .eq("channel_id", notification.channelId)
    .eq("token_hash", tokenHash)
    .eq("status", "ACTIVE")
    .maybeSingle();

  if (error || !channel || channel.resource_id !== notification.resourceId) {
    return new Response(null, { status: 204 });
  }

  if (
    typeof channel.last_message_number === "number"
    && notification.messageNumber <= channel.last_message_number
  ) {
    return new Response(null, { status: 204 });
  }

  await admin
    .from("calendar_watch_channels")
    .update({ last_message_number: notification.messageNumber })
    .eq("id", channel.id);

  const dedupeKey = `gcal:${notification.channelId}:${notification.messageNumber}`;
  const jobId = await enqueueCalendarSyncJob({
    connectionId: channel.google_connection_id,
    dedupeKey,
    payload: {
      resource_state: notification.resourceState,
      channel_id: notification.channelId,
      message_number: notification.messageNumber,
    },
  });

  if (jobId) {
    let appOrigin: string | null = null;
    try {
      appOrigin = getAppOrigin(request.headers);
    } catch {
      appOrigin = null;
    }

    if (appOrigin) {
      const origin = appOrigin;
      after(async () => {
        const result = await processCalendarJob(jobId, origin);
        console.info("calendar_webhook_job_processed", {
          job_id: jobId,
          result,
        });

        if (result === "done") {
          try {
            const preparation = await runDuePreparationJobs(origin);
            console.info("calendar_webhook_preparation_jobs_processed", preparation);
          } catch (preparationError) {
            console.error("calendar_webhook_preparation_jobs_failed", {
              code: preparationError instanceof Error ? preparationError.message : "unknown",
            });
          }
        }
      });
    }
  }

  return new Response(null, { status: 204 });
}
